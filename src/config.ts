/**
 * Automaton Configuration
 *
 * Loads and saves the automaton's configuration from ~/.automaton/automaton.json
 */

import fs from "fs";
import path from "path";
import type { AutomatonConfig, TreasuryPolicy, ModelStrategyConfig, SoulConfig } from "./types.js";
import { DEFAULT_CONFIG, DEFAULT_TREASURY_POLICY, DEFAULT_MODEL_STRATEGY_CONFIG, DEFAULT_SOUL_CONFIG } from "./types.js";
import { getAutomatonDir } from "./identity/wallet.js";
import { loadApiKeyFromConfig } from "./identity/provision.js";
import { createLogger } from "./observability/logger.js";
import type { ChainType } from "./identity/chain.js";
import { getDailySpendCapCents, clampTreasuryToDailyCap } from "./agent/daily-spend-cap.js";

const logger = createLogger("config");
const CONFIG_FILENAME = "automaton.json";

export function getConfigPath(): string {
  return path.join(getAutomatonDir(), CONFIG_FILENAME);
}

/**
 * Load the automaton config from disk.
 * Merges with defaults for any missing fields.
 */
export function loadConfig(): AutomatonConfig | null {
  const configPath = getConfigPath();
  if (!fs.existsSync(configPath)) {
    return null;
  }

  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    const apiKey = raw.conwayApiKey || loadApiKeyFromConfig();

    // Deep-merge treasury policy with defaults
    const treasuryPolicy: TreasuryPolicy = {
      ...DEFAULT_TREASURY_POLICY,
      ...(raw.treasuryPolicy ?? {}),
    };

    // Validate all treasury values are positive numbers
    for (const [key, value] of Object.entries(treasuryPolicy)) {
      if (key === "x402AllowedDomains") continue; // array, not number
      if (typeof value === "number" && (value < 0 || !Number.isFinite(value))) {
        logger.warn(`Invalid treasury value for ${key}: ${value}, using default`);
        (treasuryPolicy as any)[key] = (DEFAULT_TREASURY_POLICY as any)[key];
      }
    }

    // Deep-merge model strategy config with defaults
    const modelStrategy: ModelStrategyConfig = {
      ...DEFAULT_MODEL_STRATEGY_CONFIG,
      ...(raw.modelStrategy ?? {}),
    };

    // Deep-merge soul config with defaults
    const soulConfig: SoulConfig = {
      ...DEFAULT_SOUL_CONFIG,
      ...(raw.soulConfig ?? {}),
    };

    // Hosted deploys: secrets and limits can come from environment variables,
    // which always win over what is stored on disk.
    const envOverrides = getEnvConfigOverrides();

    return {
      ...DEFAULT_CONFIG,
      ...raw,
      ...envOverrides,
      sandboxId:
        typeof raw.sandboxId === "string"
          ? raw.sandboxId.trim()
          : DEFAULT_CONFIG.sandboxId,
      conwayApiKey: envOverrides.conwayApiKey || apiKey,
      treasuryPolicy: clampToDailyCap(treasuryPolicy),
      modelStrategy,
      soulConfig,
      chainType: raw.chainType || "evm",
    } as AutomatonConfig;
  } catch {
    return null;
  }
}

/**
 * Save the automaton config to disk.
 * Includes treasuryPolicy in the persisted config.
 */
export function saveConfig(config: AutomatonConfig): void {
  const dir = getAutomatonDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const configPath = getConfigPath();
  const toSave: Record<string, unknown> = {
    ...config,
    treasuryPolicy: config.treasuryPolicy ?? DEFAULT_TREASURY_POLICY,
    modelStrategy: config.modelStrategy ?? DEFAULT_MODEL_STRATEGY_CONFIG,
    soulConfig: config.soulConfig ?? DEFAULT_SOUL_CONFIG,
  };
  // Never copy secrets that were provided via environment variables to disk:
  // they stay only in the hosting platform's secret store.
  for (const [field, envName] of Object.entries(SECRET_ENV_VARS)) {
    if (process.env[envName]?.trim()) delete toSave[field];
  }
  fs.writeFileSync(configPath, JSON.stringify(toSave, null, 2), {
    mode: 0o600,
  });
}

/** Config fields that hold secrets, mapped to the env var that can supply them. */
const SECRET_ENV_VARS: Record<string, string> = {
  conwayApiKey: "CONWAY_API_KEY",
  openaiApiKey: "OPENAI_API_KEY",
  anthropicApiKey: "ANTHROPIC_API_KEY",
};

function envValue(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v ? v : undefined;
}

/**
 * Config values supplied through environment variables (hosted deploys).
 * Only keys that are actually set are returned.
 */
export function getEnvConfigOverrides(): Partial<AutomatonConfig> {
  const out: Partial<AutomatonConfig> = {};
  const conway = envValue("CONWAY_API_KEY");
  if (conway) out.conwayApiKey = conway;
  const openai = envValue("OPENAI_API_KEY");
  if (openai) out.openaiApiKey = openai;
  const anthropic = envValue("ANTHROPIC_API_KEY");
  if (anthropic) out.anthropicApiKey = anthropic;
  const ollama = envValue("OLLAMA_BASE_URL");
  if (ollama) out.ollamaBaseUrl = ollama;
  const apiUrl = envValue("CONWAY_API_URL");
  if (apiUrl) out.conwayApiUrl = apiUrl;
  const model = envValue("AUTOMATON_INFERENCE_MODEL");
  if (model) out.inferenceModel = model;
  return out;
}

/** Lower every spending limit so none exceeds MAX_DAILY_SPEND_USD. */
function clampToDailyCap(policy: TreasuryPolicy): TreasuryPolicy {
  return clampTreasuryToDailyCap(policy, getDailySpendCapCents());
}

/**
 * Resolve ~ paths to absolute paths.
 */
export function resolvePath(p: string): string {
  if (p.startsWith("~")) {
    return path.join(process.env.HOME || "/root", p.slice(1));
  }
  return p;
}

/**
 * Create a fresh config from setup wizard inputs.
 */
export function createConfig(params: {
  name: string;
  genesisPrompt: string;
  creatorMessage?: string;
  creatorAddress: string;
  registeredWithConway: boolean;
  sandboxId: string;
  walletAddress: string;
  apiKey: string;
  openaiApiKey?: string;
  anthropicApiKey?: string;
  ollamaBaseUrl?: string;
  parentAddress?: string;
  treasuryPolicy?: TreasuryPolicy;
  chainType?: ChainType;
}): AutomatonConfig {
  const normalizedSandboxId = (params.sandboxId || "").trim();
  return {
    name: params.name,
    genesisPrompt: params.genesisPrompt,
    creatorMessage: params.creatorMessage,
    creatorAddress: params.creatorAddress,
    registeredWithConway: params.registeredWithConway,
    sandboxId: normalizedSandboxId,
    conwayApiUrl:
      DEFAULT_CONFIG.conwayApiUrl || "https://api.conway.tech",
    conwayApiKey: params.apiKey,
    openaiApiKey: params.openaiApiKey,
    anthropicApiKey: params.anthropicApiKey,
    ollamaBaseUrl: params.ollamaBaseUrl,
    inferenceModel: DEFAULT_CONFIG.inferenceModel || "gpt-5.2",
    maxTokensPerTurn: DEFAULT_CONFIG.maxTokensPerTurn || 4096,
    heartbeatConfigPath:
      DEFAULT_CONFIG.heartbeatConfigPath || "~/.automaton/heartbeat.yml",
    dbPath: DEFAULT_CONFIG.dbPath || "~/.automaton/state.db",
    logLevel: (DEFAULT_CONFIG.logLevel as AutomatonConfig["logLevel"]) || "info",
    walletAddress: params.walletAddress,
    version: DEFAULT_CONFIG.version || "0.2.1",
    skillsDir: DEFAULT_CONFIG.skillsDir || "~/.automaton/skills",
    maxChildren: DEFAULT_CONFIG.maxChildren || 3,
    parentAddress: params.parentAddress,
    treasuryPolicy: params.treasuryPolicy ?? DEFAULT_TREASURY_POLICY,
    chainType: params.chainType || "evm",
  };
}
