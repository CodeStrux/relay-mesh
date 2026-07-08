import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { atomicWrite } from "../src/relay/fsio.js";
import { meshPaths, nextRound } from "../src/relay/paths.js";
import { deriveState } from "../src/relay/state.js";
import {
  EXEC_AREAS,
  RECON_AREAS,
  addApproval,
  addExecReport,
  addPlan,
  addReconReport,
  addRollup,
  addRoster,
  addRound,
  addVerdict,
  makeRoot,
  tmpRoot,
} from "./fixtures/roots.js";

const dirs: string[] = [];
async function root(): Promise<string> {
  const d = await tmpRoot();
  dirs.push(d);
  return d;
}
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function allRecon(dir: string): Promise<void> {
  for (const a of RECON_AREAS) await addReconReport(dir, a);
}
async function allExec(dir: string): Promise<void> {
  for (const a of EXEC_AREAS) await addExecReport(dir, a);
}

describe("deriveState phase machine", () => {
  it("idle: no goal.md at root", async () => {
    const d = await root();
    const s = await deriveState(d);
    expect(s.phase).toBe("idle");
    expect(s.round).toBeNull();
  });

  it("idle even when rounds exist but goal.md is absent", async () => {
    const d = await root();
    await makeRoot(d, { goal: null });
    expect((await deriveState(d)).phase).toBe("idle");
  });

  it("recon with round null when goal exists but no round was minted yet", async () => {
    const d = await root();
    await atomicWrite(meshPaths(d).goal, "Goal\n");
    const s = await deriveState(d);
    expect(s.phase).toBe("recon");
    expect(s.round).toBeNull();
  });

  it("recon: briefs laid, zero reports", async () => {
    const d = await root();
    await makeRoot(d);
    const s = await deriveState(d);
    expect(s.phase).toBe("recon");
    expect(s.round).toBe("r001");
    expect(s.recon).toHaveLength(4);
    expect(s.recon.every((p) => p.hasBrief && !p.hasReport && p.status === null)).toBe(true);
  });

  it("crash-resume: 2/4 recon reports stays recon with missing pairs identifiable", async () => {
    const d = await root();
    await makeRoot(d);
    await addReconReport(d, "backend");
    await addReconReport(d, "frontend");
    const s = await deriveState(d);
    expect(s.phase).toBe("recon");
    const missing = s.recon.filter((p) => p.status === null).map((p) => p.area);
    expect(missing.sort()).toEqual(["business", "vision"]);
  });

  it("an unparseable recon report is in-flight, not authoritative", async () => {
    const d = await root();
    await makeRoot(d);
    await allRecon(d);
    await addReconReport(d, "vision", { raw: "streaming, no status block yet" });
    const s = await deriveState(d);
    expect(s.phase).toBe("recon");
    const vision = s.recon.find((p) => p.area === "vision")!;
    expect(vision.hasReport).toBe(true);
    expect(vision.status).toBeNull();
  });

  it("synthesis: recon done, no plan.md", async () => {
    const d = await root();
    await makeRoot(d);
    await allRecon(d);
    expect((await deriveState(d)).phase).toBe("synthesis");
  });

  it("awaiting-approval: plan.md present, no approval; planSha256 exposed", async () => {
    const d = await root();
    await makeRoot(d);
    await allRecon(d);
    const sha = await addPlan(d);
    const s = await deriveState(d);
    expect(s.phase).toBe("awaiting-approval");
    expect(s.planSha256).toBe(sha);
    expect(s.approval).toBeNull();
  });

  it("replanning: approval decision == rejected", async () => {
    const d = await root();
    await makeRoot(d);
    await allRecon(d);
    await addPlan(d);
    await addApproval(d, { decision: "rejected" });
    const s = await deriveState(d);
    expect(s.phase).toBe("replanning");
    expect(s.approval?.decision).toBe("rejected");
  });

  it("awaiting-roster: plan approved but no roster yet", async () => {
    const d = await root();
    await makeRoot(d);
    await allRecon(d);
    await addPlan(d);
    await addApproval(d, { roster: false });
    const s = await deriveState(d);
    expect(s.phase).toBe("awaiting-roster");
    expect(s.rosterApproval).toBeNull();
  });

  it("roster-revising: roster approval decision == rejected", async () => {
    const d = await root();
    await makeRoot(d);
    await allRecon(d);
    await addPlan(d);
    await addApproval(d, { roster: false });
    await addRoster(d, { decision: "rejected" });
    const s = await deriveState(d);
    expect(s.phase).toBe("roster-revising");
  });

  it("stale roster (approval sha no longer matches roster.json) drops back to awaiting-roster", async () => {
    const d = await root();
    await makeRoot(d);
    await allRecon(d);
    await addPlan(d);
    await addApproval(d, { roster: false });
    await addRoster(d, { rosterSha256: "0".repeat(64) }); // approved, but pins a different sha
    expect((await deriveState(d)).phase).toBe("awaiting-roster");
  });

  it("executing: approved with matching sha, exec briefs laid, no reports", async () => {
    const d = await root();
    await makeRoot(d);
    await allRecon(d);
    const sha = await addPlan(d);
    await addApproval(d);
    const s = await deriveState(d);
    expect(s.phase).toBe("executing");
    expect(s.approval).toEqual({ decision: "approved", planSha256: sha });
    expect(s.exec).toHaveLength(3);
    expect(s.exec.every((p) => p.hasBrief)).toBe(true);
  });

  it("crash-resume: 1/3 exec reports stays executing; pending pairs identifiable", async () => {
    const d = await root();
    await makeRoot(d);
    await allRecon(d);
    await addPlan(d);
    await addApproval(d);
    await addExecReport(d, "backend");
    const s = await deriveState(d);
    expect(s.phase).toBe("executing");
    const pending = s.exec.filter((p) => p.status === null).map((p) => p.area);
    expect(pending.sort()).toEqual(["frontend", "infra"]);
  });

  it("rollup: every exec pair terminal (blocked counts as terminal), no rollup.md", async () => {
    const d = await root();
    await makeRoot(d);
    await allRecon(d);
    await addPlan(d);
    await addApproval(d);
    await addExecReport(d, "backend");
    await addExecReport(d, "frontend", { status: "blocked", stepsDone: 1, stepsTotal: 4 });
    await addExecReport(d, "infra");
    const s = await deriveState(d);
    expect(s.phase).toBe("rollup");
    expect(s.exec.find((p) => p.area === "frontend")?.status).toBe("blocked");
  });

  it("verifying: rollup.md present, no verdict.json", async () => {
    const d = await root();
    await makeRoot(d);
    await allRecon(d);
    await addPlan(d);
    await addApproval(d);
    await allExec(d);
    await addRollup(d);
    expect((await deriveState(d)).phase).toBe("verifying");
  });

  it("done: verdict.satisfied == true", async () => {
    const d = await root();
    await makeRoot(d);
    await allRecon(d);
    await addPlan(d);
    await addApproval(d);
    await allExec(d);
    await addRollup(d);
    await addVerdict(d, { satisfied: true });
    const s = await deriveState(d);
    expect(s.phase).toBe("done");
    expect(s.verdict).toEqual({ satisfied: true });
  });

  it("fix-planning: unsatisfied verdict and no next round", async () => {
    const d = await root();
    await makeRoot(d);
    await allRecon(d);
    await addPlan(d);
    await addApproval(d);
    await allExec(d);
    await addRollup(d);
    await addVerdict(d, { satisfied: false, gaps: [{ area: "backend", description: "missing auth" }] });
    const s = await deriveState(d);
    expect(s.phase).toBe("fix-planning");
    expect(s.round).toBe("r001");
  });

  it("recurses into the next round when r001 is terminal-but-unsatisfied", async () => {
    const d = await root();
    await makeRoot(d);
    await allRecon(d);
    await addPlan(d);
    await addApproval(d);
    await allExec(d);
    await addRollup(d);
    await addVerdict(d, { satisfied: false });
    await addRound(d, "r002");
    await addPlan(d, { round: "r002", content: "# Fix plan\n\n## Domain brief: backend\n…\n" });
    const s = await deriveState(d);
    expect(s.round).toBe("r002");
    expect(s.phase).toBe("awaiting-approval");
    expect(s.recon).toEqual([]); // fix rounds carry no recon pairs
  });

  it("a mid-flight earlier phase wins before any recursion", async () => {
    const d = await root();
    await makeRoot(d);
    await addReconReport(d, "backend");
    const s = await deriveState(d);
    expect(s.round).toBe("r001");
    expect(s.phase).toBe("recon");
  });
});

describe("nextRound", () => {
  it("mints r001 from nothing and increments zero-padded", () => {
    expect(nextRound([])).toBe("r001");
    expect(nextRound(["r001"])).toBe("r002");
    expect(nextRound(["r001", "r002", "r009"])).toBe("r010");
    expect(nextRound(["r001", "stray.txt"])).toBe("r002");
  });
});
