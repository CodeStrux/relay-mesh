/** Env-only configuration. Model IDs live exclusively in env (never in code paths). */
import { z } from "zod";
import { BUNDLED_PROFILES_PATH } from "./profiles.js";

export interface Config {
  apiKey: string;
  baseUrl: string;
  referer: string;
  title: string;
  relayRoot: string;
  profilesPath: string;
  monitorPollMs: number;
  maxFixRounds: number;
  debug: boolean;
  modelFor(envName: string): string;
}

/** The defaults from .env.example — kept byte-identical to that file. */
export const MODEL_DEFAULTS: Record<string, string> = {
  PLANNER_MODEL: "z-ai/glm-5.2",
  RECON_CODE_MODEL: "deepseek/deepseek-v4-pro",
  VISION_MODEL: "google/gemma-4-26b-a4b-it",
  BACKEND_MODEL: "z-ai/glm-5.2",
  FRONTEND_MODEL: "moonshotai/kimi-k2.7-code",
  INFRA_MODEL: "z-ai/glm-5.2",
  MONITOR_MODEL: "google/gemma-4-31b-it",
};

export class MissingEnvError extends Error {
  readonly missing: string[];
  constructor(missing: { name: string; hint: string }[]) {
    super(renderMissingTable(missing));
    this.name = "MissingEnvError";
    this.missing = missing.map((m) => m.name);
  }
}

function renderMissingTable(missing: { name: string; hint: string }[]): string {
  const width = Math.max("variable".length, ...missing.map((m) => m.name.length));
  const lines = [
    "missing required environment variables — add them to .env:",
    "",
    `  ${"variable".padEnd(width)}  how to fill it`,
    `  ${"-".repeat(width)}  ${"-".repeat(14)}`,
    ...missing.map((m) => `  ${m.name.padEnd(width)}  ${m.hint}`),
  ];
  return lines.join("\n");
}

const envSchema = z.object({
  OPENROUTER_API_KEY: z.string().default(""),
  OPENROUTER_BASE_URL: z.url().default("https://openrouter.ai/api/v1"),
  RELAY_HTTP_REFERER: z.string().default("https://github.com/CodeStrux/relay-mesh"),
  RELAY_X_TITLE: z.string().default("relay-mesh"),
  RELAY_ROOT: z.string().default("./relay"),
  RELAY_PROFILES: z.string().optional(),
  MONITOR_POLL_MS: z.coerce.number().int().positive().default(15000),
  MAX_FIX_ROUNDS: z.coerce.number().int().positive().default(3),
  RELAY_DEBUG: z.string().optional(),
});

/** Picks only the vars we own; empty strings count as unset so defaults apply. */
function readEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(envSchema.shape)) {
    const value = process.env[key];
    if (value !== undefined && value !== "") out[key] = value;
  }
  return out;
}

export function loadConfig(opts: { requireApiKey?: boolean } = {}): Config {
  const requireApiKey = opts.requireApiKey ?? true;

  try {
    process.loadEnvFile(".env");
  } catch {
    // No .env in cwd — fine; env may come from the shell.
  }

  const parsed = envSchema.safeParse(readEnv());
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`invalid environment — ${detail}`);
  }
  const env = parsed.data;

  if (requireApiKey && env.OPENROUTER_API_KEY === "") {
    throw new MissingEnvError([
      {
        name: "OPENROUTER_API_KEY",
        hint: "op read -n 'op://<vault>/<item>/api-key' (see .env.example)",
      },
    ]);
  }

  return {
    apiKey: env.OPENROUTER_API_KEY,
    baseUrl: env.OPENROUTER_BASE_URL,
    referer: env.RELAY_HTTP_REFERER,
    title: env.RELAY_X_TITLE,
    relayRoot: env.RELAY_ROOT,
    profilesPath: env.RELAY_PROFILES ?? BUNDLED_PROFILES_PATH,
    monitorPollMs: env.MONITOR_POLL_MS,
    maxFixRounds: env.MAX_FIX_ROUNDS,
    debug: env.RELAY_DEBUG === "1",
    modelFor(envName: string): string {
      const value = process.env[envName];
      if (value !== undefined && value !== "") return value;
      const fallback = MODEL_DEFAULTS[envName];
      if (fallback !== undefined) return fallback;
      throw new MissingEnvError([
        { name: envName, hint: "an OpenRouter model slug (referenced by profiles.json)" },
      ]);
    },
  };
}
