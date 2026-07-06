import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type CallCtx, TIMEOUT_MS, callProfile } from "../src/agents/call.js";
import { ApprovalMismatchError, briefPreamble, runExecute } from "../src/agents/execute.js";
import { runRollup, startPoller } from "../src/agents/monitor.js";
import { extractDomainBriefs, lintPlan, synthesizePlan } from "../src/agents/plan.js";
import { runRecon } from "../src/agents/recon.js";
import { runVerify, scaffoldFixRound } from "../src/agents/verify.js";
import type { Config } from "../src/config.js";
import type { Profile, Role } from "../src/profiles.js";
import { appendLine, safeRead } from "../src/relay/fsio.js";
import { type MeshPaths, meshPaths } from "../src/relay/paths.js";
import { parseReport } from "../src/relay/report.js";
import { rollupPair } from "../src/relay/closure.js";
import { readUsage } from "../src/usage.js";
import { FakeLlmClient } from "./fakes/llm.js";
import {
  EXEC_AREAS,
  RECON_AREAS,
  addApproval,
  addExecReport,
  addPlan,
  addReconReport,
  addRollup,
  addVerdict,
  makeRoot,
  reportMd,
  tmpRoot,
} from "./fixtures/roots.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function prof(name: string, role: Role, area?: string): Profile {
  return {
    name,
    role,
    domain: name,
    area,
    modelEnv: `M_${name.toUpperCase().replace(/-/g, "_")}`,
    effort: "low",
    prompt: "p.md",
    multimodal: area === "vision",
  };
}

const RECON_PROFILES = RECON_AREAS.map((a) => prof(`recon-${a}`, "recon", a));
const EXEC_PROFILES = EXEC_AREAS.map((a) => prof(`exec-${a}`, "executor", a));
const PLANNER = prof("planner", "planner");
const MONITOR = prof("monitor", "monitor");
const VERIFIER = prof("verifier", "verifier");

async function setup(
  round = "r001",
): Promise<{ dir: string; fake: FakeLlmClient; ctx: CallCtx; paths: MeshPaths }> {
  const dir = await tmpRoot();
  dirs.push(dir);
  const promptDir = join(dir, ".prompts");
  await mkdir(promptDir, { recursive: true });
  await writeFile(join(promptDir, "p.md"), "SYSTEM {{GOAL}} {{ROUND}} {{AREA}}", "utf8");
  const fake = new FakeLlmClient();
  const paths = meshPaths(dir);
  const config: Config = {
    apiKey: "",
    baseUrl: "",
    referer: "",
    title: "",
    relayRoot: dir,
    profilesPath: join(promptDir, "profiles.json"),
    monitorPollMs: 5,
    maxFixRounds: 3,
    debug: false,
    modelFor: (envName: string) => envName,
  };
  const ctx: CallCtx = {
    client: fake,
    config,
    round,
    usagePath: paths.usage,
    transcriptsDir: paths.round(round).transcriptsDir,
  };
  return { dir, fake, ctx, paths };
}

function textOf(call: { user: { type: string }[] }): string {
  return call.user
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}

const PLAN_OK =
  "# Plan\n\n## Synthesis\n\nok\n\n## Domain brief: backend\n\nb\n\n## Domain brief: frontend\n\nf\n\n## Domain brief: infra\n\ni\n";
const PLAN_MISSING_INFRA =
  "# Plan\n\n## Synthesis\n\nok\n\n## Domain brief: backend\n\nb\n\n## Domain brief: frontend\n\nf\n";

function wire(area: string): string {
  return `=== FILE: src/${area}.ts ===\nexport const ${area} = 1;\n=== END ===\n=== REPORT ===\n${reportMd(area)}`;
}

describe("callProfile", () => {
  it("streams to .part, publishes atomically, records usage, saves a transcript", async () => {
    const { dir, fake, ctx, paths } = await setup();
    const out = paths.round("r001").plan;
    fake.script("M_PLANNER", {
      kind: "text",
      text: "Hello world",
      chunks: ["Hello ", "world"],
      usage: { in: 3, out: 7 },
    });

    const text = await callProfile(ctx, PLANNER, [{ type: "text", text: "hi" }], out, {
      GOAL: "Goal",
      ROUND: "r001",
    });

    expect(text).toBe("Hello world");
    expect(await safeRead(out)).toBe("Hello world");
    expect(await safeRead(`${out}.part`)).toBeNull();
    expect(fake.calls[0]!.timeoutMs).toBe(TIMEOUT_MS.planner);
    const usage = await readUsage(paths.usage);
    expect(usage).toEqual([
      expect.objectContaining({ round: "r001", profile: "planner", model: "M_PLANNER", in: 3, out: 7 }),
    ]);
    const transcripts = await readdir(join(dir, "rounds", "r001", ".transcripts"));
    expect(transcripts).toHaveLength(1);
    const transcript = await safeRead(join(dir, "rounds", "r001", ".transcripts", transcripts[0]!));
    expect(transcript).toContain("SYSTEM Goal r001"); // vars interpolated into the prompt
    expect(transcript).toContain("Hello world");
  });

  it("propagates the literal error and publishes nothing", async () => {
    const { fake, ctx, paths } = await setup();
    const out = paths.round("r001").plan;
    fake.script("M_PLANNER", { kind: "failure", error: new Error("boom") });
    await expect(
      callProfile(ctx, PLANNER, [{ type: "text", text: "hi" }], out, {}),
    ).rejects.toThrow("boom");
    expect(await safeRead(out)).toBeNull();
    expect(await safeRead(`${out}.part`)).toBe(""); // liveness .part was created up front
  });
});

describe("runRecon", () => {
  it("writes briefs, runs all profiles, attaches visuals, rolls closures", async () => {
    const { dir, fake, ctx, paths } = await setup();
    await makeRoot(dir);
    await mkdir(paths.inputsDir, { recursive: true });
    await writeFile(join(paths.inputsDir, "board.png"), Buffer.from([1, 2, 3]));
    await writeFile(join(paths.inputsDir, "notes.pdf"), "pdf");
    const project = join(dir, ".project");
    await mkdir(project, { recursive: true });
    await writeFile(join(project, "hello.txt"), "hello there\n");
    for (const a of RECON_AREAS) fake.script(`M_RECON_${a.toUpperCase()}`, reportMd(a));

    await runRecon(ctx, RECON_PROFILES, { root: dir, goal: "G", projectPath: project });

    const rp = paths.round("r001");
    for (const a of RECON_AREAS) {
      const pairDir = rp.reconPair(`recon-${a}`);
      expect(await safeRead(rp.brief(pairDir, a))).toContain(`# Recon brief: ${a}`);
      expect(parseReport((await safeRead(rp.report(pairDir, a)))!).status?.status).toBe("complete");
      const closure = JSON.parse((await safeRead(rp.closure(pairDir)))!);
      expect(closure.totals.pct).toBe(100);
    }
    const backendCall = fake.calls.find((c) => c.model === "M_RECON_BACKEND")!;
    expect(textOf(backendCall)).toContain("## Project bundle");
    expect(textOf(backendCall)).toContain("hello.txt");
    const visionCall = fake.calls.find((c) => c.model === "M_RECON_VISION")!;
    const image = visionCall.user.find((p) => p.type === "image_url");
    expect(image && image.type === "image_url" ? image.image_url.url : "").toMatch(
      /^data:image\/png;base64,/,
    );
    expect(textOf(visionCall)).toContain("notes.pdf skipped");
  });

  it("vision with no visual inputs: skipped report, no LLM call", async () => {
    const { dir, fake, ctx, paths } = await setup();
    await makeRoot(dir);
    const vision = RECON_PROFILES.find((p) => p.area === "vision")!;

    await runRecon(ctx, [vision], { root: dir, goal: "G" });

    expect(fake.calls).toHaveLength(0);
    const rp = paths.round("r001");
    const pairDir = rp.reconPair("recon-vision");
    const report = (await safeRead(rp.report(pairDir, "vision")))!;
    const parsed = parseReport(report);
    expect(parsed.status).toMatchObject({ status: "complete", steps_done: 0, steps_total: 0 });
    expect(parsed.body).toContain("no visual inputs");
    expect(await safeRead(rp.closure(pairDir))).not.toBeNull();
  });

  it("a rejected call becomes a blocked report carrying the literal error", async () => {
    const { dir, fake, ctx, paths } = await setup();
    await makeRoot(dir);
    const backend = RECON_PROFILES.find((p) => p.area === "backend")!;
    fake.script("M_RECON_BACKEND", { kind: "failure", error: new Error("connection reset") });

    await runRecon(ctx, [backend], { root: dir, goal: "G" });

    const rp = paths.round("r001");
    const pairDir = rp.reconPair("recon-backend");
    const parsed = parseReport((await safeRead(rp.report(pairDir, "backend")))!);
    expect(parsed.status?.status).toBe("blocked");
    expect(parsed.body).toContain("connection reset");
    const closure = JSON.parse((await safeRead(rp.closure(pairDir)))!);
    expect(closure.totals.blocked).toEqual(["backend"]);
  });

  it("skips pairs that already have parseable reports (resume)", async () => {
    const { dir, fake, ctx } = await setup();
    await makeRoot(dir);
    await addReconReport(dir, "backend");
    const backend = RECON_PROFILES.find((p) => p.area === "backend")!;
    await runRecon(ctx, [backend], { root: dir, goal: "G" }); // nothing scripted — a call would throw
    expect(fake.calls).toHaveLength(0);
  });
});

describe("synthesizePlan", () => {
  async function reconDone(dir: string): Promise<void> {
    await makeRoot(dir);
    for (const a of RECON_AREAS) await addReconReport(dir, a);
  }

  it("one planner call over goal + recon reports writes plan.md", async () => {
    const { dir, fake, ctx, paths } = await setup();
    await reconDone(dir);
    fake.script("M_PLANNER", PLAN_OK);
    const plan = await synthesizePlan(ctx, PLANNER, { root: dir, goal: "G", execAreas: EXEC_AREAS });
    expect(plan).toBe(PLAN_OK);
    expect(await safeRead(paths.round("r001").plan)).toBe(PLAN_OK);
    expect(textOf(fake.calls[0]!)).toContain("## Recon report: backend");
  });

  it("lint failure earns one corrective re-prompt", async () => {
    const { dir, fake, ctx, paths } = await setup();
    await reconDone(dir);
    fake.script("M_PLANNER", PLAN_MISSING_INFRA, PLAN_OK);
    await synthesizePlan(ctx, PLANNER, { root: dir, goal: "G", execAreas: EXEC_AREAS });
    expect(fake.calls).toHaveLength(2);
    expect(textOf(fake.calls[1]!)).toContain('missing "## Domain brief: infra"');
    expect(await safeRead(paths.round("r001").plan)).toBe(PLAN_OK);
  });

  it("throws a three-line error when sections are still missing after the re-prompt", async () => {
    const { dir, fake, ctx } = await setup();
    await reconDone(dir);
    fake.script("M_PLANNER", PLAN_MISSING_INFRA, PLAN_MISSING_INFRA);
    await expect(
      synthesizePlan(ctx, PLANNER, { root: dir, goal: "G", execAreas: EXEC_AREAS }),
    ).rejects.toThrow(/plan lint failed/);
  });

  it("lintPlan flags over-length briefs; extractDomainBriefs is verbatim", () => {
    const long = `## Domain brief: backend\n${Array(950).fill("w").join(" ")}\n`;
    expect(lintPlan(long, ["backend"])).toEqual([expect.stringContaining("words")]);
    const briefs = extractDomainBriefs(PLAN_OK);
    expect([...briefs.keys()]).toEqual(EXEC_AREAS);
    expect(briefs.get("backend")).toBe("## Domain brief: backend\n\nb\n");
  });
});

describe("runExecute", () => {
  async function approvedRoot(dir: string): Promise<void> {
    await makeRoot(dir);
    for (const a of RECON_AREAS) await addReconReport(dir, a);
    await addPlan(dir, { content: PLAN_OK });
    await addApproval(dir);
  }

  it("refuses with ApprovalMismatchError when the plan was edited after approval", async () => {
    const { dir, ctx } = await setup();
    await makeRoot(dir);
    for (const a of RECON_AREAS) await addReconReport(dir, a);
    await addPlan(dir, { content: PLAN_OK });
    await addApproval(dir, { planSha256: "0".repeat(64) });
    await expect(runExecute(ctx, EXEC_PROFILES, { root: dir, goal: "G" })).rejects.toThrow(
      ApprovalMismatchError,
    );
  });

  it("extracts briefs verbatim, runs executors, lands artifacts + reports + closures", async () => {
    const { dir, fake, ctx, paths } = await setup();
    await approvedRoot(dir);
    for (const a of EXEC_AREAS) fake.script(`M_EXEC_${a.toUpperCase()}`, wire(a));

    await runExecute(ctx, EXEC_PROFILES, { root: dir, goal: "G" });

    const rp = paths.round("r001");
    for (const a of EXEC_AREAS) {
      const pairDir = rp.execPair(a);
      const brief = (await safeRead(rp.brief(pairDir, a)))!;
      expect(brief.startsWith(briefPreamble(a, "r001"))).toBe(true);
      expect(brief).toContain(`## Domain brief: ${a}`);
      expect(parseReport((await safeRead(rp.report(pairDir, a)))!).status?.status).toBe("complete");
      expect(await safeRead(join(rp.workspaceFiles(a), "src", `${a}.ts`))).toBe(
        `export const ${a} = 1;\n`,
      );
      expect(await safeRead(rp.closure(pairDir))).not.toBeNull();
    }
    const backendCall = fake.calls.find((c) => c.model === "M_EXEC_BACKEND")!;
    expect(backendCall.timeoutMs).toBe(TIMEOUT_MS.executor);
    expect(textOf(backendCall)).toContain("## Recon report: backend");
    expect(textOf(backendCall)).toContain("## Goal");
  });

  it("malformed output earns one corrective re-prompt", async () => {
    const { dir, fake, ctx, paths } = await setup();
    await approvedRoot(dir);
    fake.script("M_EXEC_BACKEND", "total garbage", wire("backend"));

    await runExecute(ctx, EXEC_PROFILES, { root: dir, goal: "G", areas: ["backend"] });

    const calls = fake.calls.filter((c) => c.model === "M_EXEC_BACKEND");
    expect(calls).toHaveLength(2);
    expect(textOf(calls[1]!)).toContain("could not be parsed");
    const rp = paths.round("r001");
    const report = (await safeRead(rp.report(rp.execPair("backend"), "backend")))!;
    expect(parseReport(report).status?.status).toBe("complete");
  });

  it("still-malformed output is salvaged to raw.md with a synthesized partial report", async () => {
    const { dir, fake, ctx, paths } = await setup();
    await approvedRoot(dir);
    fake.script("M_EXEC_BACKEND", "garbage one", "garbage two");

    await runExecute(ctx, EXEC_PROFILES, { root: dir, goal: "G", areas: ["backend"] });

    const rp = paths.round("r001");
    expect(await safeRead(rp.raw("backend"))).toBe("garbage two");
    const parsed = parseReport((await safeRead(rp.report(rp.execPair("backend"), "backend")))!);
    expect(parsed.status).toMatchObject({ status: "partial", steps_done: 0, steps_total: 0 });
    expect(parsed.body).toContain("raw.md");
  });

  it("a rejected executor call becomes a blocked report; siblings are isolated", async () => {
    const { dir, fake, ctx, paths } = await setup();
    await approvedRoot(dir);
    fake.script("M_EXEC_BACKEND", { kind: "failure", error: new Error("model offline") });
    fake.script("M_EXEC_FRONTEND", wire("frontend"));
    fake.script("M_EXEC_INFRA", wire("infra"));

    await runExecute(ctx, EXEC_PROFILES, { root: dir, goal: "G" });

    const rp = paths.round("r001");
    const backend = parseReport((await safeRead(rp.report(rp.execPair("backend"), "backend")))!);
    expect(backend.status?.status).toBe("blocked");
    expect(backend.body).toContain("model offline");
    const frontend = parseReport((await safeRead(rp.report(rp.execPair("frontend"), "frontend")))!);
    expect(frontend.status?.status).toBe("complete");
  });

  it("--area filter and per-pair resume both skip calls", async () => {
    const { dir, fake, ctx, paths } = await setup();
    await approvedRoot(dir);
    await addExecReport(dir, "backend"); // terminal already
    fake.script("M_EXEC_FRONTEND", wire("frontend"));

    await runExecute(ctx, EXEC_PROFILES, { root: dir, goal: "G", areas: ["backend", "frontend"] });

    expect(fake.calls.map((c) => c.model)).toEqual(["M_EXEC_FRONTEND"]);
    expect(await safeRead(paths.round("r001").report(paths.round("r001").execPair("infra"), "infra"))).toBeNull();
  });
});

describe("monitor", () => {
  it("poller appends report_updated deltas, once per observed change", async () => {
    const { dir, paths } = await setup();
    await makeRoot(dir);
    await addPlan(dir, { content: PLAN_OK });
    await addApproval(dir); // lays exec pair briefs
    await addExecReport(dir, "backend");

    const poller = startPoller(dir, "r001", 1_000_000);
    await sleep(30); // let the initial scan record the first snapshot
    await addExecReport(dir, "backend", { status: "partial", stepsDone: 2 });
    await poller.stop(); // final sweep records the delta

    const lines = ((await safeRead(paths.round("r001").eventsNdjson)) ?? "")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines.every((l) => l.pair === "planner__backend" && l.event === "report_updated")).toBe(true);
    expect(lines[0]).toMatchObject({ status: "complete", steps_done: 5 });
    expect(lines[1]).toMatchObject({ status: "partial", steps_done: 2 });
  });

  it("rollup: one monitor call over reports + events tail writes rollup.md", async () => {
    const { dir, fake, ctx, paths } = await setup();
    await makeRoot(dir);
    await addPlan(dir, { content: PLAN_OK });
    await addApproval(dir);
    for (const a of EXEC_AREAS) await addExecReport(dir, a);
    const rp = paths.round("r001");
    for (const a of EXEC_AREAS) await rollupPair(rp.execPair(a));
    await appendLine(rp.eventsNdjson, '{"event":"report_updated","pair":"planner__backend"}');
    fake.script("M_MONITOR", "# Execution roll-up\n\nAll good.");

    const text = await runRollup(ctx, MONITOR, { root: dir, goal: "G" });

    expect(text).toContain("All good.");
    expect(await safeRead(rp.rollup)).toBe(text);
    const call = fake.calls[0]!;
    expect(call.timeoutMs).toBe(TIMEOUT_MS.monitor);
    expect(textOf(call)).toContain("### Latest report");
    expect(textOf(call)).toContain("## Event log tail");
    expect(textOf(call)).toContain('"pair":"planner__backend"');
  });
});

describe("verify", () => {
  const GOOD_VERDICT =
    '## Assessment\n\nAll asks satisfied.\n\n## Verdict\n\n```json\n{"satisfied": true, "gaps": []}\n```\n';

  async function verifiableRoot(dir: string): Promise<void> {
    await makeRoot(dir);
    await addReconReport(dir, "vision");
    await addPlan(dir, { content: PLAN_OK });
    await addApproval(dir);
    for (const a of EXEC_AREAS) await addExecReport(dir, a);
    await addRollup(dir);
  }

  it("parses the json fence, writes verdict.json + verdict.md", async () => {
    const { dir, fake, ctx, paths } = await setup();
    await verifiableRoot(dir);
    fake.script("M_VERIFIER", GOOD_VERDICT);

    const verdict = await runVerify(ctx, VERIFIER, { root: dir, goal: "G" });

    expect(verdict).toEqual({ satisfied: true, gaps: [] });
    const rp = paths.round("r001");
    expect(JSON.parse((await safeRead(rp.verdictJson))!)).toMatchObject({ satisfied: true, gaps: [] });
    expect(await safeRead(rp.verdictMd)).toBe(GOOD_VERDICT);
    const text = textOf(fake.calls[0]!);
    expect(text).toContain("## Vision recon report");
    expect(text).toContain("All areas terminal."); // the rollup fixture body
    expect(text).toContain("## Workspace listing");
  });

  it("an invalid verdict earns one repair re-prompt", async () => {
    const { dir, fake, ctx } = await setup();
    await verifiableRoot(dir);
    // satisfied:true with gaps violates the schema refinement
    fake.script(
      "M_VERIFIER",
      '```json\n{"satisfied": true, "gaps": [{"area": "backend", "description": "x"}]}\n```',
      GOOD_VERDICT,
    );
    const verdict = await runVerify(ctx, VERIFIER, { root: dir, goal: "G" });
    expect(fake.calls).toHaveLength(2);
    expect(textOf(fake.calls[1]!)).toContain("failed validation");
    expect(verdict.satisfied).toBe(true);
  });

  it("still-unparseable output becomes a synthesized unsatisfied verdict", async () => {
    const { dir, fake, ctx, paths } = await setup();
    await verifiableRoot(dir);
    fake.script("M_VERIFIER", "no fence here", "still no fence");

    const verdict = await runVerify(ctx, VERIFIER, { root: dir, goal: "G" });

    expect(verdict.satisfied).toBe(false);
    expect(verdict.gaps[0]).toMatchObject({ area: "verify" });
    expect(await safeRead(paths.round("r001").verdictMd)).toBe("still no fence");
    expect(JSON.parse((await safeRead(paths.round("r001").verdictJson))!).satisfied).toBe(false);
  });

  it("scaffoldFixRound plans rNNN+1 from the gaps and is idempotent", async () => {
    const { dir, fake, ctx, paths } = await setup();
    await verifiableRoot(dir);
    await addVerdict(dir, {
      satisfied: false,
      gaps: [{ area: "backend", description: "missing endpoint /health" }],
    });
    fake.script("M_PLANNER", "# Fix plan\n\n## Domain brief: backend\n\nfix it\n");

    const next = await scaffoldFixRound(ctx, PLANNER, { root: dir, goal: "G" });

    expect(next).toBe("r002");
    expect(await safeRead(paths.round("r002").plan)).toContain("# Fix plan");
    const text = textOf(fake.calls[0]!);
    expect(text).toContain("missing endpoint /health");
    expect(text).toContain("Prior workspace listing");
    const usage = await readUsage(paths.usage);
    expect(usage.at(-1)).toMatchObject({ round: "r002", profile: "planner" });

    // resume: the fix plan already exists — no second planner call
    expect(await scaffoldFixRound(ctx, PLANNER, { root: dir, goal: "G" })).toBe("r002");
    expect(fake.calls).toHaveLength(1);
  });

  it("scaffoldFixRound refuses when the verdict is satisfied", async () => {
    const { dir, ctx } = await setup();
    await verifiableRoot(dir);
    await addVerdict(dir, { satisfied: true });
    await expect(scaffoldFixRound(ctx, PLANNER, { root: dir, goal: "G" })).rejects.toThrow(
      /satisfied/,
    );
  });
});
