/** Execution phase: approved plan → exec pair briefs → parallel executors → artifacts + reports. */
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { Profile } from "../profiles.js";
import { extractArtifacts, writeArtifacts } from "../relay/artifacts.js";
import { rollupPair } from "../relay/closure.js";
import { atomicWrite, listVisible, safeRead } from "../relay/fsio.js";
import { meshPaths } from "../relay/paths.js";
import { parseReport, serializeStatusBlock } from "../relay/report.js";
import { deriveState } from "../relay/state.js";
import { callProfile, type CallCtx } from "./call.js";
import { extractDomainBriefs } from "./plan.js";
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
export function briefPreamble(area: string, round: string): string {
  return `# Execution brief: ${area} — round ${round}

Report to: \`rounds/${round}/exec/planner__${area}/${area}.report.md\`

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
): string {
  return (
    serializeStatusBlock({
      area,
      status: "partial",
      steps_done: 0,
      steps_total: 0,
      plan_ref: planRef,
    }) +
    `\nExecutor output failed to parse cleanly after one corrective re-prompt; the verbatim output is preserved at rounds/${round}/workspace/${area}/raw.md.\n\nParse problems:\n${problems.map((p) => `- ${p}`).join("\n")}\n`
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
 * Verify the approval hash, extract domain briefs verbatim, then run every
 * executor whose area has a brief (optionally filtered by areas) in parallel.
 * Malformed output earns ONE corrective re-prompt, then raw.md salvage with a
 * synthesized partial report; a rejected call becomes a blocked report.
 * Pairs with a parseable report are skipped (resume). Closure rolls per pair.
 */
export async function runExecute(
  ctx: CallCtx,
  executorProfiles: Profile[],
  args: { root: string; goal: string; areas?: string[] },
): Promise<void> {
  const rp = meshPaths(args.root).round(ctx.round);
  const planMd = await safeRead(rp.plan);
  if (planMd === null) {
    throw new Error(
      [
        `rounds/${ctx.round}/plan.md not found`,
        "execute extracts its briefs from an approved plan",
        "run plan and approve first",
      ].join("\n"),
    );
  }

  const state = await deriveState(args.root);
  if (state.approval === null || state.approval.decision !== "approved") {
    throw new Error(
      [
        `no approval for rounds/${ctx.round}/plan.md`,
        "execute only runs briefs extracted from an approved plan",
        "run the approve command first",
      ].join("\n"),
    );
  }
  if (state.approval.planSha256 !== state.planSha256) throw new ApprovalMismatchError(ctx.round);

  const briefs = extractDomainBriefs(planMd);
  const targets = executorProfiles.filter(
    (p): p is Profile & { area: string } =>
      p.area !== undefined && briefs.has(p.area) && (!args.areas || args.areas.includes(p.area)),
  );
  const prior = await priorRoundContext(args.root, ctx.round);

  const results = await Promise.allSettled(
    targets.map(async (profile) => {
      const area = profile.area;
      const pairDir = rp.execPair(area);
      const reportPath = rp.report(pairDir, area);
      const planRef = `rounds/${ctx.round}/plan.md`;

      // Resume: a pair whose report parses is terminal — never re-run it.
      const existing = await safeRead(reportPath);
      if (existing !== null && parseReport(existing).status !== null) {
        await rollupPair(pairDir);
        return;
      }

      const brief = briefPreamble(area, ctx.round) + briefs.get(area)! + "\n";
      await atomicWrite(rp.brief(pairDir, area), brief);

      const recon = await findLatestReconReport(args.root, area);
      const sections = [
        brief,
        `## Goal\n\n${args.goal}`,
        `## Recon report: ${area}\n\n${recon ?? "No recon report exists for this area."}`,
        `## Workspace listing${prior ? " (prior round)" : ""}\n\n${
          prior ? prior.workspaceListing : await workspaceListing(args.root, ctx.round)
        }`,
      ];
      if (prior && prior.text) sections.push(prior.text);
      const vars = {
        GOAL: args.goal,
        ROUND: ctx.round,
        AREA: area,
        REPORT_PATH: `rounds/${ctx.round}/exec/planner__${area}/${area}.report.md`,
      };

      try {
        // The wire output streams only to the report's .part (liveness): a raw
        // dump can open with a bare status block and parse as a report, so it
        // must never be published verbatim — the pair stays in-flight until the
        // real report lands below (publish: false).
        let output = await callProfile(
          ctx,
          profile,
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
          await writeArtifacts(res, rp.workspace(area), output);
          const corrective = [
            sections.join("\n\n"),
            "## Correction required",
            `Your previous output could not be parsed: ${res.problems.join("; ")}.`,
            "Re-emit your ENTIRE response in the wire format: zero or more `=== FILE: <path> ===` … `=== END ===` blocks (each closed by `=== END ===`), then exactly one `=== REPORT ===` section whose first line is `---` (the status block).",
          ].join("\n\n");
          output = await callProfile(
            ctx,
            profile,
            [{ type: "text", text: corrective }],
            reportPath,
            vars,
            { publish: false },
          );
          res = extractArtifacts(output);
        }
        await writeArtifacts(res, rp.workspace(area), output);
        await atomicWrite(
          reportPath,
          res.reportMd !== null && res.problems.length === 0
            ? res.reportMd
            : synthPartialReport(area, planRef, ctx.round, res.problems),
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
