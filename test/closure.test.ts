import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { computeClosure, rollupPair } from "../src/relay/closure.js";
import { reportMd, tmpRoot } from "./fixtures/roots.js";

const GEN = "2026-07-06T21:00:00Z";
const RELAY_CLOSE_SH = fileURLToPath(new URL("./fixtures/relay-close.sh", import.meta.url));

describe("computeClosure (relay-close.sh golden semantics)", () => {
  it("matches the protocol example byte-for-byte in shape", () => {
    const closure = computeClosure(
      "planner__backend",
      [{ area: "backend", md: reportMd("backend", { status: "complete", stepsDone: 5, stepsTotal: 5 }) }],
      GEN,
    );
    expect(JSON.stringify(closure)).toBe(
      '{"pair":"planner__backend","generated":"2026-07-06T21:00:00Z",' +
        '"briefs":[{"area":"backend","status":"complete","steps_done":5,"steps_total":5,"pct":100,"plan_ref":"rounds/r001/plan.md"}],' +
        '"totals":{"pct":100,"blocked":[]}}',
    );
  });

  it("floors per-brief pct", () => {
    const closure = computeClosure(
      "p__x",
      [
        { area: "a", md: reportMd("a", { status: "partial", stepsDone: 1, stepsTotal: 3 }) },
        { area: "b", md: reportMd("b", { status: "partial", stepsDone: 2, stepsTotal: 3 }) },
      ],
      GEN,
    );
    expect(closure.briefs.map((b) => b.pct)).toEqual([33, 66]);
    // totals: floor(3*100/6) = 50
    expect(closure.totals.pct).toBe(50);
  });

  it("floors totals.pct across briefs", () => {
    const closure = computeClosure(
      "p__x",
      [
        { area: "a", md: reportMd("a", { status: "partial", stepsDone: 1, stepsTotal: 3 }) },
        { area: "b", md: reportMd("b", { status: "partial", stepsDone: 1, stepsTotal: 3 }) },
      ],
      GEN,
    );
    expect(closure.totals.pct).toBe(33); // floor(200/6)
  });

  it("steps_total == 0: 100 iff complete, else 0", () => {
    const closure = computeClosure(
      "p__x",
      [
        { area: "a", md: reportMd("a", { status: "complete", stepsDone: 0, stepsTotal: 0 }) },
        { area: "b", md: reportMd("b", { status: "partial", stepsDone: 0, stepsTotal: 0 }) },
        { area: "c", md: reportMd("c", { status: "blocked", stepsDone: 0, stepsTotal: 0 }) },
      ],
      GEN,
    );
    expect(closure.briefs.map((b) => b.pct)).toEqual([100, 0, 0]);
    expect(closure.totals.pct).toBe(0); // Σtotal == 0
    expect(closure.totals.blocked).toEqual(["c"]);
  });

  it("aggregates blocked areas in order", () => {
    const closure = computeClosure(
      "p__x",
      [
        { area: "a", md: reportMd("a", { status: "blocked", stepsDone: 1, stepsTotal: 5 }) },
        { area: "b", md: reportMd("b", { status: "complete", stepsDone: 5, stepsTotal: 5 }) },
        { area: "c", md: reportMd("c", { status: "blocked", stepsDone: 0, stepsTotal: 2 }) },
      ],
      GEN,
    );
    expect(closure.totals.blocked).toEqual(["a", "c"]);
  });

  it("strips trailing comments in status values (awk getval parity)", () => {
    const md =
      "---\narea: backend\nstatus: blocked   # waiting on op\nsteps_done: 1\nsteps_total: 5\nplan_ref: p.md  # pinned\n---\n";
    const closure = computeClosure("p__x", [{ area: "backend", md }], GEN);
    expect(closure.briefs[0]!.status).toBe("blocked");
    expect(closure.totals.blocked).toEqual(["backend"]);
  });

  it("skips reports that never set an area: key (awk flush parity)", () => {
    const closure = computeClosure(
      "p__x",
      [
        { area: "a", md: "no block yet, still streaming" },
        { area: "b", md: reportMd("b", { status: "complete", stepsDone: 2, stepsTotal: 2 }) },
      ],
      GEN,
    );
    expect(closure.briefs).toHaveLength(1);
    expect(closure.briefs[0]!.area).toBe("b");
  });

  it("includes partial-key blocks with awk defaults (area + status only)", () => {
    // relay-close.sh emits these with done/total 0 and plan_ref "" — so must we.
    const complete = "---\narea: infra\nstatus: complete\n---\nbody\n";
    const blockedNoSteps = "---\narea: x\nstatus: blocked\n---\n";
    const closure = computeClosure(
      "p__x",
      [
        { area: "infra", md: complete },
        { area: "x", md: blockedNoSteps },
      ],
      GEN,
    );
    expect(closure.briefs).toEqual([
      { area: "infra", status: "complete", steps_done: 0, steps_total: 0, pct: 100, plan_ref: "" },
      { area: "x", status: "blocked", steps_done: 0, steps_total: 0, pct: 0, plan_ref: "" },
    ]);
    expect(closure.totals.blocked).toEqual(["x"]);
  });

  it("carries a non-canonical status string verbatim, like the awk", () => {
    const md = "---\narea: backend\nstatus: done\nsteps_done: 5\nsteps_total: 5\nplan_ref: p.md\n---\n";
    const closure = computeClosure("p__x", [{ area: "backend", md }], GEN);
    expect(closure.briefs[0]).toEqual({
      area: "backend",
      status: "done",
      steps_done: 5,
      steps_total: 5,
      pct: 100,
      plan_ref: "p.md",
    });
    expect(closure.totals.pct).toBe(100); // counted in the sums, not dropped
    expect(closure.totals.blocked).toEqual([]);
  });

  it("empty report list yields the empty-dir shape", () => {
    expect(JSON.stringify(computeClosure("planner__backend", [], GEN))).toBe(
      '{"pair":"planner__backend","generated":"2026-07-06T21:00:00Z","briefs":[],"totals":{"pct":0,"blocked":[]}}',
    );
  });
});

describe("rollupPair", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });

  it("reads *.report.md sorted, writes closure.json atomically, skips .part and dotfiles", async () => {
    const root = await tmpRoot();
    dirs.push(root);
    const pairDir = join(root, "planner__backend");
    await mkdir(pairDir, { recursive: true });
    await writeFile(join(pairDir, "auth.report.md"), reportMd("auth", { status: "complete", stepsDone: 4, stepsTotal: 4 }));
    await writeFile(join(pairDir, "db.report.md"), reportMd("db", { status: "blocked", stepsDone: 1, stepsTotal: 3 }));
    await writeFile(join(pairDir, "zz.report.md.part"), "half-written");
    await writeFile(join(pairDir, ".hidden.report.md"), reportMd("hidden"));
    await writeFile(join(pairDir, "auth.brief.md"), "# brief\n");

    const closure = await rollupPair(pairDir, new Date("2026-07-06T21:00:00Z"));

    expect(closure.pair).toBe("planner__backend");
    expect(closure.generated).toBe(GEN);
    expect(closure.briefs.map((b) => b.area)).toEqual(["auth", "db"]);
    expect(closure.totals).toEqual({ pct: 71, blocked: ["db"] }); // floor(5*100/7)

    const onDisk = JSON.parse(await readFile(join(pairDir, "closure.json"), "utf8"));
    expect(onDisk).toEqual(closure);
    const leftovers = (await readdir(pairDir)).filter((n) => n === "closure.json.part");
    expect(leftovers).toEqual([]);
  });

  it("writes the empty shape for a pair dir with no reports", async () => {
    const root = await tmpRoot();
    dirs.push(root);
    const pairDir = join(root, "planner__frontend");
    await mkdir(pairDir, { recursive: true });

    await rollupPair(pairDir, new Date("2026-07-06T21:00:00Z"));

    expect(await readFile(join(pairDir, "closure.json"), "utf8")).toBe(
      '{"pair":"planner__frontend","generated":"2026-07-06T21:00:00Z","briefs":[],"totals":{"pct":0,"blocked":[]}}\n',
    );
  });

  it("stamps generated at seconds precision (date -u +%FT%TZ shape)", async () => {
    const root = await tmpRoot();
    dirs.push(root);
    const pairDir = join(root, "planner__infra");
    await mkdir(pairDir, { recursive: true });
    const closure = await rollupPair(pairDir);
    expect(closure.generated).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });
});

describe("relay-close.sh golden parity (byte-for-byte, protocol.md line 5)", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });

  /** Run the vendored awk roll-up and rollupPair on identical reports; return both
   *  closure.json payloads with the (wall-clock) generated stamp neutralized. */
  async function bothClosures(reports: Record<string, string>): Promise<{ shell: string; mesh: string }> {
    const root = await tmpRoot();
    dirs.push(root);
    const pairDir = join(root, "planner__backend");
    await mkdir(pairDir, { recursive: true });
    for (const [name, md] of Object.entries(reports)) await writeFile(join(pairDir, name), md);
    const neutral = (s: string): string => s.replace(/"generated":"[^"]*"/, '"generated":"GEN"');
    execFileSync("bash", [RELAY_CLOSE_SH, pairDir], { stdio: ["ignore", "ignore", "pipe"] });
    const shell = neutral(await readFile(join(pairDir, "closure.json"), "utf8"));
    await rollupPair(pairDir);
    const mesh = neutral(await readFile(join(pairDir, "closure.json"), "utf8"));
    return { shell, mesh };
  }

  it("canonical multi-report pair dirs match byte-for-byte (incl. plan_ref)", async () => {
    const { shell, mesh } = await bothClosures({
      "auth.report.md": reportMd("auth", { status: "complete", stepsDone: 4, stepsTotal: 4 }),
      "db.report.md": reportMd("db", { status: "blocked", stepsDone: 1, stepsTotal: 3 }),
      "ui.report.md": reportMd("ui", { status: "partial", stepsDone: 2, stepsTotal: 5 }),
    });
    expect(mesh).toBe(shell);
    expect(mesh).toContain('"plan_ref":"rounds/r001/plan.md"');
  });

  it("a --- horizontal rule in the body re-toggles frontmatter in BOTH tools", async () => {
    // The awk toggles on every ---; a body hr followed by "status: blocked" flips
    // the brief. Divergence here is the exact blocked-vs-complete split the two
    // halves of the stack must never disagree on.
    const md =
      reportMd("backend", { status: "complete", stepsDone: 5, stepsTotal: 5 }) +
      "\nSome prose.\n\n---\n\nstatus: blocked\n";
    const { shell, mesh } = await bothClosures({ "backend.report.md": md });
    expect(mesh).toBe(shell);
    expect(mesh).toContain('"blocked":["backend"]');
  });

  it("partial-key, typo-status, and area-less reports all match", async () => {
    // Float steps are deliberately absent: awk implementations disagree on
    // "3.7"+0 (BSD truncates to 3, gawk keeps 3.7), so floats can never be a
    // portable golden case — the TS port pins integer-prefix truncation below.
    const { shell, mesh } = await bothClosures({
      "a.report.md": "---\narea: infra\nstatus: complete\n---\nbody\n",
      "b.report.md": "---\narea: x\nstatus: blocked\n---\n",
      "c.report.md": "---\narea: backend\nstatus: done\nsteps_done: 3\nsteps_total: 5\nplan_ref: p.md\n---\n",
      "d.report.md": "still streaming, no block yet\n",
    });
    expect(mesh).toBe(shell);
  });

  it("float steps truncate to the integer prefix (TS-pinned, not golden)", () => {
    const closure = computeClosure(
      "planner__backend",
      [{ area: "backend", md: "---\narea: backend\nstatus: done\nsteps_done: 3.7\nsteps_total: 5\nplan_ref: p.md\n---\n" }],
      GEN,
    );
    expect(closure.briefs[0]).toEqual({
      area: "backend", status: "done", steps_done: 3, steps_total: 5, pct: 60, plan_ref: "p.md",
    });
  });

  it("an empty pair dir yields the same empty shape", async () => {
    const { shell, mesh } = await bothClosures({});
    expect(mesh).toBe(shell);
  });
});
