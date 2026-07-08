// Builders that lay relay roots at various phases into a tmpdir.
// Composable: makeRoot -> addReconReport* -> addPlan -> addApproval -> addExecReport* -> addRollup -> addVerdict.
import { createHash } from "node:crypto";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWrite, safeRead } from "../../src/relay/fsio.js";
import { meshPaths } from "../../src/relay/paths.js";
import { serializeStatusBlock, type Status } from "../../src/relay/report.js";

export const RECON_AREAS = ["backend", "frontend", "business", "vision"];
export const EXEC_AREAS = ["backend", "frontend", "infra"];

export async function tmpRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "relay-mesh-test-"));
}

export interface ReportOpts {
  round?: string;
  status?: Status;
  stepsDone?: number;
  stepsTotal?: number;
  planRef?: string;
  body?: string;
  raw?: string; // verbatim report content (for unparseable/in-flight fixtures)
}

export function reportMd(area: string, opts: ReportOpts = {}): string {
  if (opts.raw !== undefined) return opts.raw;
  const round = opts.round ?? "r001";
  const status = opts.status ?? "complete";
  const total = opts.stepsTotal ?? 5;
  const done = opts.stepsDone ?? (status === "complete" ? total : 2);
  return (
    serializeStatusBlock({
      area,
      status,
      steps_done: done,
      steps_total: total,
      plan_ref: opts.planRef ?? `rounds/${round}/plan.md`,
    }) + (opts.body ?? "1. Ask #1 — done.\n")
  );
}

/** Root with mesh.json, goal.md (unless goal === null), and r001 recon briefs. */
export async function makeRoot(
  dir: string,
  opts: { goal?: string | null; round?: string; reconAreas?: string[] } = {},
): Promise<void> {
  const p = meshPaths(dir);
  await atomicWrite(
    p.meshJson,
    `${JSON.stringify({ protocol: 1, created: "2026-07-06T00:00:00Z", tool: "relay-mesh@test" })}\n`,
  );
  if (opts.goal !== null) await atomicWrite(p.goal, `${opts.goal ?? "Test goal"}\n`);
  const rp = p.round(opts.round ?? "r001");
  for (const area of opts.reconAreas ?? RECON_AREAS) {
    const pairDir = rp.reconPair(`recon-${area}`);
    await atomicWrite(rp.brief(pairDir, area), `# Recon brief: ${area}\n`);
  }
}

/** Bare round dir (fix rounds have no recon unless asked for). */
export async function addRound(
  dir: string,
  round: string,
  opts: { reconAreas?: string[] } = {},
): Promise<void> {
  const rp = meshPaths(dir).round(round);
  await mkdir(rp.dir, { recursive: true });
  for (const area of opts.reconAreas ?? []) {
    const pairDir = rp.reconPair(`recon-${area}`);
    await atomicWrite(rp.brief(pairDir, area), `# Recon brief: ${area}\n`);
  }
}

export async function addReconReport(dir: string, area: string, opts: ReportOpts = {}): Promise<void> {
  const rp = meshPaths(dir).round(opts.round ?? "r001");
  const pairDir = rp.reconPair(`recon-${area}`);
  await atomicWrite(rp.report(pairDir, area), reportMd(area, opts));
}

/** Writes plan.md and returns its sha256 hex. */
export async function addPlan(dir: string, opts: { round?: string; content?: string } = {}): Promise<string> {
  const content =
    opts.content ??
    "# Plan\n\n## Domain brief: backend\n…\n\n## Domain brief: frontend\n…\n\n## Domain brief: infra\n…\n";
  await atomicWrite(meshPaths(dir).round(opts.round ?? "r001").plan, content);
  return createHash("sha256").update(content).digest("hex");
}

/** Writes roster.json + roster.approval.json (approved unless overridden). */
export async function addRoster(
  dir: string,
  opts: {
    round?: string;
    decision?: "approved" | "rejected";
    execAreas?: string[];
    rosterSha256?: string;
  } = {},
): Promise<void> {
  const round = opts.round ?? "r001";
  const rp = meshPaths(dir).round(round);
  const execAreas = opts.execAreas ?? EXEC_AREAS;
  const roster = {
    version: 1,
    execute: execAreas.map((a) => ({
      domain: a,
      template: `exec-${a}`,
      count: 1,
      modelEnv: `${a.toUpperCase()}_MODEL`,
      effort: "low",
    })),
  };
  const raw = `${JSON.stringify(roster, null, 2)}\n`;
  await atomicWrite(rp.roster, raw);
  const decision = opts.decision ?? "approved";
  const sha = opts.rosterSha256 ?? createHash("sha256").update(raw).digest("hex");
  await atomicWrite(
    rp.rosterApproval,
    `${JSON.stringify({ decision, by: "test@host", at: "2026-07-06T00:00:00Z", roster_sha256: sha, notes: "" })}\n`,
  );
}

/**
 * Writes plan.approval.json (sha of current plan.md unless overridden) and, when
 * approved, exec briefs plus an approved roster (so state reaches "executing").
 * Pass roster:false to stop at gate #2 (phase "awaiting-roster").
 */
export async function addApproval(
  dir: string,
  opts: {
    round?: string;
    decision?: "approved" | "rejected";
    planSha256?: string;
    execAreas?: string[];
    roster?: boolean;
    rosterSha256?: string;
  } = {},
): Promise<void> {
  const round = opts.round ?? "r001";
  const rp = meshPaths(dir).round(round);
  const decision = opts.decision ?? "approved";
  const sha =
    opts.planSha256 ??
    createHash("sha256")
      .update((await safeRead(rp.plan)) ?? "")
      .digest("hex");
  await atomicWrite(
    rp.approval,
    `${JSON.stringify({ decision, by: "test@host", at: "2026-07-06T00:00:00Z", plan_sha256: sha, notes: "" })}\n`,
  );
  if (decision === "approved") {
    for (const area of opts.execAreas ?? EXEC_AREAS) {
      const pairDir = rp.execPair(area);
      await atomicWrite(rp.brief(pairDir, area), `# Execution brief: ${area}\n`);
    }
    if (opts.roster ?? true) {
      await addRoster(dir, { round, execAreas: opts.execAreas, rosterSha256: opts.rosterSha256 });
    }
  }
}

export async function addExecReport(dir: string, area: string, opts: ReportOpts = {}): Promise<void> {
  const rp = meshPaths(dir).round(opts.round ?? "r001");
  const pairDir = rp.execPair(area);
  await atomicWrite(rp.report(pairDir, area), reportMd(area, opts));
}

export async function addRollup(dir: string, opts: { round?: string; content?: string } = {}): Promise<void> {
  const rp = meshPaths(dir).round(opts.round ?? "r001");
  await atomicWrite(rp.rollup, opts.content ?? "# Roll-up\n\nAll areas terminal.\n");
}

export async function addVerdict(
  dir: string,
  opts: { round?: string; satisfied?: boolean; gaps?: { area: string; description: string }[] } = {},
): Promise<void> {
  const rp = meshPaths(dir).round(opts.round ?? "r001");
  await atomicWrite(
    rp.verdictJson,
    `${JSON.stringify({ satisfied: opts.satisfied ?? true, gaps: opts.gaps ?? [], generated: "2026-07-06T00:00:00Z" })}\n`,
  );
  await atomicWrite(rp.verdictMd, "Verdict rationale.\n");
}
