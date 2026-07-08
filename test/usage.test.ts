import { appendFile, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { Profile } from "../src/profiles.js";
import { aggregate, makeResolver, readUsage, recordUsage, rollupStage, type UsageLine } from "../src/usage.js";

function line(overrides: Partial<UsageLine> = {}): UsageLine {
  return {
    ts: "2026-07-06T12:00:00Z",
    round: "r001",
    profile: "exec-backend",
    model: "z-ai/glm-5.2",
    in: 100,
    out: 50,
    ...overrides,
  };
}

let dir: string;
let usagePath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "relay-mesh-usage-"));
  usagePath = join(dir, "nested", "usage.ndjson");
});

describe("recordUsage / readUsage", () => {
  it("creates parent dirs and appends one ndjson line per call", async () => {
    await recordUsage(usagePath, line());
    await recordUsage(usagePath, line({ profile: "monitor", in: 7, out: 3 }));
    const raw = await readFile(usagePath, "utf8");
    const rows = raw.trimEnd().split("\n");
    expect(rows).toHaveLength(2);
    expect(JSON.parse(rows[0]!)).toEqual(line());
  });

  it("round-trips through readUsage", async () => {
    const a = line();
    const b = line({ round: "r002", model: "moonshotai/kimi-k2.7-code", in: 9, out: 1 });
    await recordUsage(usagePath, a);
    await recordUsage(usagePath, b);
    expect(await readUsage(usagePath)).toEqual([a, b]);
  });

  it("returns [] for a missing file", async () => {
    expect(await readUsage(join(dir, "nope.ndjson"))).toEqual([]);
  });

  it("skips a torn trailing line instead of crashing", async () => {
    await recordUsage(usagePath, line());
    await appendFile(usagePath, '{"ts":"2026-07-06T12:01:00Z","round":"r0', "utf8");
    const lines = await readUsage(usagePath);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual(line());
  });
});

describe("aggregate", () => {
  const lines: UsageLine[] = [
    line({ profile: "planner", round: "r001", model: "z-ai/glm-5.2", in: 10, out: 5 }),
    line({ profile: "exec-backend", round: "r001", model: "z-ai/glm-5.2", in: 20, out: 8 }),
    line({ profile: "planner", round: "r002", model: "z-ai/glm-5.2", in: 30, out: 2 }),
  ];

  it("groups by profile with sums and call counts", () => {
    expect(aggregate(lines, "profile")).toEqual([
      { key: "planner", in: 40, out: 7, calls: 2 },
      { key: "exec-backend", in: 20, out: 8, calls: 1 },
    ]);
  });

  it("groups by round", () => {
    expect(aggregate(lines, "round")).toEqual([
      { key: "r001", in: 30, out: 13, calls: 2 },
      { key: "r002", in: 30, out: 2, calls: 1 },
    ]);
  });

  it("groups by model", () => {
    expect(aggregate(lines, "model")).toEqual([
      { key: "z-ai/glm-5.2", in: 60, out: 15, calls: 3 },
    ]);
  });

  it("returns [] for no lines", () => {
    expect(aggregate([], "profile")).toEqual([]);
  });

  it("supports the domain and stage dimensions", () => {
    const rows: UsageLine[] = [
      line({ domain: "backend", stage: "execute" }),
      line({ domain: "frontend", stage: "execute" }),
      line({ domain: "backend", stage: "recon" }),
    ];
    expect(aggregate(rows, "domain").map((r) => r.key).sort()).toEqual(["backend", "frontend"]);
    expect(aggregate(rows, "stage").map((r) => r.key).sort()).toEqual(["execute", "recon"]);
  });
});

describe("rollupStage / makeResolver", () => {
  it("groups a (round, stage) slice by domain with agent counts, folding shards", () => {
    const rows: UsageLine[] = [
      line({ profile: "backend__w1", domain: "backend", stage: "execute", in: 10, out: 5 }),
      line({ profile: "backend__w2", domain: "backend", stage: "execute", in: 20, out: 5 }),
      line({ profile: "frontend", domain: "frontend", stage: "execute", in: 4, out: 1 }),
      line({ profile: "planner", domain: "planning", stage: "recon", in: 99, out: 99 }), // other stage — excluded
    ];
    const r = rollupStage(rows, "execute", "r001", "2026-07-06T12:00:00Z");
    expect(r.byDomain).toEqual([
      { domain: "backend", agents: 2, calls: 2, in: 30, out: 10, total: 40 },
      { domain: "frontend", agents: 1, calls: 1, in: 4, out: 1, total: 5 },
    ]);
    expect(r.totals).toEqual({ calls: 3, in: 34, out: 11, total: 45 });
  });

  it("resolves legacy lines (no domain) via the profile's declared domain, stripping shard suffix", () => {
    const profiles = [
      { name: "exec-backend", role: "executor", domain: "backend", area: "backend", modelEnv: "BACKEND_MODEL", effort: "xhigh", prompt: "p.md", multimodal: false },
    ] as Profile[];
    const resolve = makeResolver(profiles);
    expect(resolve(line({ profile: "exec-backend", domain: undefined }))).toBe("backend");
    expect(resolve(line({ profile: "docs__w2", domain: undefined }))).toBe("docs"); // unknown profile → strip shard
    expect(resolve(line({ profile: "frontend", domain: "frontend" }))).toBe("frontend"); // explicit domain wins
  });
});
