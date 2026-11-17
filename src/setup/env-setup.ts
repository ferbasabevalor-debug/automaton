/**
 * Non-interactive (environment-variable) setup
 *
 * Lets the automaton configure itself on hosted platforms such as Railway,
 * where nobody can answer the interactive wizard. Everything the wizard
 * asks for is read from environment variables instead.
 *
 * Messages printed here are meant for the operator reading the hosting
 * platform's logs, so they are written in plain Spanish.
 */

import fs from "fs";
import path from "path";
import type { AutomatonConfig, TreasuryPolicy } from "../types.js";
import { DEFAULT_TREASURY_POLICY } from "../types.js";
import { getWallet, getAutomatonDir, walletExists } from "../identity/wallet.js";
import { provision } from "../identity/provision.js";
import { createConfig, saveConfig } from "../config.js";
import { writeDefaultHeartbeatConfig } from "../heartbeat/config.js";
import { detectEnvironment } from "./environment.js";
import { generateSoulMd, installDefaultSkills } from "./defaults.js";
import { isValidAddress } from "../identity/chain.js";
import type { ChainType } from "../identity/chain.js";
import {
  getDailySpendCapCents,
  getDailyTopupCapCents,
  clampTreasuryToDailyCap,
} from "../agent/daily-spend-cap.js";

/** Read an env var, trimming whitespace; empty strings count as unset. */
export function readEnv(name: string): string | undefined {
  const v = process.env[name];
  if (v === undefined) return undefined;
  const t = v.trim();
  return t === "" ? undefined : t;
}

function isTruthy(v: string | undefined): boolean {
  return !!v && ["1", "true", "yes", "si", "sí"].includes(v.toLowerCase());
}

/** True when running on Railway. */
export function isRailway(): boolean {
  return !!(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_SERVICE_ID);
}

/**
 * Should first-run setup come from environment variables instead of the
 * interactive wizard? Yes when explicitly requested, when the setup
 * variables are present, or when there is no terminal to ask questions on.
 */
export function shouldUseEnvSetup(): boolean {
  if (isTruthy(readEnv("AUTOMATON_NONINTERACTIVE"))) return true;
  if (readEnv("AUTOMATON_GENESIS_PROMPT") || readEnv("AUTOMATON_CREATOR_ADDRESS")) return true;
  if (isRailway()) return true;
  return !process.stdin.isTTY;
}

function log(line = ""): void {
  // Plain console output so it always shows up in hosting logs, unformatted.
  console.log(line);
}

/** Block forever (without crash-looping) after printing an explanation. */
export async function haltWithMessage(lines: string[]): Promise<never> {
  log("");
  log("════════════════════════════════════════════════════════════");
  for (const l of lines) log(l);
  log("════════════════════════════════════════════════════════════");
  log("");
  // Keep the process alive so the message stays visible and the platform
  // does not restart it in a loop. Re-print the message every hour.
  while (true) {
    await new Promise((r) => setTimeout(r, 60 * 60 * 1000));
    for (const l of lines) log(l);
  }
}

/**
 * Is the automaton's data directory on persistent storage?
 *
 * On Railway the container disk is wiped on every deploy. If the wallet
 * lives there, a redeploy creates a NEW wallet and any funds sent to the
 * old one are lost forever. We therefore refuse to create a wallet on
 * Railway unless a volume is mounted over the data directory, the private
 * key is supplied via WALLET_PRIVATE_KEY, or the operator opts out.
 */
export async function ensurePersistentWalletStorage(): Promise<void> {
  if (!isRailway()) return;
  if (readEnv("WALLET_PRIVATE_KEY")) return;
  if (isTruthy(readEnv("AUTOMATON_ALLOW_EPHEMERAL_WALLET"))) return;

  const dataDir = getAutomatonDir();
  const mount = readEnv("RAILWAY_VOLUME_MOUNT_PATH");
  if (mount && (dataDir === mount || dataDir.startsWith(mount.replace(/\/+$/, "") + "/"))) {
    return;
  }

  if (walletExists() && !mount) {
    // A wallet exists but not on a volume: it will vanish on next deploy.
    log("⚠️  AVISO: la wallet está en un disco temporal. Añade un Volume en /data para no perderla.");
    return;
  }

  await haltWithMessage([
    "❌ FALTA UN VOLUMEN PERSISTENTE (Volume) EN RAILWAY",
    "",
    "El agente guarda su wallet (su clave privada) en disco. En Railway el disco",
    "se borra en cada despliegue, así que sin un volumen se crearía una wallet",
    "nueva cada vez y PERDERÍAS el dinero enviado a la anterior.",
    "",
    "Solución: en Railway, abre este servicio → clic derecho / menú → 'Attach Volume'",
    "(o 'New → Volume') y como 'Mount path' escribe exactamente:  /data",
    mount ? `Ahora mismo el volumen está montado en "${mount}", pero los datos van a "${dataDir}".` : "",
    "Railway redesplegará el servicio solo. Después mira de nuevo estos logs.",
  ].filter((l) => l !== undefined));
}

/** Variables that must be present for a non-interactive first run. */
export function findMissingSetupVars(): string[] {
  const missing: string[] = [];
  if (!readEnv("AUTOMATON_GENESIS_PROMPT")) missing.push("AUTOMATON_GENESIS_PROMPT");
  if (!readEnv("AUTOMATON_CREATOR_ADDRESS")) missing.push("AUTOMATON_CREATOR_ADDRESS");
  return missing;
}

function parseChain(): ChainType {
  return readEnv("AUTOMATON_CHAIN")?.toLowerCase() === "solana" ? "solana" : "evm";
}

/**
 * First-run setup driven entirely by environment variables.
 * Mirrors runSetupWizard() without asking any question.
 */
export async function runEnvSetup(): Promise<AutomatonConfig> {
  log("[setup] Primer arranque: configurando el agente desde variables de entorno (sin preguntas).");

  const missing = findMissingSetupVars();
  if (missing.length > 0) {
    await haltWithMessage([
      "❌ FALTAN VARIABLES DE ENTORNO OBLIGATORIAS",
      "",
      ...missing.map((m) => `   - ${m}`),
      "",
      "Añádelas en Railway → tu servicio → pestaña 'Variables' y el servicio se",
      "redesplegará solo. Consulta RAILWAY.md en el repositorio para ver qué poner.",
    ]);
  }

  await ensurePersistentWalletStorage();

  // 1. Wallet
  const selectedChain = parseChain();
  const { chainIdentity, chainType: walletChainType, isNew } = await getWallet(selectedChain);
  const walletAddress = chainIdentity.address;
  log(`[setup] Wallet ${isNew ? "creada" : "cargada"}: ${walletAddress} (${walletChainType === "solana" ? "Solana" : "EVM / Base"})`);

  // 2. Creator address (validated against the wallet's chain)
  const creatorAddress = readEnv("AUTOMATON_CREATOR_ADDRESS")!;
  if (!isValidAddress(creatorAddress, walletChainType)) {
    await haltWithMessage([
      "❌ AUTOMATON_CREATOR_ADDRESS NO ES VÁLIDA",
      "",
      walletChainType === "solana"
        ? "Debe ser una dirección de Solana (texto base58 de 32-44 caracteres)."
        : "Debe ser una dirección EVM: empieza por 0x y tiene 42 caracteres en total.",
      `Valor recibido: "${creatorAddress}"`,
      "Corrígela en Railway → Variables.",
    ]);
  }

  // 3. Conway API key: env var first, otherwise auto-provision via SIWE/SIWS
  let apiKey = readEnv("CONWAY_API_KEY") || "";
  if (apiKey) {
    log("[setup] Usando CONWAY_API_KEY de las variables de entorno.");
  } else {
    try {
      const result = await provision(
        readEnv("CONWAY_API_URL"),
        walletChainType === "solana" ? chainIdentity : undefined,
      );
      apiKey = result.apiKey;
      log(`[setup] Clave de Conway obtenida automáticamente con la wallet (${result.keyPrefix}...).`);
    } catch (err: any) {
      log(`[setup] ⚠️  No se pudo obtener la clave de Conway automáticamente: ${err.message}`);
      log("[setup]    Se reintentará en el próximo arranque. También puedes poner CONWAY_API_KEY a mano.");
    }
  }

  // 4. Treasury policy: defaults, all clamped to the daily cap
  const cap = getDailySpendCapCents();
  const treasuryPolicy: TreasuryPolicy = clampTreasuryToDailyCap({ ...DEFAULT_TREASURY_POLICY }, cap);

  // 5. Write config + supporting files
  const name = readEnv("AUTOMATON_NAME") || "automaton";
  const genesisPrompt = readEnv("AUTOMATON_GENESIS_PROMPT")!.replace(/\\n/g, "\n");
  const env = detectEnvironment();

  const config = createConfig({
    name,
    genesisPrompt,
    creatorAddress,
    registeredWithConway: !!apiKey,
    sandboxId: env.sandboxId,
    walletAddress,
    apiKey,
    openaiApiKey: readEnv("OPENAI_API_KEY"),
    anthropicApiKey: readEnv("ANTHROPIC_API_KEY"),
    ollamaBaseUrl: readEnv("OLLAMA_BASE_URL"),
    treasuryPolicy,
    chainType: walletChainType,
  });
  const model = readEnv("AUTOMATON_INFERENCE_MODEL");
  if (model) config.inferenceModel = model;

  saveConfig(config);
  writeDefaultHeartbeatConfig();

  const automatonDir = getAutomatonDir();
  const constitutionSrc = path.join(process.cwd(), "constitution.md");
  const constitutionDst = path.join(automatonDir, "constitution.md");
  if (fs.existsSync(constitutionSrc) && !fs.existsSync(constitutionDst)) {
    fs.copyFileSync(constitutionSrc, constitutionDst);
    fs.chmodSync(constitutionDst, 0o444);
  }

  const soulPath = path.join(automatonDir, "SOUL.md");
  if (!fs.existsSync(soulPath)) {
    fs.writeFileSync(soulPath, generateSoulMd(name, walletAddress, creatorAddress, genesisPrompt), { mode: 0o600 });
  }

  installDefaultSkills(config.skillsDir || "~/.automaton/skills");

  log(`[setup] Configuración guardada en ${automatonDir}. Nombre: ${name}.`);
  return config;
}

/**
 * Print, on every start, where and how to fund the agent.
 * Never prints any secret — only the public address.
 */
export function logFundingInstructions(address: string, chainType: ChainType): void {
  const cap = getDailySpendCapCents();
  const topupCap = getDailyTopupCapCents();
  const lines =
    chainType === "solana"
      ? [
          "💰 CÓMO FONDEAR (DAR DINERO A) TU AGENTE",
          "",
          `   Dirección de la wallet del agente:  ${address}`,
          "   Token:  USDC (el oficial de Circle)",
          "   Red:    Solana (mainnet)",
          "   Mint del USDC: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          "",
          "   Nota: en Solana el agente NO puede convertir USDC en créditos él solo.",
          "   Recarga créditos de Conway desde https://app.conway.tech",
        ]
      : [
          "💰 CÓMO FONDEAR (DAR DINERO A) TU AGENTE",
          "",
          `   Dirección de la wallet del agente:  ${address}`,
          "   Token:  USDC (el oficial de Circle, NO 'USDbC' ni otro)",
          "   Red:    Base (mainnet, chain ID 8453). NO Ethereum, NO Arbitrum, NO Polygon.",
          "   Contrato del USDC en Base: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          "",
          "   Mínimo útil: 5 USDC (el agente compra créditos en bloques de 5 $).",
          "   No hace falta ETH para que funcione lo básico.",
        ];
  log("");
  log("════════════════════════════════════════════════════════════");
  for (const l of lines) log(l);
  log("");
  log(`   Tope de gasto diario (MAX_DAILY_SPEND_USD): $${(cap / 100).toFixed(2)} al día`);
  log(`   Máximo de USDC que puede pasar a créditos al día: $${(topupCap / 100).toFixed(2)}`);
  log("════════════════════════════════════════════════════════════");
  log("");
}
