import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { computeClosure, rollupPair } from "../src/relay/closure.js";
import { reportMd, tmpRoot } from "./fixtures/roots.js";

const GEN = "2026-07-06T21:00:00Z";

describe("computeClosure (relay-close.sh golden semantics)", () => {
  it("matches the protocol example byte-for-byte in shape", () => {
    const closure = computeClosure(
      "planner__backend",
      [{ area: "backend", md: reportMd("backend", { status: "complete", stepsDone: 5, stepsTotal: 5 }) }],
      GEN,
    );
    expect(JSON.stringify(closure)).toBe(
      '{"pair":"planner__backend","generated":"2026-07-06T21:00:00Z",' +
        '"briefs":[{"area":"backend","status":"complete","steps_done":5,"steps_total":5,"pct":100}],' +
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

  it("skips in-flight reports whose status block does not parse", () => {
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
