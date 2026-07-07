import { createHash } from "node:crypto";
import { join } from "node:path";
import { listVisible, safeRead } from "./fsio.js";
import { meshPaths, type MeshPaths } from "./paths.js";
import { parseReport, type Status } from "./report.js";

export type Phase =
  | "idle"
  | "recon"
  | "synthesis"
  | "awaiting-approval"
  | "replanning"
  | "executing"
  | "rollup"
  | "verifying"
  | "fix-planning"
  | "done";

export interface PairState {
  pair: string;
  area: string;
  hasBrief: boolean;
  hasReport: boolean;
  status: Status | null; // null = no report or status block does not parse (not authoritative)
}

export interface RunState {
  root: string;
  round: string | null;
  phase: Phase;
  recon: PairState[];
  exec: PairState[];
  approval: { decision: "approved" | "rejected"; planSha256: string } | null;
  planSha256: string | null;
  verdict: { satisfied: boolean } | null;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * The one area-derivation rule for a pair dir: brief filename, else report
 * filename, else the pair-name tail (recon- prefix stripped for recon pairs).
 * Every reader (deriveState, status/watch tables, approve) must share it.
 */
export function areaOf(pairName: string, files: string[], recon: boolean): string {
  const brief = files.find((f) => f.endsWith(".brief.md"));
  if (brief) return brief.slice(0, -".brief.md".length);
  const report = files.find((f) => f.endsWith(".report.md"));
  if (report) return report.slice(0, -".report.md".length);
  const tail = pairName.replace(/^.*__/, "");
  return recon ? tail.replace(/^recon-/, "") : tail;
}

async function readPairs(parentDir: string, recon: boolean): Promise<PairState[]> {
  const pairs: PairState[] = [];
  for (const name of await listVisible(parentDir)) {
    if (!name.includes("__")) continue; // pair dirs are always <from>__<to>
    const pairDir = join(parentDir, name);
    const files = await listVisible(pairDir);
    const area = areaOf(name, files, recon);
    const reportName = `${area}.report.md`;
    const hasReport = files.includes(reportName);
    let status: Status | null = null;
    if (hasReport) {
      const md = await safeRead(join(pairDir, reportName));
      status = md === null ? null : (parseReport(md).status?.status ?? null);
    }
    pairs.push({
      pair: name,
      area,
      hasBrief: files.some((f) => f.endsWith(".brief.md")),
      hasReport,
      status,
    });
  }
  return pairs;
}

async function readApproval(
  path: string,
): Promise<{ decision: "approved" | "rejected"; planSha256: string } | null> {
  const raw = await safeRead(path);
  if (raw === null) return null;
  try {
    const j = JSON.parse(raw) as { decision?: unknown; plan_sha256?: unknown };
    if ((j.decision === "approved" || j.decision === "rejected") && typeof j.plan_sha256 === "string") {
      return { decision: j.decision, planSha256: j.plan_sha256 };
    }
  } catch {
    // unparseable => treat as absent
  }
  return null;
}

async function readVerdict(path: string): Promise<{ satisfied: boolean } | null> {
  const raw = await safeRead(path);
  if (raw === null) return null;
  try {
    const j = JSON.parse(raw) as { satisfied?: unknown };
    if (typeof j.satisfied === "boolean") return { satisfied: j.satisfied };
  } catch {
    // unparseable => treat as absent
  }
  return null;
}

async function roundState(paths: MeshPaths, r: string): Promise<RunState> {
  const rp = paths.round(r);
  const recon = await readPairs(join(rp.dir, "recon"), true);
  const exec = await readPairs(join(rp.dir, "exec"), false);
  const planMd = await safeRead(rp.plan);
  const planSha256 = planMd === null ? null : sha256(planMd);
  const approval = await readApproval(rp.approval);
  const verdict = await readVerdict(rp.verdictJson);
  const rollup = await safeRead(rp.rollup);

  // "Terminal" for an exec pair: a parseable report exists, any status.
  const execDone = exec.length > 0 && exec.every((p) => p.status !== null);

  const phase = ((): Phase => {
    if (recon.some((p) => p.status === null)) return "recon";
    if (planMd === null) return "synthesis";
    if (approval === null) return "awaiting-approval";
    if (approval.decision === "rejected") return "replanning";
    if (approval.planSha256 === planSha256 && !execDone) return "executing";
    if (execDone && rollup === null) return "rollup";
    if (rollup !== null && verdict === null) return "verifying";
    if (verdict?.satisfied === true) return "done";
    return "fix-planning";
  })();

  return { root: paths.root, round: r, phase, recon, exec, approval, planSha256, verdict };
}

/** Pure function of the filesystem — the phase machine table in docs/protocol.md. */
export async function deriveState(root: string): Promise<RunState> {
  const paths = meshPaths(root);
  const empty: RunState = {
    root,
    round: null,
    phase: "idle",
    recon: [],
    exec: [],
    approval: null,
    planSha256: null,
    verdict: null,
  };

  if ((await safeRead(paths.goal)) === null) return empty;

  const rounds = (await listVisible(paths.roundsDir))
    .filter((n) => /^r\d{3,}$/.test(n))
    .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  if (rounds.length === 0) return { ...empty, phase: "recon" };

  for (let i = 0; i < rounds.length; i++) {
    const state = await roundState(paths, rounds[i]!);
    // The recursion row: fall through to rNNN+1 only when this round is terminal-but-unsatisfied.
    if (state.phase === "fix-planning" && i < rounds.length - 1) continue;
    return state;
  }
  /* unreachable: the loop always returns on the last round */
  throw new Error("deriveState: no rounds evaluated");
}
