import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, MissingEnvError, MODEL_DEFAULTS } from "../src/config.js";

const ENV_KEYS = [
  "OPENROUTER_API_KEY",
  "OPENROUTER_BASE_URL",
  "RELAY_HTTP_REFERER",
  "RELAY_X_TITLE",
  "RELAY_ROOT",
  "RELAY_PROFILES",
  "MONITOR_POLL_MS",
  "MAX_FIX_ROUNDS",
  "RELAY_DEBUG",
  "PLANNER_MODEL",
  "SOME_NEW_MODEL",
];

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  // Empty string (not deletion) so a developer's real .env can never leak in:
  // loadEnvFile does not override vars already present in the environment.
  process.env.OPENROUTER_API_KEY = "test-key";
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("MODEL_DEFAULTS", () => {
  it("matches .env.example exactly", () => {
    expect(MODEL_DEFAULTS).toEqual({
      PLANNER_MODEL: "z-ai/glm-5.2",
      RECON_CODE_MODEL: "deepseek/deepseek-v4-pro",
      VISION_MODEL: "google/gemma-4-26b-a4b-it",
      BACKEND_MODEL: "z-ai/glm-5.2",
      FRONTEND_MODEL: "moonshotai/kimi-k2.7-code",
      INFRA_MODEL: "z-ai/glm-5.2",
      MONITOR_MODEL: "google/gemma-4-31b-it",
    });
  });
});

describe("loadConfig", () => {
  it("applies documented defaults", () => {
    const cfg = loadConfig();
    expect(cfg.apiKey).toBe("test-key");
    expect(cfg.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(cfg.referer).toBe("https://github.com/CodeStrux/relay-mesh");
    expect(cfg.title).toBe("relay-mesh");
    expect(cfg.relayRoot).toBe("./relay");
    expect(cfg.profilesPath.endsWith("profiles.json")).toBe(true);
    expect(cfg.monitorPollMs).toBe(15000);
    expect(cfg.maxFixRounds).toBe(3);
    expect(cfg.debug).toBe(false);
  });

  it("honors env overrides", () => {
    process.env.OPENROUTER_BASE_URL = "https://example.test/v1";
    process.env.RELAY_ROOT = "/tmp/relay-root";
    process.env.RELAY_PROFILES = "./custom-profiles.json";
    process.env.MONITOR_POLL_MS = "5000";
    process.env.MAX_FIX_ROUNDS = "7";
    process.env.RELAY_DEBUG = "1";
    const cfg = loadConfig();
    expect(cfg.baseUrl).toBe("https://example.test/v1");
    expect(cfg.relayRoot).toBe("/tmp/relay-root");
    expect(cfg.profilesPath).toBe("./custom-profiles.json");
    expect(cfg.monitorPollMs).toBe(5000);
    expect(cfg.maxFixRounds).toBe(7);
    expect(cfg.debug).toBe(true);
  });

  it("treats RELAY_DEBUG other than 1 as off", () => {
    process.env.RELAY_DEBUG = "0";
    expect(loadConfig().debug).toBe(false);
  });

  it("rejects a non-numeric MONITOR_POLL_MS", () => {
    process.env.MONITOR_POLL_MS = "soon";
    expect(() => loadConfig()).toThrow(/MONITOR_POLL_MS/);
  });

  it("throws MissingEnvError with a friendly table when the key is required and absent", () => {
    process.env.OPENROUTER_API_KEY = "";
    let caught: unknown;
    try {
      loadConfig();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MissingEnvError);
    const message = (caught as Error).message;
    expect(message).toContain("OPENROUTER_API_KEY");
    expect(message).toContain("variable");
    expect(message).toContain("how to fill it");
  });

  it("works keyless with requireApiKey: false (status/watch/close/costs)", () => {
    process.env.OPENROUTER_API_KEY = "";
    const cfg = loadConfig({ requireApiKey: false });
    expect(cfg.apiKey).toBe("");
    expect(cfg.relayRoot).toBe("./relay");
  });
});

describe("modelFor", () => {
  it("prefers the env value over the default", () => {
    process.env.PLANNER_MODEL = "custom/model-x";
    expect(loadConfig().modelFor("PLANNER_MODEL")).toBe("custom/model-x");
  });

  it("falls back to MODEL_DEFAULTS when unset", () => {
    expect(loadConfig().modelFor("PLANNER_MODEL")).toBe("z-ai/glm-5.2");
    expect(loadConfig().modelFor("FRONTEND_MODEL")).toBe("moonshotai/kimi-k2.7-code");
  });

  it("treats an empty env value as unset", () => {
    process.env.PLANNER_MODEL = "";
    expect(loadConfig().modelFor("PLANNER_MODEL")).toBe("z-ai/glm-5.2");
  });

  it("throws MissingEnvError naming the var when there is no default", () => {
    const cfg = loadConfig();
    expect(() => cfg.modelFor("SOME_NEW_MODEL")).toThrow(MissingEnvError);
    expect(() => cfg.modelFor("SOME_NEW_MODEL")).toThrow(/SOME_NEW_MODEL/);
  });
});
