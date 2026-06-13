import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface AppConfig {
  meshyApiKey: string;
}

// config/local.json lives at the repo root; this file is <root>/src/config.ts.
const CONFIG_PATH = fileURLToPath(new URL("../config/local.json", import.meta.url));

function requireNonEmptyString(value: unknown, key: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`config/local.json: "${key}" must be a non-empty string`);
  }
  return value;
}

// Loads the gitignored config/local.json. Fails loudly (throws) when the file is
// missing or a required key is empty — no silent defaults.
export function loadConfig(): AppConfig {
  let raw: string;
  try {
    raw = readFileSync(CONFIG_PATH, "utf8");
  } catch (cause) {
    throw new Error(
      `config/local.json not found at ${CONFIG_PATH} — copy config/local.example.json and fill in your keys`,
      { cause },
    );
  }
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  return {
    meshyApiKey: requireNonEmptyString(parsed.meshyApiKey, "meshyApiKey"),
  };
}
