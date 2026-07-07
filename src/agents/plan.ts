/** Synthesis phase: one planner call over goal + recon reports → rounds/rX/plan.md. */
import { join } from "node:path";
import type { Profile } from "../profiles.js";
import { atomicWrite, listVisible, safeRead } from "../relay/fsio.js";
import { meshPaths } from "../relay/paths.js";
import { callProfile, type CallCtx } from "./call.js";

const BRIEF_HEADING = /^##\s+Domain brief:\s*(.+?)\s*$/;
const MAX_BRIEF_WORDS = 900;

/**
 * Deterministic, verbatim extraction of "## Domain brief: <area>" sections
 * (heading line through the line before the next level-2 heading). This is the
 * only path from approved plan to execution briefs — no LLM in between.
 */
export function extractDomainBriefs(planMd: string): Map<string, string> {
  const lines = planMd.split("\n");
  const briefs = new Map<string, string>();
  let area: string | null = null;
  let start = 0;
  const flush = (end: number): void => {
    if (area !== null) briefs.set(area, lines.slice(start, end).join("\n"));
  };
  for (let i = 0; i < lines.length; i++) {
    const m = BRIEF_HEADING.exec(lines[i]!);
    if (m) {
      flush(i);
      area = m[1]!;
      start = i;
      continue;
    }
    if (area !== null && /^##\s/.test(lines[i]!)) {
      flush(i);
      area = null;
    }
  }
  flush(lines.length);
  return briefs;
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/** Deterministic lint: every executor area has a domain brief; no brief over 900 words. */
export function lintPlan(planMd: string, execAreas: string[]): string[] {
  const briefs = extractDomainBriefs(planMd);
  const problems: string[] = [];
  for (const area of execAreas) {
    if (!briefs.has(area)) problems.push(`missing "## Domain brief: ${area}"`);
  }
  for (const [area, md] of briefs) {
    const words = wordCount(md);
    if (words > MAX_BRIEF_WORDS) {
      problems.push(`"## Domain brief: ${area}" is ${words} words (max ${MAX_BRIEF_WORDS})`);
    }
  }
  return problems;
}

/**
 * One planner call over goal + all recon reports → plan.md. Lint failures earn
 * ONE corrective re-prompt; sections still missing after that throw.
 */
export async function synthesizePlan(
  ctx: CallCtx,
  planner: Profile,
  args: { root: string; goal: string; execAreas: string[] },
): Promise<string> {
  const rp = meshPaths(args.root).round(ctx.round);
  const reconDir = join(rp.dir, "recon");

  const sections: string[] = [`## Goal\n\n${args.goal}`];
  for (const pair of await listVisible(reconDir)) {
    const files = (await listVisible(join(reconDir, pair))).filter((n) =>
      n.endsWith(".report.md"),
    );
    for (const name of files) {
      const md = await safeRead(join(reconDir, pair, name));
      if (md !== null) {
        sections.push(`## Recon report: ${name.slice(0, -".report.md".length)}\n\n${md}`);
      }
    }
  }
  const baseText = sections.join("\n\n");
  const vars = { GOAL: args.goal, ROUND: ctx.round };

  // publish: false — a lint-failing first attempt must never sit at rounds/rX/plan.md
  // (deriveState would read it as awaiting-approval if the corrective call is killed).
  // The .part still streams for liveness; the settled plan is published below.
  let planMd = await callProfile(ctx, planner, [{ type: "text", text: baseText }], rp.plan, vars, {
    publish: false,
  });

  const problems = lintPlan(planMd, args.execAreas);
  if (problems.length > 0) {
    const corrective = [
      baseText,
      "## Lint failures in your previous plan",
      problems.map((p) => `- ${p}`).join("\n"),
      "Re-emit the ENTIRE corrected plan. Every executor area must have a section with the exact heading `## Domain brief: <area>`, and every brief must stay at or under 800 words.",
      "## Your previous plan",
      planMd,
    ].join("\n\n");
    planMd = await callProfile(ctx, planner, [{ type: "text", text: corrective }], rp.plan, vars, {
      publish: false,
    });
  }

  // Published even when briefs are still missing: the error below tells the
  // operator to edit plan.md by hand, so it must exist on disk.
  await atomicWrite(rp.plan, planMd);

  const missing = args.execAreas.filter((a) => !extractDomainBriefs(planMd).has(a));
  if (missing.length > 0) {
    throw new Error(
      [
        `plan lint failed: ${missing.map((a) => `missing "## Domain brief: ${a}"`).join(", ")}`,
        "the planner was re-prompted once and still omitted required domain briefs",
        `inspect rounds/${ctx.round}/plan.md — edit it by hand before approval, or re-run plan to retry synthesis`,
      ].join("\n"),
    );
  }
  return planMd;
}
