/** Verification: verdict.json/.md from ONE verifier call, plus fix-round scaffolding. */
import { join } from "node:path";
import { z } from "zod";
import type { Profile } from "../profiles.js";
import { atomicWrite, listVisible, safeRead } from "../relay/fsio.js";
import { meshPaths } from "../relay/paths.js";
import { areaOf } from "../relay/state.js";
import { callProfile, type CallCtx } from "./call.js";
import { listFilesRecursive, workspaceListing } from "./execute.js";
import { findLatestReconReport } from "./recon.js";

export interface VerdictGap {
  area: string;
  description: string;
}

export interface Verdict {
  satisfied: boolean;
  gaps: VerdictGap[];
}

const gapSchema = z.strictObject({
  area: z.string().min(1),
  description: z.string().min(1),
});

const verdictSchema = z
  .strictObject({ satisfied: z.boolean(), gaps: z.array(gapSchema) })
  .refine((v) => !v.satisfied || v.gaps.length === 0, {
    message: "satisfied must be false when gaps is non-empty",
  });

// Loose variant for reading verdict.json back (it carries a "generated" key).
const storedVerdictSchema = z.object({ satisfied: z.boolean(), gaps: z.array(gapSchema) });

const FILE_SAMPLE_TOTAL = 8_192;
const FILE_SAMPLE_EACH = 2_048;

function parseVerdict(output: string): { verdict: Verdict | null; problem: string } {
  const fences = [...output.matchAll(/```json\s*\n([\s\S]*?)```/g)];
  if (fences.length === 0) return { verdict: null, problem: "no ```json fence found" };
  // The prompt demands exactly one fence with nothing after it; take the last defensively.
  const raw = fences[fences.length - 1]![1]!;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    return { verdict: null, problem: `fence is not valid JSON — ${(err as Error).message}` };
  }
  const parsed = verdictSchema.safeParse(json);
  if (!parsed.success) {
    return {
      verdict: null,
      problem: parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; "),
    };
  }
  return { verdict: parsed.data, problem: "" };
}

/** Heads of workspace files, ~8KB total, so the verifier sees actual artifacts. */
async function fileSamples(root: string, round: string): Promise<string> {
  const wsDir = join(meshPaths(root).round(round).dir, "workspace");
  const files = await listFilesRecursive(wsDir);
  let budget = FILE_SAMPLE_TOTAL;
  const parts: string[] = [];
  for (const f of files) {
    if (budget <= 0) break;
    const content = await safeRead(join(wsDir, f.rel));
    if (content === null) continue;
    const sample = content.slice(0, Math.min(FILE_SAMPLE_EACH, budget));
    budget -= sample.length;
    parts.push(
      `### ${f.rel}${sample.length < content.length ? " (truncated)" : ""}\n\`\`\`\n${sample}\n\`\`\``,
    );
  }
  return parts.length ? parts.join("\n\n") : "(no workspace files)";
}

/**
 * One verifier call over goal, plan, vision recon report, executor reports,
 * closures, roll-up, workspace listing, and size-capped file samples. The json
 * fence is zod-validated with ONE repair re-prompt; a still-unparseable output
 * becomes a synthesized unsatisfied verdict. Writes verdict.json + verdict.md.
 */
export async function runVerify(
  ctx: CallCtx,
  verifier: Profile,
  args: { root: string; goal: string },
): Promise<Verdict> {
  const rp = meshPaths(args.root).round(ctx.round);

  const sections: string[] = [`## Goal\n\n${args.goal}`];
  sections.push(`## Approved plan\n\n${(await safeRead(rp.plan)) ?? "(missing)"}`);
  const vision = await findLatestReconReport(args.root, "vision");
  sections.push(`## Vision recon report\n\n${vision ?? "(no vision recon report)"}`);

  const execDir = join(rp.dir, "exec");
  for (const pair of await listVisible(execDir)) {
    if (!pair.includes("__")) continue;
    const files = await listVisible(join(execDir, pair));
    const area = areaOf(pair, files, false); // shard-aware (planner__<area>__w<i> → <area>)
    const report = await safeRead(join(execDir, pair, `${area}.report.md`));
    const closure = await safeRead(join(execDir, pair, "closure.json"));
    sections.push(
      `## Executor report: ${pair} (${area})\n\n${report ?? "(no report)"}\n\n### closure.json\n\n${closure ?? "(missing)"}`,
    );
  }
  sections.push(`## Monitor roll-up\n\n${(await safeRead(rp.rollup)) ?? "(missing)"}`);
  sections.push(`## Workspace listing\n\n${await workspaceListing(args.root, ctx.round)}`);
  sections.push(
    `## Workspace file samples (size-capped)\n\n${await fileSamples(args.root, ctx.round)}`,
  );

  const vars = { GOAL: args.goal, ROUND: ctx.round };
  // The raw verifier output (assessment prose + verdict fence) IS verdict.md.
  let output = await callProfile(
    ctx,
    verifier,
    [{ type: "text", text: sections.join("\n\n") }],
    rp.verdictMd,
    vars,
  );
  let { verdict, problem } = parseVerdict(output);
  if (verdict === null) {
    const repair = [
      sections.join("\n\n"),
      "## Repair required",
      `Your previous verdict failed validation: ${problem}.`,
      'Re-emit your ENTIRE response: the `## Assessment` prose, then `## Verdict` with exactly one ```json fence containing only {"satisfied": boolean, "gaps": [{"area": string, "description": string}]}. `satisfied` must be false when `gaps` is non-empty. Nothing after the closing fence.',
    ].join("\n\n");
    output = await callProfile(
      ctx,
      verifier,
      [{ type: "text", text: repair }],
      rp.verdictMd,
      vars,
    );
    ({ verdict } = parseVerdict(output));
  }
  if (verdict === null) {
    verdict = {
      satisfied: false,
      gaps: [{ area: "verify", description: "verifier output unparseable — see verdict.md" }],
    };
  }

  const generated = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  await atomicWrite(
    rp.verdictJson,
    `${JSON.stringify({ satisfied: verdict.satisfied, gaps: verdict.gaps, generated })}\n`,
  );
  return verdict;
}

/**
 * Planner call over the verdict's gaps + the prior round's workspace listing
 * → rounds/rNNN+1/plan.md (which re-arms the human approval gate).
 * Returns the new round name. Idempotent: an already-scaffolded fix plan is kept.
 */
export async function scaffoldFixRound(
  ctx: CallCtx,
  planner: Profile,
  args: { root: string; goal: string },
): Promise<string> {
  const paths = meshPaths(args.root);
  const cur = paths.round(ctx.round);

  const verdictRaw = await safeRead(cur.verdictJson);
  if (verdictRaw === null) {
    throw new Error(
      [
        `rounds/${ctx.round}/verify/verdict.json not found`,
        "a fix round is scaffolded from the verifier's gaps",
        "run verify first",
      ].join("\n"),
    );
  }
  let stored: z.infer<typeof storedVerdictSchema>;
  try {
    stored = storedVerdictSchema.parse(JSON.parse(verdictRaw));
  } catch (err) {
    throw new Error(
      [
        `rounds/${ctx.round}/verify/verdict.json does not parse: ${String(err)}`,
        "a fix round is scaffolded from the verifier's gaps",
        "re-run verify to regenerate the verdict",
      ].join("\n"),
    );
  }
  if (stored.satisfied) {
    throw new Error(
      [
        `rounds/${ctx.round} verdict is satisfied`,
        "there are no gaps to plan a fix round from",
        "nothing to do — the run is done",
      ].join("\n"),
    );
  }

  // The fix round is always current+1 (rounds are append-only and contiguous).
  const next = `r${String(Number(ctx.round.slice(1)) + 1).padStart(3, "0")}`;
  const nextRp = paths.round(next);
  if ((await safeRead(nextRp.plan)) !== null) return next; // already scaffolded (resume)

  const gapsText = stored.gaps.map((g, i) => `${i + 1}. [${g.area}] ${g.description}`).join("\n");
  const text = [
    `## Goal\n\n${args.goal}`,
    `## Verifier verdict — round ${ctx.round}\n\nThe round did not satisfy the goal. This is a fix round: plan ONLY the remediation of these gaps.\n\n${gapsText}`,
    `## Prior workspace listing (round ${ctx.round})\n\n${await workspaceListing(args.root, ctx.round)}`,
  ].join("\n\n");

  const fixCtx: CallCtx = { ...ctx, round: next, stage: "recon", transcriptsDir: nextRp.transcriptsDir };
  await callProfile(fixCtx, planner, [{ type: "text", text }], nextRp.plan, {
    GOAL: args.goal,
    ROUND: next,
  });
  return next;
}
