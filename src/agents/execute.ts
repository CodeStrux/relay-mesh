/** Execution phase: approved plan → exec pair briefs → parallel executors → artifacts + reports. */
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { bundleForExecutor, extractPathHints } from "../context.js";
import { extractArtifacts, writeArtifacts } from "../relay/artifacts.js";
import { rollupPair } from "../relay/closure.js";
import { atomicWrite, listVisible, safeRead } from "../relay/fsio.js";
import { meshPaths } from "../relay/paths.js";
import { parseReport, serializeStatusBlock } from "../relay/report.js";
import type { WorkerSpec } from "../relay/roster.js";
import { deriveState } from "../relay/state.js";
import { callProfile, type CallCtx } from "./call.js";
import { findLatestReconReport } from "./recon.js";

/** Plan edited after approval — commands map this to exit 1. */
export class ApprovalMismatchError extends Error {
  constructor(round: string) {
    super(
      [
        `plan.approval.json for ${round} pins a different sha256 than the current plan.md`,
        "the plan was edited after approval, so the approved briefs can no longer be trusted",
        "re-approve the plan (approve command), then run execute again",
      ].join("\n"),
    );
    this.name = "ApprovalMismatchError";
  }
}

/** Roster edited after approval — commands map this to exit 1. */
export class RosterMismatchError extends Error {
  constructor(round: string) {
    super(
      [
        `roster.approval.json for ${round} pins a different sha256 than the current roster.json`,
        "the roster was edited after approval, so the approved fleet can no longer be trusted",
        "re-approve the roster (roster command), then run execute again",
      ].join("\n"),
    );
    this.name = "RosterMismatchError";
  }
}

/** Recursive listing of visible files under dir (protocol rules: no dotfiles, no *.part). */
export async function listFilesRecursive(
  dir: string,
  prefix = "",
): Promise<{ rel: string; size: number }[]> {
  const out: { rel: string; size: number }[] = [];
  for (const name of await listVisible(dir)) {
    const full = join(dir, name);
    const s = await stat(full);
    if (s.isDirectory()) out.push(...(await listFilesRecursive(full, `${prefix}${name}/`)));
    else out.push({ rel: `${prefix}${name}`, size: s.size });
  }
  return out;
}

/** One-line-per-file listing of a round's whole workspace/ tree. */
export async function workspaceListing(root: string, round: string): Promise<string> {
  const files = await listFilesRecursive(join(meshPaths(root).round(round).dir, "workspace"));
  return files.length ? files.map((f) => `${f.rel} (${f.size}B)`).join("\n") : "(empty)";
}

/** Fixed protocol preamble prepended to every verbatim domain brief. */
export function briefPreamble(area: string, round: string, shard?: number): string {
  const pair = shard === undefined ? `planner__${area}` : `planner__${area}__w${shard}`;
  return `# Execution brief: ${area} — round ${round}${shard === undefined ? "" : ` (shard ${shard})`}

Report to: \`rounds/${round}/exec/${pair}/${area}.report.md\`

Your report MUST open with this exact status block — first line \`---\`, flat \`key: value\` lines, closed by \`---\`:

\`\`\`yaml
---
area: ${area}
status: complete        # complete | partial | blocked
steps_done: <asks done>
steps_total: <asks in this brief>
plan_ref: rounds/${round}/plan.md
---
\`\`\`

Your ENTIRE output must be the executor wire format: zero or more
\`=== FILE: <relative/path> ===\` … \`=== END ===\` blocks (complete files only,
paths relative to your area workspace), then exactly one \`=== REPORT ===\`
section containing the status block and your numbered answers.

---

`;
}

function synthPartialReport(
  area: string,
  planRef: string,
  round: string,
  problems: string[],
  shard?: number,
): string {
  const rawPath = `rounds/${round}/workspace/${area}${shard === undefined ? "" : `/w${shard}`}/raw.md`;
  return (
    serializeStatusBlock({
      area,
      status: "partial",
      steps_done: 0,
      steps_total: 0,
      plan_ref: planRef,
    }) +
    `\nExecutor output failed to parse cleanly after one corrective re-prompt; the verbatim output is preserved at ${rawPath}.\n\nParse problems:\n${problems.map((p) => `- ${p}`).join("\n")}\n`
  );
}

function synthBlockedReport(area: string, planRef: string, err: unknown): string {
  return (
    serializeStatusBlock({
      area,
      status: "blocked",
      steps_done: 0,
      steps_total: 0,
      plan_ref: planRef,
    }) +
    `\nThe executor call failed before producing a report; the pair is held for operator attention.\n\nLiteral error:\n\n\`\`\`\n${String(err)}\n\`\`\`\n`
  );
}

/** Where execute found (or failed to find) the project checkout. */
export interface ProjectRef {
  path: string | null;
  note: string | null; // shown to the executor when path is null
}

const NARROW_BLOCK_GUIDANCE =
  "For any ask that requires modifying an existing file you cannot see, report THAT ask as blocked and name the exact relative path you need; asks that only create new files can proceed.";

/**
 * The `## Source files (current contents)` section: full bytes of every project
 * file the corpus references (brief, goal, recon report, prior-round reports —
 * so a prior blocked report naming a file guarantees it appears this round), or
 * an explicit none-available note so the model blocks narrowly instead of
 * fabricating.
 */
async function sourceFilesSection(
  project: ProjectRef,
  corpus: string[],
  caps: { perFileBytes: number; totalBytes: number },
  area: string,
): Promise<string> {
  const heading = "## Source files (current contents)";
  if (project.path === null) {
    const note = project.note ?? "No project was linked at plan time.";
    return `${heading}\n\nNone available: ${note} ${NARROW_BLOCK_GUIDANCE}`;
  }
  const bundle = await bundleForExecutor(project.path, extractPathHints(corpus), caps, area);
  return `${heading}\n\nComplete current contents of project files referenced by your brief — treat them as the exact on-disk state and base your replacement files on them. ${NARROW_BLOCK_GUIDANCE}\n\n${bundle.text}`;
}

/**
 * This area's exec reports from every prior round, most-recent last. A blocked
 * report names the exact files the executor needs; feeding all prior rounds (not
 * just N-1) means the path survives a round where the area sits out the fix, so
 * the loop converges instead of forgetting.
 */
async function priorAreaReports(root: string, round: string, area: string): Promise<string> {
  const n = Number(round.slice(1));
  const parts: string[] = [];
  for (let i = 1; i < n; i++) {
    const rp = meshPaths(root).round(`r${String(i).padStart(3, "0")}`);
    const md = await safeRead(rp.report(rp.execPair(area), area));
    if (md !== null) parts.push(md);
  }
  return parts.join("\n\n");
}

/** Prior-round context for fix rounds: reports, verdict, and workspace listing. */
async function priorRoundContext(
  root: string,
  round: string,
): Promise<{ workspaceListing: string; text: string } | null> {
  const n = Number(round.slice(1));
  if (n <= 1) return null;
  const prior = `r${String(n - 1).padStart(3, "0")}`;
  const rp = meshPaths(root).round(prior);

  const parts: string[] = [];
  const execDir = join(rp.dir, "exec");
  for (const pair of await listVisible(execDir)) {
    const files = (await listVisible(join(execDir, pair))).filter((f) =>
      f.endsWith(".report.md"),
    );
    for (const name of files) {
      const md = await safeRead(join(execDir, pair, name));
      if (md !== null) parts.push(`## Prior report (${prior}): ${pair}/${name}\n\n${md}`);
    }
  }
  const verdictJson = await safeRead(rp.verdictJson);
  const verdictMd = await safeRead(rp.verdictMd);
  if (verdictJson !== null) {
    parts.push(`## Prior verdict (${prior})\n\n${verdictJson}\n${verdictMd ?? ""}`);
  }
  return { workspaceListing: await workspaceListing(root, prior), text: parts.join("\n\n") };
}

/**
 * Verify the approval hash, then run every roster-expanded worker (optionally
 * filtered by areas) in parallel. Each worker mints its brief from the pinned
 * roster's verbatim domain brief. Malformed output earns ONE corrective
 * re-prompt, then raw.md salvage with a synthesized partial report; a rejected
 * call becomes a blocked report. Pairs with a parseable report are skipped
 * (resume). Closure rolls per pair.
 */
export async function runExecute(
  ctx: CallCtx,
  workers: WorkerSpec[],
  args: { root: string; goal: string; areas?: string[]; project?: ProjectRef },
): Promise<void> {
  const rp = meshPaths(args.root).round(ctx.round);
  const planMd = await safeRead(rp.plan);
  if (planMd === null) {
    throw new Error(
      [
        `rounds/${ctx.round}/plan.md not found`,
        "execute runs the fleet the roster gate approved",
        "run plan, approve, and roster first",
      ].join("\n"),
    );
  }

  const state = await deriveState(args.root);
  if (state.approval === null || state.approval.decision !== "approved") {
    throw new Error(
      [
        `no approval for rounds/${ctx.round}/plan.md`,
        "execute only runs an approved plan",
        "run the approve command first",
      ].join("\n"),
    );
  }
  if (state.approval.planSha256 !== state.planSha256) throw new ApprovalMismatchError(ctx.round);

  const targets = workers.filter((w) => !args.areas || args.areas.includes(w.area));
  const prior = await priorRoundContext(args.root, ctx.round);

  // A recorded path may not exist on this box (multi-machine runs): degrade to
  // an explicit note the executor sees, never a crash.
  let project: ProjectRef = args.project ?? { path: null, note: null };
  if (project.path !== null) {
    try {
      await stat(project.path);
    } catch {
      project = {
        path: null,
        note: `project path ${project.path} is not accessible on this machine.`,
      };
    }
  }
  const caps = { perFileBytes: ctx.config.execFileBytes, totalBytes: ctx.config.execBundleBytes };

  const results = await Promise.allSettled(
    targets.map(async (w) => {
      const area = w.area;
      const shard = w.shardCount === 1 ? undefined : w.shardIndex;
      const pairDir = rp.execPair(area, shard);
      const reportPath = rp.report(pairDir, area);
      const planRef = `rounds/${ctx.round}/plan.md`;

      // Resume: a pair whose report parses is terminal — never re-run it.
      const existing = await safeRead(reportPath);
      if (existing !== null && parseReport(existing).status !== null) {
        await rollupPair(pairDir);
        return;
      }

      const brief = briefPreamble(area, ctx.round, shard) + w.briefBody + "\n";
      await atomicWrite(rp.brief(pairDir, area), brief);

      const recon = await findLatestReconReport(args.root, area);
      // Extraction corpus in budget-priority order: the brief's asks, then the
      // files prior blocked reports named (the recovery target must outrank a
      // big recon file for the byte budget), then goal, then recon.
      const priorReports = await priorAreaReports(args.root, ctx.round, area);
      const sections = [
        brief,
        `## Goal\n\n${args.goal}`,
        `## Recon report: ${area}\n\n${recon ?? "No recon report exists for this area."}`,
        await sourceFilesSection(
          project,
          [brief, priorReports, args.goal, recon ?? ""],
          caps,
          area,
        ),
        `## Workspace listing${prior ? " (prior round)" : ""}\n\n${
          prior ? prior.workspaceListing : await workspaceListing(args.root, ctx.round)
        }`,
      ];
      if (prior && prior.text) sections.push(prior.text);
      const vars = {
        GOAL: args.goal,
        ROUND: ctx.round,
        AREA: area,
        REPORT_PATH: `rounds/${ctx.round}/exec/${w.pairName}/${area}.report.md`,
      };

      try {
        // The wire output streams only to the report's .part (liveness): a raw
        // dump can open with a bare status block and parse as a report, so it
        // must never be published verbatim — the pair stays in-flight until the
        // real report lands below (publish: false).
        let output = await callProfile(
          ctx,
          w.profile,
          [{ type: "text", text: sections.join("\n\n") }],
          reportPath,
          vars,
          { publish: false },
        );
        let res = extractArtifacts(output);
        // ANY parse problem (missing report, unterminated or rejected FILE
        // blocks) earns the ONE corrective re-prompt the protocol guarantees.
        if (res.reportMd === null || res.problems.length > 0) {
          // Salvage the first attempt before re-prompting: its parsed FILE
          // blocks land in the workspace and raw.md keeps the verbatim text,
          // so a report-only corrective answer never loses tokens.
          await writeArtifacts(res, rp.workspace(area, shard), output);
          const corrective = [
            sections.join("\n\n"),
            "## Correction required",
            `Your previous output could not be parsed: ${res.problems.join("; ")}.`,
            "Re-emit your ENTIRE response in the wire format: zero or more `=== FILE: <path> ===` … `=== END ===` blocks (each closed by `=== END ===`), then exactly one `=== REPORT ===` section whose first line is `---` (the status block).",
          ].join("\n\n");
          output = await callProfile(
            ctx,
            w.profile,
            [{ type: "text", text: corrective }],
            reportPath,
            vars,
            { publish: false },
          );
          res = extractArtifacts(output);
        }
        await writeArtifacts(res, rp.workspace(area, shard), output);
        await atomicWrite(
          reportPath,
          res.reportMd !== null && res.problems.length === 0
            ? res.reportMd
            : synthPartialReport(area, planRef, ctx.round, res.problems, shard),
        );
      } catch (err) {
        await atomicWrite(reportPath, synthBlockedReport(area, planRef, err));
      }
      await rollupPair(pairDir);
    }),
  );

  // Rejected LLM calls became blocked reports above; anything still rejected is a real bug.
  const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failed) throw failed.reason;
}
