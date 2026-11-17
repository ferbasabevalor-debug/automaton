/**
 * SIWE provisioning must never re-send a signed message with an already
 * used (single-use) nonce. Regression test for repeated
 * "Invalid or expired nonce" failures when Conway is slow or overloaded.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

function fakeConway(opts: { failFirstVerifyWith?: number }) {
  let nonceCounter = 0;
  const issued = new Set<string>();
  const used = new Set<string>();
  const verifyNonces: string[] = [];
  let verifyCalls = 0;

  const fetchMock = vi.fn(async (input: any, init?: any) => {
    const url = String(input);
    if (url.endsWith("/v1/auth/nonce")) {
      const nonce = `nonce${++nonceCounter}abcdef`;
      issued.add(nonce);
      return new Response(JSON.stringify({ nonce }), { status: 200 });
    }
    if (url.endsWith("/v1/auth/verify")) {
      verifyCalls++;
      const { message } = JSON.parse(init.body);
      const nonce = /Nonce: (\S+)/.exec(message)![1];
      verifyNonces.push(nonce);
      if (!issued.has(nonce) || used.has(nonce)) {
        return new Response(JSON.stringify({ error: "Invalid or expired nonce" }), { status: 401 });
      }
      used.add(nonce); // consumed even if the response below fails
      if (verifyCalls === 1 && opts.failFirstVerifyWith) {
        return new Response("Bad Gateway", { status: opts.failFirstVerifyWith });
      }
      return new Response(JSON.stringify({ access_token: "jwt" }), { status: 200 });
    }
    if (url.endsWith("/v1/auth/api-keys")) {
      return new Response(JSON.stringify({ key: "cnwy_k_testkey", key_prefix: "cnwy_k_te" }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  });

  return { fetchMock, verifyNonces };
}

async function loadProvision() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "provision-test-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("WALLET_PRIVATE_KEY", "");
  vi.resetModules();
  return import("../identity/provision.js");
}

describe("provision (SIWE nonce handling)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("gets a fresh nonce instead of re-sending a consumed one after a 502", async () => {
    const { fetchMock, verifyNonces } = fakeConway({ failFirstVerifyWith: 502 });
    vi.stubGlobal("fetch", fetchMock);
    const { provision } = await loadProvision();

    const result = await provision("https://api.conway.tech");

    expect(result.apiKey).toBe("cnwy_k_testkey");
    expect(verifyNonces).toHaveLength(2);
    expect(new Set(verifyNonces).size).toBe(2); // never the same nonce twice
  }, 30_000);

  it("works on the first try when the server is healthy", async () => {
    const { fetchMock, verifyNonces } = fakeConway({});
    vi.stubGlobal("fetch", fetchMock);
    const { provision } = await loadProvision();

    const result = await provision("https://api.conway.tech");
    expect(result.apiKey).toBe("cnwy_k_testkey");
    expect(verifyNonces).toHaveLength(1);
  });
});
