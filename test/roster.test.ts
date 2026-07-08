import { describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import type { Profile } from "../src/profiles.js";
import { extractDomainBriefs } from "../src/relay/briefs.js";
import {
  defaultRoster,
  expandRoster,
  knownSlots,
  lintRoster,
  parseRoster,
  rosterSha256,
  serializeRoster,
  shardInstruction,
  type Roster,
} from "../src/relay/roster.js";

const EXECUTORS: Profile[] = [
  { name: "exec-backend", role: "executor", domain: "backend", area: "backend", modelEnv: "BACKEND_MODEL", effort: "xhigh", prompt: "prompts/executor-backend.md", multimodal: false },
  { name: "exec-frontend", role: "executor", domain: "frontend", area: "frontend", modelEnv: "FRONTEND_MODEL", effort: "high", prompt: "prompts/executor-frontend.md", multimodal: false },
];

const PLAN = [
  "# Plan",
  "",
  "## Domain brief: backend",
  "",
  "1. Build the API.",
  "",
  "## Domain brief: frontend",
  "",
  "1. Build the UI.",
  "",
].join("\n");

const PLAN_WITH_DOCS = `${PLAN}\n## Domain brief: docs\n\n1. Write the README.\n`;

// Mirrors config.modelFor: resolves known slots, throws otherwise.
const fakeConfig = {
  modelFor(name: string): string {
    if (["BACKEND_MODEL", "FRONTEND_MODEL", "PLANNER_MODEL"].includes(name)) return `model/${name}`;
    throw new Error(`no model for ${name}`);
  },
} as unknown as Config;

function roster(execute: Roster["execute"]): Roster {
  return { version: 1, execute };
}

describe("roster: schema & sha", () => {
  it("parses a valid roster and defaults count to 1", () => {
    const r = parseRoster(
      JSON.stringify({ version: 1, execute: [{ domain: "backend", template: "exec-backend", modelEnv: "BACKEND_MODEL", effort: "xhigh" }] }),
    );
    expect(r.execute[0]!.count).toBe(1);
  });

  it("rejects an inline `model` key (strictObject) and stray keys", () => {
    expect(() =>
      parseRoster(JSON.stringify({ version: 1, execute: [{ domain: "backend", template: "exec-backend", modelEnv: "BACKEND_MODEL", effort: "xhigh", model: "z-ai/glm-5.2" }] })),
    ).toThrow(/invalid/);
  });

  it("rejects invalid JSON and an empty execute list", () => {
    expect(() => parseRoster("{not json")).toThrow(/not valid JSON/);
    expect(() => parseRoster(JSON.stringify({ version: 1, execute: [] }))).toThrow(/invalid/);
  });

  it("serializeRoster is byte-stable and rosterSha256 hashes the exact bytes", () => {
    const raw = serializeRoster(defaultRoster(PLAN, EXECUTORS));
    expect(raw.endsWith("\n")).toBe(true);
    expect(rosterSha256(raw)).toBe(rosterSha256(serializeRoster(parseRoster(raw))));
  });
});

describe("roster: defaultRoster (no-advisor fallback)", () => {
  it("emits one count-1 entry per domain brief, templated by matching executor", () => {
    const r = defaultRoster(PLAN, EXECUTORS);
    expect(r.execute).toEqual([
      { domain: "backend", template: "exec-backend", count: 1, modelEnv: "BACKEND_MODEL", effort: "xhigh" },
      { domain: "frontend", template: "exec-frontend", count: 1, modelEnv: "FRONTEND_MODEL", effort: "high" },
    ]);
  });

  it("passes its own lint (the fallback path must always be approvable)", () => {
    expect(lintRoster(PLAN, defaultRoster(PLAN, EXECUTORS), EXECUTORS, fakeConfig)).toEqual([]);
  });
});

describe("roster: expandRoster", () => {
  it("count 1 → one un-suffixed pair with the verbatim brief and no shard text", () => {
    const briefs = extractDomainBriefs(PLAN);
    const workers = expandRoster(PLAN, defaultRoster(PLAN, EXECUTORS), EXECUTORS);
    expect(workers).toHaveLength(2);
    const backend = workers[0]!;
    expect(backend.pairName).toBe("planner__backend");
    expect(backend.area).toBe("backend");
    expect(backend.profile.name).toBe("backend");
    expect(backend.profile.prompt).toBe("prompts/executor-backend.md"); // persona from template
    expect(backend.briefBody).toBe(briefs.get("backend"));
  });

  it("count>1 → sharded pairs with a deterministic shard instruction", () => {
    const workers = expandRoster(PLAN, roster([{ domain: "backend", template: "exec-backend", count: 3, modelEnv: "BACKEND_MODEL", effort: "xhigh" }]), EXECUTORS);
    expect(workers.map((w) => w.pairName)).toEqual(["planner__backend__w1", "planner__backend__w2", "planner__backend__w3"]);
    expect(workers.every((w) => w.shardCount === 3)).toBe(true);
    expect(workers[1]!.briefBody).toContain("## Shard 2 of 3");
    expect(workers[0]!.briefBody).toContain(extractDomainBriefs(PLAN).get("backend")!);
  });

  it("mints a NEW domain from a template (area/domain follow the brief; persona from template)", () => {
    const workers = expandRoster(PLAN_WITH_DOCS, roster([{ domain: "docs", template: "exec-frontend", count: 1, modelEnv: "FRONTEND_MODEL", effort: "high" }]), EXECUTORS);
    expect(workers[0]!.area).toBe("docs");
    expect(workers[0]!.profile.domain).toBe("docs");
    expect(workers[0]!.profile.prompt).toBe("prompts/executor-frontend.md");
  });

  it("throws on a missing brief, unknown slot, or reserved domain (defence-in-depth)", () => {
    expect(() => expandRoster(PLAN, roster([{ domain: "mobile", template: "exec-backend", count: 1, modelEnv: "BACKEND_MODEL", effort: "xhigh" }]), EXECUTORS)).toThrow(/no "## Domain brief/);
    expect(() => expandRoster(PLAN, roster([{ domain: "backend", template: "exec-backend", count: 1, modelEnv: "NOPE", effort: "xhigh" }]), EXECUTORS)).toThrow(/not a known model slot/);
    expect(() => expandRoster(`## Domain brief: w2\n\n1. x\n`, roster([{ domain: "w2", template: "exec-backend", count: 1, modelEnv: "BACKEND_MODEL", effort: "xhigh" }]), EXECUTORS)).toThrow(/reserved/);
  });
});

describe("roster: knownSlots & lintRoster (models-lock)", () => {
  it("knownSlots includes MODEL_DEFAULTS keys and every profile modelEnv", () => {
    const slots = knownSlots(EXECUTORS);
    expect(slots.has("BACKEND_MODEL")).toBe(true);
    expect(slots.has("PLANNER_MODEL")).toBe(true); // a MODEL_DEFAULTS key
  });

  it("flags missing brief, unknown template, inline id, unknown slot, reserved & duplicate domains", () => {
    const bad = roster([
      { domain: "backend", template: "not-a-profile", count: 1, modelEnv: "z-ai/glm-5.2", effort: "xhigh" },
      { domain: "backend", template: "exec-backend", count: 1, modelEnv: "NOPE", effort: "xhigh" },
      { domain: "mobile", template: "exec-backend", count: 1, modelEnv: "BACKEND_MODEL", effort: "xhigh" },
    ]);
    const problems = lintRoster(PLAN, bad, EXECUTORS, fakeConfig).join(" | ");
    expect(problems).toContain("is not an executor profile");
    expect(problems).toContain("inline model id");
    expect(problems).toContain("not a known model slot");
    expect(problems).toContain('duplicate roster domain "backend"');
    expect(problems).toContain('roster domain "mobile" has no "## Domain brief: mobile"');
  });
});

describe("roster: shardInstruction", () => {
  it("is empty for a single worker and describes the partition otherwise", () => {
    expect(shardInstruction(1, 1)).toBe("");
    expect(shardInstruction(2, 3)).toContain("Shard 2 of 3");
  });
});
