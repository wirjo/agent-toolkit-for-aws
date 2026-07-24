import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface X402Config {
  region: string;
  paymentManagerArn: string;
  paymentInstrumentId: string;
  userId: string;
  networkPreferences?: string[];
  payment_session_id?: string;
}

const CONFIG_DIR = join(homedir(), ".x402");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

let cachedConfig: X402Config | null = null;

/**
 * Load config from plugin config (passed in) or fallback to ~/.x402/config.json
 */
export async function loadConfig(pluginConfig?: Partial<X402Config>): Promise<X402Config> {
  if (cachedConfig) return cachedConfig;

  // Try plugin config first
  if (pluginConfig && pluginConfig.paymentManagerArn && pluginConfig.paymentInstrumentId && pluginConfig.userId) {
    cachedConfig = {
      region: pluginConfig.region ?? "us-east-1",
      paymentManagerArn: pluginConfig.paymentManagerArn,
      paymentInstrumentId: pluginConfig.paymentInstrumentId,
      userId: pluginConfig.userId,
      networkPreferences: pluginConfig.networkPreferences,
      payment_session_id: pluginConfig.payment_session_id,
    };

    // Try to load session ID from file if not in plugin config
    if (!cachedConfig.payment_session_id) {
      try {
        const fileConfig = JSON.parse(await readFile(CONFIG_PATH, "utf-8"));
        if (fileConfig.payment_session_id) {
          cachedConfig.payment_session_id = fileConfig.payment_session_id;
        }
      } catch {
        // File doesn't exist or is invalid — that's fine
      }
    }

    return cachedConfig;
  }

  // Fallback: load from ~/.x402/config.json
  try {
    const raw = await readFile(CONFIG_PATH, "utf-8");
    const fileConfig = JSON.parse(raw) as X402Config;
    cachedConfig = {
      region: fileConfig.region ?? "us-east-1",
      paymentManagerArn: fileConfig.paymentManagerArn,
      paymentInstrumentId: fileConfig.paymentInstrumentId,
      userId: fileConfig.userId,
      networkPreferences: fileConfig.networkPreferences,
      payment_session_id: fileConfig.payment_session_id,
    };
    return cachedConfig;
  } catch (err) {
    throw new Error(
      `x402 config not found. Provide config via OpenClaw plugin settings or create ~/.x402/config.json. Error: ${err}`
    );
  }
}

/**
 * Get the current config (must be loaded first)
 */
export function getConfig(): X402Config {
  if (!cachedConfig) {
    throw new Error("Config not loaded. Call loadConfig() first.");
  }
  return cachedConfig;
}

/**
 * Save the full config to ~/.x402/config.json (used after setup)
 */
export async function saveFullConfig(config: X402Config): Promise<void> {
  cachedConfig = config;
  try {
    await mkdir(CONFIG_DIR, { recursive: true });
    await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf-8");
  } catch (err) {
    console.error(`Warning: could not write config to ${CONFIG_PATH}: ${err}`);
  }
}

/**
 * Update the payment session ID in memory and persist to disk
 */
export async function setPaymentSessionId(sessionId: string): Promise<void> {
  if (!cachedConfig) {
    throw new Error("Config not loaded. Call loadConfig() first.");
  }

  cachedConfig.payment_session_id = sessionId;

  // Persist to ~/.x402/config.json
  try {
    await mkdir(CONFIG_DIR, { recursive: true });

    let fileConfig: Record<string, unknown> = {};
    try {
      fileConfig = JSON.parse(await readFile(CONFIG_PATH, "utf-8"));
    } catch {
      // File doesn't exist yet — start fresh
    }

    fileConfig.payment_session_id = sessionId;
    await writeFile(CONFIG_PATH, JSON.stringify(fileConfig, null, 2) + "\n", "utf-8");
  } catch (err) {
    // Non-fatal: we still have it in memory
    console.error(`Warning: could not persist session ID to ${CONFIG_PATH}: ${err}`);
  }
}
