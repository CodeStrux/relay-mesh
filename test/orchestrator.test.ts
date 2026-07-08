/**
 * Full-loop orchestrator test: the command run() fns are called directly with
 * argv against a FakeLlmClient in a tmpdir. Zero network. The real OpenRouter
 * client factory is swapped out via module mock — everything else is the
 * production code path, driven purely through env vars (RELAY_ROOT, …).
 */
import { appendFile, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApprovalMismatchError } from "../src/agents/execute.js";
import { run as approveCmd } from "../src/commands/approve.js";
import { run as executeCmd } from "../src/commands/execute.js";
import { run as planCmd } from "../src/commands/plan.js";
import { run as rosterCmd } from "../src/commands/roster.js";
import { run as statusCmd } from "../src/commands/status.js";
import { run as verifyCmd } from "../src/commands/verify.js";
import type { LlmClient } from "../src/openrouter.js";
import { listVisible, safeRead } from "../src/relay/fsio.js";
import { meshPaths } from "../src/relay/paths.js";
import { parseReport } from "../src/relay/report.js";
import { deriveState } from "../src/relay/state.js";
import { readUsage } from "../src/usage.js";
import { FakeLlmClient } from "./fakes/llm.js";
import { RECON_AREAS, addReconReport, makeRoot, reportMd, tmpRoot } from "./fixtures/roots.js";

// Commands construct the OpenRouter client themselves; swap the factory for the
// per-test fake so run() can be invoked exactly as cli.ts would invoke it.
const holder = vi.hoisted(() => ({ fake: null as unknown }));
vi.mock("../src/openrouter.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/openrouter.js")>();
  return {
    ...actual,
    makeOpenRouterClient: (): LlmClient => holder.fake as LlmClient,
  };
});

const GOAL = "Ship the demo service";
const EXEC_AREAS = ["backend", "frontend", "infra"] as const;

const MODEL_ENVS: Record<string, string> = {
  RM_TEST_PLANNER: "m-planner",
  RM_TEST_RECON_BACKEND: "m-recon-backend",
  RM_TEST_RECON_FRONTEND: "m-recon-frontend",
  RM_TEST_RECON_BUSINESS: "m-recon-business",
  RM_TEST_RECON_VISION: "m-recon-vision",
  RM_TEST_EXEC_BACKEND: "m-exec-backend",
  RM_TEST_EXEC_FRONTEND: "m-exec-frontend",
  RM_TEST_EXEC_INFRA: "m-exec-infra",
  RM_TEST_MONITOR: "m-monitor",
  RM_TEST_VERIFIER: "m-verifier",
};
const ENV_KEYS = [
  "OPENROUTER_API_KEY",
  "RELAY_ROOT",
  "RELAY_PROFILES",
  "MONITOR_POLL_MS",
  "MAX_FIX_ROUNDS",
  ...Object.keys(MODEL_ENVS),
];

// Same shape as the bundled fleet, with one distinct model id per profile so
// the fake's queues stay deterministic under parallel phases.
const FLEET = {
  version: 1,
  profiles: [
    { name: "planner", role: "planner", domain: "planning", modelEnv: "RM_TEST_PLANNER", effort: "low", prompt: "prompt.md" },
    { name: "recon-backend", role: "recon", domain: "backend recon", area: "backend", modelEnv: "RM_TEST_RECON_BACKEND", effort: "low", prompt: "prompt.md" },
    { name: "recon-frontend", role: "recon", domain: "frontend recon", area: "frontend", modelEnv: "RM_TEST_RECON_FRONTEND", effort: "low", prompt: "prompt.md" },
    { name: "recon-business", role: "recon", domain: "business recon", area: "business", modelEnv: "RM_TEST_RECON_BUSINESS", effort: "low", prompt: "prompt.md" },
    { name: "recon-vision", role: "recon", domain: "vision recon", area: "vision", modelEnv: "RM_TEST_RECON_VISION", effort: "low", prompt: "prompt.md", multimodal: true },
    { name: "exec-backend", role: "executor", domain: "backend", area: "backend", modelEnv: "RM_TEST_EXEC_BACKEND", effort: "low", prompt: "prompt.md" },
    { name: "exec-frontend", role: "executor", domain: "frontend", area: "frontend", modelEnv: "RM_TEST_EXEC_FRONTEND", effort: "low", prompt: "prompt.md" },
    { name: "exec-infra", role: "executor", domain: "infra", area: "infra", modelEnv: "RM_TEST_EXEC_INFRA", effort: "low", prompt: "prompt.md" },
    { name: "monitor", role: "monitor", domain: "monitoring", modelEnv: "RM_TEST_MONITOR", effort: "low", prompt: "prompt.md" },
    { name: "verifier", role: "verifier", domain: "verification", modelEnv: "RM_TEST_VERIFIER", effort: "low", prompt: "prompt.md" },
  ],
};

const PLAN_MD = [
  "# Plan",
  "",
  "## Synthesis",
  "",
  "One service, one UI, one box.",
  "",
  "## Domain brief: backend",
  "",
  "1. Build the API.",
  "",
  "## Domain brief: frontend",
  "",
  "1. Build the UI.",
  "",
  "## Domain brief: infra",
  "",
  "1. Provision the box.",
  "",
].join("\n");

const PLAN_WITH_DOCS = [
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
  "## Domain brief: infra",
  "",
  "1. Provision the box.",
  "",
  "## Domain brief: docs",
  "",
  "1. Write the README.",
  "",
].join("\n");

const FIX_PLAN_MD = "# Fix plan\n\n## Domain brief: backend\n\n1. Add the /health endpoint.\n";
const ROLLUP_MD = "# Roll-up\n\nAll areas terminal.\n";
const VERDICT_OK =
  '## Assessment\n\nAll asks satisfied.\n\n## Verdict\n\n```json\n{"satisfied": true, "gaps": []}\n```\n';
const VERDICT_GAPS =
  '## Assessment\n\nThe API lacks /health.\n\n## Verdict\n\n```json\n{"satisfied": false, "gaps": [{"area": "backend", "description": "missing /health endpoint"}]}\n```\n';

/** Executor output in the wire format of docs/protocol.md. */
function wire(area: string, round = "r001"): string {
  return [
    `=== FILE: src/${area}.ts ===`,
    `export const ${area} = "done";`,
    "=== END ===",
    "=== REPORT ===",
    "---",
    `area: ${area}`,
    "status: complete",
    "steps_done: 1",
    "steps_total: 1",
    `plan_ref: rounds/${round}/plan.md`,
    "---",
    "1. Ask #1 — done.",
    "",
  ].join("\n");
}

let root: string;
let fake: FakeLlmClient;
const dirs: string[] = [];
const savedEnv = new Map<string, string | undefined>();

beforeEach(async () => {
  const base = await tmpRoot();
  dirs.push(base);
  root = join(base, "relay");
  const fleet = join(base, "fleet");
  await mkdir(fleet, { recursive: true });
  await writeFile(join(fleet, "prompt.md"), "SYSTEM {{GOAL}} {{ROUND}}", "utf8");
  await writeFile(join(fleet, "profiles.json"), JSON.stringify(FLEET), "utf8");

  fake = new FakeLlmClient();
  holder.fake = fake;

  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
  process.env.OPENROUTER_API_KEY = "test-key";
  process.env.RELAY_ROOT = root;
  process.env.RELAY_PROFILES = join(fleet, "profiles.json");
  process.env.MONITOR_POLL_MS = "25";
  delete process.env.MAX_FIX_ROUNDS;
  for (const [k, v] of Object.entries(MODEL_ENVS)) process.env[k] = v;

  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const [k, v] of savedEnv) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  savedEnv.clear();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

/** vision has no visual inputs in these runs — it self-reports without an LLM call. */
function scriptRecon(): void {
  fake.script("m-recon-backend", reportMd("backend"));
  fake.script("m-recon-frontend", reportMd("frontend"));
  fake.script("m-recon-business", reportMd("business"));
}

/** Atomicity invariant: no *.part anywhere in the tree, dot dirs included. */
async function findParts(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await findParts(full)));
    else if (e.name.endsWith(".part")) out.push(full);
  }
  return out;
}

/** cli.ts maps a thrown command error to exit 1 — mirror that mapping. */
async function cliCode(
  fn: (argv: string[]) => Promise<number>,
  argv: string[],
): Promise<{ code: number; err: unknown }> {
  try {
    return { code: await fn(argv), err: null };
  } catch (err) {
    return { code: 1, err };
  }
}

function callText(call: { user: { type: string }[] }): string {
  return call.user
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}

describe("orchestrator full loop", () => {
  it("plan → approve --yes → execute → verify reaches done, atomically", async () => {
    scriptRecon();
    fake.script("m-planner", PLAN_MD);
    for (const a of EXEC_AREAS) fake.script(`m-exec-${a}`, wire(a));
    fake.script("m-monitor", ROLLUP_MD);
    fake.script("m-verifier", VERDICT_OK);

    expect(await planCmd([GOAL])).toBe(0);
    expect(await safeRead(meshPaths(root).goal)).toBe(`${GOAL}\n`); // goal verbatim
    expect(JSON.parse((await safeRead(meshPaths(root).meshJson))!)).toMatchObject({ protocol: 1 });
    expect((await deriveState(root)).phase).toBe("awaiting-approval");
    expect(await findParts(root)).toEqual([]);

    expect(await approveCmd(["--yes"])).toBe(0);
    expect((await deriveState(root)).phase).toBe("awaiting-roster");
    expect(await findParts(root)).toEqual([]);

    // Gate #2: the roster authors the exec briefs deterministically (no LLM).
    expect(await rosterCmd(["--yes"])).toBe(0);
    expect((await deriveState(root)).phase).toBe("executing");
    expect(await findParts(root)).toEqual([]);

    const rp = meshPaths(root).round("r001");
    const brief = (await safeRead(rp.brief(rp.execPair("backend"), "backend")))!;
    expect(brief).toContain("# Execution brief: backend — round r001");
    expect(brief).toContain("## Domain brief: backend");

    expect(await executeCmd([])).toBe(0);
    expect((await deriveState(root)).phase).toBe("verifying");
    expect(await findParts(root)).toEqual([]);
    for (const a of EXEC_AREAS) {
      const pair = rp.execPair(a);
      expect(parseReport((await safeRead(rp.report(pair, a)))!).status?.status).toBe("complete");
      expect(JSON.parse((await safeRead(rp.closure(pair)))!).totals.pct).toBe(100);
      expect(await safeRead(join(rp.workspaceFiles(a), "src", `${a}.ts`))).toBe(
        `export const ${a} = "done";\n`,
      );
    }
    expect(await safeRead(rp.rollup)).toBe(ROLLUP_MD);

    expect(await verifyCmd([])).toBe(0);
    expect((await deriveState(root)).phase).toBe("done");
    expect(await findParts(root)).toEqual([]);
    expect(await statusCmd(["--json"])).toBe(0); // terminal-good

    // One usage line per LLM call: 3 recon + planner + 3 executors + monitor + verifier.
    const usage = await readUsage(meshPaths(root).usage);
    expect(usage).toHaveLength(9);
    expect(new Set(usage.map((u) => u.profile))).toEqual(
      new Set([
        "recon-backend",
        "recon-frontend",
        "recon-business",
        "planner",
        "backend",
        "frontend",
        "infra",
        "monitor",
        "verifier",
      ]),
    );

    // Per-domain token-usage JSON at each stage boundary (rounds/r001/usage/<stage>.json).
    const reconUsage = JSON.parse((await safeRead(rp.usageStage("recon")))!);
    expect(reconUsage.stage).toBe("recon");
    expect(reconUsage.byDomain.some((d: { domain: string }) => d.domain === "planning")).toBe(true);
    const execUsage = JSON.parse((await safeRead(rp.usageStage("execute")))!);
    const execDomains = new Set(execUsage.byDomain.map((d: { domain: string }) => d.domain));
    for (const a of ["backend", "frontend", "infra"]) expect(execDomains.has(a)).toBe(true);
    expect(JSON.parse((await safeRead(rp.usageStage("verify")))!).stage).toBe("verify");
  });

  it("refuses to execute when plan.md was edited after approval (exit 1)", async () => {
    scriptRecon();
    fake.script("m-planner", PLAN_MD);
    expect(await planCmd([GOAL])).toBe(0);
    expect(await approveCmd(["--yes"])).toBe(0);

    const rp = meshPaths(root).round("r001");
    await appendFile(rp.plan, "\nsneaky post-approval edit\n", "utf8");

    const { code, err } = await cliCode(executeCmd, []);
    expect(code).toBe(1);
    expect(err).toBeInstanceOf(ApprovalMismatchError);
    // No executor ran and no report landed.
    expect(fake.calls.filter((c) => c.model.startsWith("m-exec-"))).toEqual([]);
    expect(await safeRead(rp.report(rp.execPair("backend"), "backend"))).toBeNull();
  });

  it("a failing executor becomes a blocked report; siblings unaffected; exit 3", async () => {
    scriptRecon();
    fake.script("m-planner", PLAN_MD);
    fake.script("m-exec-backend", { kind: "failure", error: new Error("model offline") });
    fake.script("m-exec-frontend", wire("frontend"));
    fake.script("m-exec-infra", wire("infra"));
    fake.script("m-monitor", ROLLUP_MD);

    expect(await planCmd([GOAL])).toBe(0);
    expect(await approveCmd(["--yes"])).toBe(0);
    expect(await rosterCmd(["--yes"])).toBe(0);
    expect(await executeCmd([])).toBe(3);

    const rp = meshPaths(root).round("r001");
    const backend = parseReport((await safeRead(rp.report(rp.execPair("backend"), "backend")))!);
    expect(backend.status?.status).toBe("blocked");
    expect(backend.body).toContain("model offline"); // literal error preserved
    const closure = JSON.parse((await safeRead(rp.closure(rp.execPair("backend"))))!);
    expect(closure.totals.blocked).toEqual(["backend"]);

    for (const a of ["frontend", "infra"] as const) {
      expect(parseReport((await safeRead(rp.report(rp.execPair(a), a)))!).status?.status).toBe(
        "complete",
      );
      expect(await safeRead(join(rp.workspaceFiles(a), "src", `${a}.ts`))).not.toBeNull();
    }
    // blocked is terminal, not a failure: the roll-up still runs, nothing half-written.
    expect(await safeRead(rp.rollup)).toBe(ROLLUP_MD);
    expect(await findParts(root)).toEqual([]);
  });

  it("unsatisfied verdict scaffolds a fix round and re-arms the approval gate", async () => {
    scriptRecon();
    fake.script("m-planner", PLAN_MD, FIX_PLAN_MD); // synthesis, then fix-round scaffold
    for (const a of EXEC_AREAS) fake.script(`m-exec-${a}`, wire(a));
    fake.script("m-exec-backend", wire("backend", "r002")); // queued behind the r001 wire
    fake.script("m-monitor", ROLLUP_MD, ROLLUP_MD);
    fake.script("m-verifier", VERDICT_GAPS, VERDICT_OK);

    expect(await planCmd([GOAL])).toBe(0);
    expect(await approveCmd(["--yes"])).toBe(0);
    expect(await rosterCmd(["--yes"])).toBe(0);
    expect(await executeCmd([])).toBe(0);
    expect(await verifyCmd([])).toBe(2); // gaps → awaiting a human at the new gate

    const state = await deriveState(root);
    expect(state.round).toBe("r002");
    expect(state.phase).toBe("awaiting-approval"); // the gate is re-armed
    expect(await safeRead(meshPaths(root).round("r002").plan)).toBe(FIX_PLAN_MD);

    expect(await approveCmd(["--yes"])).toBe(0);
    expect(await rosterCmd(["--yes"])).toBe(0);
    expect(await executeCmd([])).toBe(0);
    // Only the gap area re-ran; the fix executor saw the prior round's outcome.
    expect(fake.calls.filter((c) => c.model === "m-exec-frontend")).toHaveLength(1);
    const backendCalls = fake.calls.filter((c) => c.model === "m-exec-backend");
    expect(backendCalls).toHaveLength(2);
    expect(callText(backendCalls[1]!)).toContain("Prior report (r001)");

    const rp2 = meshPaths(root).round("r002");
    expect(
      parseReport((await safeRead(rp2.report(rp2.execPair("backend"), "backend")))!).status?.status,
    ).toBe("complete");

    expect(await verifyCmd([])).toBe(0);
    const done = await deriveState(root);
    expect(done.round).toBe("r002");
    expect(done.phase).toBe("done");
    expect(await findParts(root)).toEqual([]);
  });

  it("MAX_FIX_ROUNDS bounds the loop: no fix round beyond the cap", async () => {
    process.env.MAX_FIX_ROUNDS = "1";
    scriptRecon();
    fake.script("m-planner", PLAN_MD); // no fix plan queued — a scaffold call would throw
    for (const a of EXEC_AREAS) fake.script(`m-exec-${a}`, wire(a));
    fake.script("m-monitor", ROLLUP_MD);
    fake.script("m-verifier", VERDICT_GAPS);

    expect(await planCmd([GOAL])).toBe(0);
    expect(await approveCmd(["--yes"])).toBe(0);
    expect(await rosterCmd(["--yes"])).toBe(0);
    expect(await executeCmd([])).toBe(0);
    expect(await verifyCmd([])).toBe(2);

    expect(await listVisible(meshPaths(root).roundsDir)).toEqual(["r001"]);
    const state = await deriveState(root);
    expect(state.round).toBe("r001");
    expect(state.phase).toBe("fix-planning"); // terminal-but-unsatisfied; a human decides
    expect(fake.calls.filter((c) => c.model === "m-planner")).toHaveLength(1);
  });
});

describe("review-confirmed edges", () => {
  it("reject → revise plan dropping a domain → re-approve prunes the stale pair; no wedge", async () => {
    scriptRecon();
    fake.script("m-planner", PLAN_MD);
    expect(await planCmd([GOAL])).toBe(0);

    expect(await approveCmd(["--reject", "not enough detail"])).toBe(2);
    expect((await deriveState(root)).phase).toBe("replanning");

    // Human revises the plan by hand: backend brief dropped entirely.
    const rp = meshPaths(root).round("r001");
    await writeFile(
      rp.plan,
      "# Plan v2\n\n## Domain brief: frontend\n\n1. Build the UI.\n\n## Domain brief: infra\n\n1. Provision the box.\n",
      "utf8",
    );
    expect(await approveCmd(["--yes"])).toBe(0);
    expect(await rosterCmd(["--yes"])).toBe(0);

    fake.script("m-exec-frontend", wire("frontend"));
    fake.script("m-exec-infra", wire("infra"));
    fake.script("m-monitor", ROLLUP_MD);
    fake.script("m-verifier", VERDICT_OK);
    expect(await executeCmd([])).toBe(0);

    // The stale backend pair (briefed under the rejected plan) must be gone,
    // otherwise deriveState wedges at "executing" forever.
    const state = await deriveState(root);
    expect(state.exec.map((p) => p.area).sort()).toEqual(["frontend", "infra"]);
    expect(state.phase).toBe("verifying");
    expect(await verifyCmd([])).toBe(0);
    expect((await deriveState(root)).phase).toBe("done");
  });

  it("approve refuses a terminal round (verdict exists)", async () => {
    scriptRecon();
    fake.script("m-planner", PLAN_MD);
    for (const a of EXEC_AREAS) fake.script(`m-exec-${a}`, wire(a));
    fake.script("m-monitor", ROLLUP_MD);
    fake.script("m-verifier", VERDICT_OK);
    await planCmd([GOAL]);
    await approveCmd(["--yes"]);
    await rosterCmd(["--yes"]);
    await executeCmd([]);
    await verifyCmd([]);
    expect((await deriveState(root)).phase).toBe("done");

    const { code } = await cliCode(approveCmd, ["--yes"]);
    expect(code).toBe(1); // nothing in a terminal round is rewritten
  });

  it("plan --project persists project.json and execute inlines the referenced source bytes", async () => {
    const base = dirs[dirs.length - 1]!;
    const proj = join(base, "proj");
    await mkdir(proj, { recursive: true });
    await writeFile(join(proj, "app.cfg"), "PROJECT_CFG_BODY\n", "utf8");

    scriptRecon();
    fake.script(
      "m-planner",
      "# Plan\n\n## Synthesis\n\nok\n\n## Domain brief: backend\n\n1. Update `app.cfg`.\n\n## Domain brief: frontend\n\n1. Build the UI.\n\n## Domain brief: infra\n\n1. Provision the box.\n",
    );
    for (const a of EXEC_AREAS) fake.script(`m-exec-${a}`, wire(a));
    fake.script("m-monitor", ROLLUP_MD);

    expect(await planCmd([GOAL, "--project", proj])).toBe(0);
    const record = JSON.parse((await safeRead(join(root, "project.json")))!);
    expect(record.path).toBe(proj);
    expect(typeof record.host).toBe("string");

    expect(await approveCmd(["--yes"])).toBe(0);
    expect(await rosterCmd(["--yes"])).toBe(0);
    expect(await executeCmd([])).toBe(0);
    const backendCall = fake.calls.find((c) => c.model === "m-exec-backend")!;
    expect(callText(backendCall)).toContain("## Source files (current contents)");
    expect(callText(backendCall)).toContain("PROJECT_CFG_BODY");
  });

  it("execute --project overrides a stale project.json record", async () => {
    const base = dirs[dirs.length - 1]!;
    const projA = join(base, "projA");
    const projB = join(base, "projB");
    await mkdir(projA, { recursive: true });
    await mkdir(projB, { recursive: true });
    await writeFile(join(projA, "app.cfg"), "A_BODY\n", "utf8");
    await writeFile(join(projB, "app.cfg"), "B_BODY\n", "utf8");

    scriptRecon();
    fake.script(
      "m-planner",
      "# Plan\n\n## Synthesis\n\nok\n\n## Domain brief: backend\n\n1. Update `app.cfg`.\n\n## Domain brief: frontend\n\n1. Build the UI.\n\n## Domain brief: infra\n\n1. Provision the box.\n",
    );
    for (const a of EXEC_AREAS) fake.script(`m-exec-${a}`, wire(a));
    fake.script("m-monitor", ROLLUP_MD);

    expect(await planCmd([GOAL, "--project", projA])).toBe(0);
    expect(await approveCmd(["--yes"])).toBe(0);
    expect(await rosterCmd(["--yes"])).toBe(0);
    expect(await executeCmd(["--project", projB])).toBe(0);

    const backendCall = fake.calls.find((c) => c.model === "m-exec-backend")!;
    expect(callText(backendCall)).toContain("B_BODY");
    expect(callText(backendCall)).not.toContain("A_BODY");
  });

  it("a recorded project path missing on this box degrades to a visible note, never a crash", async () => {
    const base = dirs[dirs.length - 1]!;
    const proj = join(base, "gone");
    await mkdir(proj, { recursive: true });

    scriptRecon();
    fake.script("m-planner", PLAN_MD);
    for (const a of EXEC_AREAS) fake.script(`m-exec-${a}`, wire(a));
    fake.script("m-monitor", ROLLUP_MD);

    expect(await planCmd([GOAL, "--project", proj])).toBe(0);
    expect(await approveCmd(["--yes"])).toBe(0);
    expect(await rosterCmd(["--yes"])).toBe(0);
    await rm(proj, { recursive: true, force: true });
    expect(await executeCmd([])).toBe(0);

    const backendCall = fake.calls.find((c) => c.model === "m-exec-backend")!;
    expect(callText(backendCall)).toContain("not accessible on this machine");
  });

  it("plan --project with a nonexistent path fails fast with exit 1", async () => {
    const base = dirs[dirs.length - 1]!;
    const { code, err } = await cliCode(planCmd, [GOAL, "--project", join(base, "missing")]);
    expect(code).toBe(1);
    expect(String(err)).toContain("--project");
    expect(fake.calls).toEqual([]); // failed before any LLM spend
  });

  it("a bad --project with --force-area does NOT delete the pair before validating (exit 1, report intact)", async () => {
    const base = dirs[dirs.length - 1]!;
    scriptRecon();
    fake.script("m-planner", PLAN_MD);
    for (const a of EXEC_AREAS) fake.script(`m-exec-${a}`, wire(a));
    fake.script("m-monitor", ROLLUP_MD);
    fake.script("m-verifier", VERDICT_OK);

    expect(await planCmd([GOAL])).toBe(0);
    expect(await approveCmd(["--yes"])).toBe(0);
    expect(await rosterCmd(["--yes"])).toBe(0);
    expect(await executeCmd([])).toBe(0); // r001 terminal, backend report + workspace exist

    const rp = meshPaths(root).round("r001");
    const before = await safeRead(rp.report(rp.execPair("backend"), "backend"));
    expect(before).not.toBeNull();

    // A typo'd --project must abort BEFORE the destructive --force-area rm.
    const { code } = await cliCode(executeCmd, ["--force-area", "backend", "--project", join(base, "typo")]);
    expect(code).toBe(1);
    expect(await safeRead(rp.report(rp.execPair("backend"), "backend"))).toBe(before);
    expect(await safeRead(join(rp.workspaceFiles("backend"), "src", "backend.ts"))).not.toBeNull();
  });

  it("clears a stale project.json on a --force goal replacement without --project", async () => {
    // Root parked in synthesis (recon done, no plan.md) with a project.json from
    // an earlier --project run — the only phase where a --force re-goal proceeds.
    await makeRoot(root, { goal: "Original goal" });
    for (const a of RECON_AREAS) await addReconReport(root, a);
    await writeFile(
      join(root, "project.json"),
      `${JSON.stringify({ path: join(root, "siteA"), host: "old@box" })}\n`,
      "utf8",
    );
    fake.script("m-planner", PLAN_MD);

    expect(await planCmd(["A completely different goal", "--force"])).toBe(0);
    expect(await safeRead(join(root, "project.json"))).toBeNull();
  });

  it("malformed first attempt: corrective re-prompt wins, raw.md salvages, report path never holds a raw dump", async () => {
    scriptRecon();
    fake.script("m-planner", PLAN_MD);
    // First attempt is a bare status block — it PARSES as a report but is not
    // wire format; it must never be published at the report path.
    const bare =
      "---\narea: backend\nstatus: complete\nsteps_done: 1\nsteps_total: 1\nplan_ref: rounds/r001/plan.md\n---\nProse instead of wire.\n";
    fake.script("m-exec-backend", bare, wire("backend"));
    fake.script("m-exec-frontend", wire("frontend"));
    fake.script("m-exec-infra", wire("infra"));
    fake.script("m-monitor", ROLLUP_MD);
    fake.script("m-verifier", VERDICT_OK);

    await planCmd([GOAL]);
    await approveCmd(["--yes"]);
    await rosterCmd(["--yes"]);
    expect(await executeCmd([])).toBe(0);

    const rp = meshPaths(root).round("r001");
    const pair = rp.execPair("backend");
    const report = (await safeRead(rp.report(pair, "backend")))!;
    expect(report).not.toContain("Prose instead of wire");   // raw dump never published
    expect(parseReport(report).status?.status).toBe("complete");
    expect(fake.calls.filter((c) => c.model === "m-exec-backend")).toHaveLength(2);
    expect(await safeRead(join(rp.workspace("backend"), "raw.md"))).toContain(
      "Prose instead of wire",                                // tokens never lost
    );
    expect(await safeRead(join(rp.workspaceFiles("backend"), "src", "backend.ts"))).toBe(
      'export const backend = "done";\n',
    );
    expect(await findParts(root)).toEqual([]);
  });
});

describe("dynamic roster growth", () => {
  it("shards a domain and mints a new one from a template; all execute with per-pair closures", async () => {
    scriptRecon();
    fake.script("m-planner", PLAN_WITH_DOCS);
    fake.script("m-exec-backend", wire("backend"), wire("backend")); // two shards
    fake.script("m-exec-frontend", wire("frontend"), wire("docs")); // frontend + minted docs (exec-frontend template)
    fake.script("m-exec-infra", wire("infra"));
    fake.script("m-monitor", ROLLUP_MD);

    expect(await planCmd([GOAL])).toBe(0);
    expect(await approveCmd(["--yes"])).toBe(0);
    expect((await deriveState(root)).phase).toBe("awaiting-roster");

    // The advisor authors roster.json before the gate: backend×2 shards + a minted "docs" domain.
    const rp = meshPaths(root).round("r001");
    const roster = {
      version: 1,
      execute: [
        { domain: "backend", template: "exec-backend", count: 2, modelEnv: "RM_TEST_EXEC_BACKEND", effort: "low" },
        { domain: "frontend", template: "exec-frontend", count: 1, modelEnv: "RM_TEST_EXEC_FRONTEND", effort: "low" },
        { domain: "infra", template: "exec-infra", count: 1, modelEnv: "RM_TEST_EXEC_INFRA", effort: "low" },
        { domain: "docs", template: "exec-frontend", count: 1, modelEnv: "RM_TEST_EXEC_FRONTEND", effort: "low" },
      ],
    };
    await writeFile(rp.roster, `${JSON.stringify(roster, null, 2)}\n`, "utf8");

    expect(await rosterCmd(["--yes"])).toBe(0);
    expect((await deriveState(root)).phase).toBe("executing");
    expect(await executeCmd([])).toBe(0);
    expect((await deriveState(root)).phase).toBe("verifying");

    // Five worker pairs: two backend shards + frontend + infra + the minted docs.
    const execPairs = (await listVisible(join(rp.dir, "exec"))).sort();
    expect(execPairs).toEqual([
      "planner__backend__w1",
      "planner__backend__w2",
      "planner__docs",
      "planner__frontend",
      "planner__infra",
    ]);

    // Each pair holds a complete report and a byte-parity closure (pct 100).
    for (const pair of execPairs) {
      const dir = join(rp.dir, "exec", pair);
      const files = await listVisible(dir);
      const area = files.find((f) => f.endsWith(".report.md"))!.slice(0, -".report.md".length);
      expect(parseReport((await safeRead(join(dir, `${area}.report.md`)))!).status?.status).toBe("complete");
      expect(JSON.parse((await safeRead(join(dir, "closure.json")))!).totals.pct).toBe(100);
    }

    // Sharded workspaces are structurally disjoint (single-writer per shard).
    for (const shard of [1, 2]) {
      expect(await safeRead(join(rp.workspaceFiles("backend", shard), "src", "backend.ts"))).toBe(
        'export const backend = "done";\n',
      );
    }

    // Each shard is its own worker in usage; the minted domain ran too.
    const profiles = new Set((await readUsage(meshPaths(root).usage)).map((u) => u.profile));
    expect(profiles.has("backend__w1")).toBe(true);
    expect(profiles.has("backend__w2")).toBe(true);
    expect(profiles.has("docs")).toBe(true);
    expect(await findParts(root)).toEqual([]);
  });
});
