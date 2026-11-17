/**
 * Automaton SIWE Provisioning
 *
 * Uses the automaton's wallet to authenticate via Sign-In With Ethereum (SIWE)
 * and create an API key for Conway API access.
 * Adapted from conway-mcp/src/cli/provision.ts
 */

import fs from "fs";
import path from "path";
import { SiweMessage } from "siwe";
import { getWallet, getAutomatonDir } from "./wallet.js";
import type { ProvisionResult } from "../types.js";
import { ResilientHttpClient } from "../conway/http-client.js";
import type { ChainIdentity } from "./chain.js";
import { buildSiwsMessage, signSiwsMessage } from "./siws.js";

const httpClient = new ResilientHttpClient();

const DEFAULT_API_URL = "https://api.conway.tech";

/**
 * Load API key from ~/.automaton/config.json if it exists.
 */
export function loadApiKeyFromConfig(): string | null {
  const configPath = path.join(getAutomatonDir(), "config.json");
  if (!fs.existsSync(configPath)) return null;
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    return config.apiKey || null;
  } catch {
    return null;
  }
}

/**
 * Save API key and wallet address to ~/.automaton/config.json
 */
function saveConfig(apiKey: string, walletAddress: string): void {
  const dir = getAutomatonDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const configPath = path.join(dir, "config.json");
  const config = {
    apiKey,
    walletAddress,
    provisionedAt: new Date().toISOString(),
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), {
    mode: 0o600,
  });
}

/** Max full provisioning attempts, each with a fresh nonce. */
const PROVISION_ATTEMPTS = 3;
/** Generous timeouts: Conway can be slow under load. */
const AUTH_TIMEOUT_MS = 90_000;

/** Error from one provisioning attempt, flagged if a fresh attempt may succeed. */
class ProvisionAttemptError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = "ProvisionAttemptError";
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * Provision a Conway API key, retrying the WHOLE flow (new nonce, new
 * signature) when an attempt fails for a transient reason.
 *
 * The verify step is never retried on its own: the nonce is single-use, so
 * re-sending the same signed message after a timeout or 5xx (when the server
 * may already have consumed the nonce) always fails with
 * "Invalid or expired nonce".
 */
export async function provision(
  apiUrl?: string,
  solanaIdentity?: ChainIdentity,
): Promise<ProvisionResult> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= PROVISION_ATTEMPTS; attempt++) {
    try {
      return await provisionOnce(apiUrl, solanaIdentity);
    } catch (err) {
      lastError = err;
      const retryable =
        err instanceof ProvisionAttemptError ? err.retryable : true; // network errors / timeouts
      if (!retryable || attempt === PROVISION_ATTEMPTS) break;
      await new Promise((r) => setTimeout(r, 5_000 * attempt));
    }
  }
  throw lastError;
}

/**
 * Run the full SIWE provisioning flow once:
 * 1. Load wallet
 * 2. Get nonce from Conway API
 * 3. Sign SIWE message
 * 4. Verify signature -> get JWT
 * 5. Create API key
 * 6. Save to config.json
 */
async function provisionOnce(
  apiUrl?: string,
  solanaIdentity?: ChainIdentity,
): Promise<ProvisionResult> {
  const url = apiUrl || process.env.CONWAY_API_URL || DEFAULT_API_URL;

  // 1. Load wallet
  const { account, chainIdentity, chainType } = await getWallet();
  const identity = solanaIdentity || chainIdentity;
  const address = identity.address;
  const isSolana = identity.chainType === "solana";

  // 2. Get nonce
  // A fresh nonce on every attempt; no inner retries, so we never sign a
  // nonce that a retried request has already superseded.
  const nonceResp = await httpClient.request(`${url}/v1/auth/nonce`, {
    method: "POST",
    retries: 0,
    timeout: AUTH_TIMEOUT_MS,
  });
  if (!nonceResp.ok) {
    throw new ProvisionAttemptError(
      `Failed to get nonce: ${nonceResp.status} ${await nonceResp.text()}`,
      isRetryableStatus(nonceResp.status),
    );
  }
  const { nonce } = (await nonceResp.json()) as { nonce: string };

  let messageString: string;
  let signature: string;

  if (isSolana) {
    // 3a. SIWS path: Sign-In With Solana
    const siwsMsg = buildSiwsMessage({
      domain: "conway.tech",
      address,
      statement: "Sign in to Conway as an Automaton to provision an API key.",
      uri: `${url}/v1/auth/verify`,
      nonce,
      issuedAt: new Date().toISOString(),
      chainId: "mainnet",
    });
    messageString = siwsMsg;
    signature = await signSiwsMessage(siwsMsg, identity);
  } else {
    // 3b. SIWE path: Sign-In With Ethereum (unchanged)
    const siweMessage = new SiweMessage({
      domain: "conway.tech",
      address,
      statement:
        "Sign in to Conway as an Automaton to provision an API key.",
      uri: `${url}/v1/auth/verify`,
      version: "1",
      chainId: 8453, // Base
      nonce,
      issuedAt: new Date().toISOString(),
    });
    messageString = siweMessage.prepareMessage();
    signature = await account.signMessage({ message: messageString });
  }

  // 4. Verify signature -> get JWT
  const verifyBody: Record<string, string> = { message: messageString, signature };
  if (isSolana) {
    verifyBody.chain_type = "solana";
  }

  // Single-use nonce: never retry this request with the same message.
  const verifyResp = await httpClient.request(`${url}/v1/auth/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(verifyBody),
    retries: 0,
    timeout: AUTH_TIMEOUT_MS,
  });

  if (!verifyResp.ok) {
    const protocol = isSolana ? "SIWS" : "SIWE";
    const text = await verifyResp.text();
    throw new ProvisionAttemptError(
      `${protocol} verification failed: ${verifyResp.status} ${text}`,
      isRetryableStatus(verifyResp.status) || /nonce/i.test(text),
    );
  }

  const { access_token } = (await verifyResp.json()) as {
    access_token: string;
  };

  // 5. Create API key
  const keyResp = await httpClient.request(`${url}/v1/auth/api-keys`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${access_token}`,
    },
    body: JSON.stringify({ name: "conway-automaton" }),
    // Not retried: a retry after a timeout could create a duplicate key.
    retries: 0,
    timeout: AUTH_TIMEOUT_MS,
  });

  if (!keyResp.ok) {
    throw new ProvisionAttemptError(
      `Failed to create API key: ${keyResp.status} ${await keyResp.text()}`,
      isRetryableStatus(keyResp.status),
    );
  }

  const { key, key_prefix } = (await keyResp.json()) as {
    key: string;
    key_prefix: string;
  };

  // 6. Save to config
  saveConfig(key, address);

  return { apiKey: key, walletAddress: address, keyPrefix: key_prefix };
}

/**
 * Register the automaton's creator as its parent with Conway.
 * This allows the creator to see automaton logs and inference calls.
 */
export async function registerParent(
  creatorAddress: string,
  apiUrl?: string,
): Promise<void> {
  const url = apiUrl || process.env.CONWAY_API_URL || DEFAULT_API_URL;
  const apiKey = loadApiKeyFromConfig();
  if (!apiKey) {
    throw new Error("Must provision API key before registering parent");
  }

  const resp = await httpClient.request(`${url}/v1/automaton/register-parent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: apiKey,
    },
    body: JSON.stringify({ creatorAddress }),
  });

  // Endpoint may not exist yet -- fail gracefully
  if (!resp.ok && resp.status !== 404) {
    throw new Error(
      `Failed to register parent: ${resp.status} ${await resp.text()}`,
    );
  }
}
