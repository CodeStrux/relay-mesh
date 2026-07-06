/** Recon phase: deterministic briefs → parallel recon calls → reports + closures. */
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { bundleProject } from "../context.js";
import type { LlmContentPart } from "../openrouter.js";
import type { Profile } from "../profiles.js";
import { rollupPair } from "../relay/closure.js";
import { atomicWrite, listVisible, safeRead } from "../relay/fsio.js";
import { meshPaths } from "../relay/paths.js";
import { parseReport, serializeStatusBlock } from "../relay/report.js";
import { callProfile, type CallCtx } from "./call.js";

// Asks mirror each recon prompt's numbered output headings, so steps map 1:1.
const RECON_ASKS: Record<string, string[]> = {
  backend: [
    "Stack & entry points — languages, frameworks, runtimes, and how the system starts.",
    "Entities & data model — core types, tables, or schemas and where each lives.",
    "API surface — endpoints, handlers, queues, jobs: method, path/name, and handler location.",
    "Infra & deployment — build steps, CI, containers, deploy scripts, and every env var the code consumes.",
    "Extension points — where new backend or infra work would plug in, with citations.",
    "Tests — what test suites exist, how they run, and what they do not cover.",
    "Gaps & risks — missing pieces, contradictions, and risky areas relevant to the goal.",
  ],
  frontend: [
    "Stack & build — framework, bundler, styling approach, and how the frontend builds and runs.",
    "Routes & views — every route/page/screen and the file that renders it.",
    "Components & design system — shared components, tokens, themes, fonts, and where they live.",
    "State & data flow — state management, data fetching, API clients, and generated types.",
    "UX flows & accessibility — the main user journeys as implemented, plus a11y provisions or their absence.",
    "Extension points — where new frontend work would plug in, with citations.",
    "Gaps & risks — missing pieces, inconsistencies, and risky areas relevant to the goal.",
  ],
  business: [
    "Product & users — what the product is and who uses it, per the evidence.",
    "Value flows — who pays or benefits, for what outcome, and how value moves through the system.",
    "Domain vocabulary — the domain's terms and their precise meanings.",
    "Constraints & compliance — legal, contractual, platform, or budget constraints found in the inputs.",
    "Success criteria — measurable statements of what makes the goal achieved.",
    "Open questions — business questions the inputs cannot answer.",
  ],
  vision: [
    "Inputs inventory — one line per attachment: index, type, and apparent subject.",
    "Literal description — exactly what is visible in each attachment, all legible text quoted verbatim.",
    "Interpretation — what the visuals mean for the goal, tied to described elements.",
    "Extracted requirements — numbered requirements the visuals impose.",
    "Illegible or ambiguous content — every unreadable element and every element with multiple readings.",
    "Open questions — questions only the user can answer about the visuals.",
  ],
};

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};
const VIDEO_MIME: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
};

function reconAsks(profile: Profile, area: string): string[] {
  return (
    RECON_ASKS[area] ?? [
      `Recon everything in the inputs relevant to "${profile.domain}", with citations.`,
      "Gaps & risks — missing pieces and contradictions relevant to the goal.",
    ]
  );
}

/** Deterministic recon brief — no LLM runs before recon. */
export function reconBriefMd(profile: Profile, goal: string, round: string): string {
  const area = profile.area ?? profile.name;
  const asks = reconAsks(profile, area);
  return `# Recon brief: ${area} — round ${round}

From: planner
To: ${profile.name} (${profile.domain})

## Goal

${goal}

## Asks

${asks.map((a, i) => `${i + 1}. ${a}`).join("\n")}

## Report

Write your report to \`rounds/${round}/recon/planner__${profile.name}/${area}.report.md\`, opening with the status block (\`area: ${area}\`). Count \`steps_done\`/\`steps_total\` against the ${asks.length} asks above.
`;
}

async function visualParts(
  inputsDir: string,
): Promise<{ parts: LlmContentPart[]; notes: string[] }> {
  const parts: LlmContentPart[] = [];
  const notes: string[] = [];
  for (const name of await listVisible(inputsDir)) {
    const ext = extname(name).toLowerCase();
    const mime = IMAGE_MIME[ext] ?? VIDEO_MIME[ext];
    if (mime === undefined) {
      notes.push(
        `attachment ${name} skipped: unsupported extension (images: png/jpg/jpeg/webp; video: mp4/mov)`,
      );
      continue;
    }
    const url = `data:${mime};base64,${(await readFile(join(inputsDir, name))).toString("base64")}`;
    parts.push(
      IMAGE_MIME[ext] !== undefined
        ? { type: "image_url", image_url: { url } }
        : { type: "video_url", video_url: { url } },
    );
  }
  return { parts, notes };
}

function blockedReportMd(area: string, planRef: string, stepsTotal: number, err: unknown): string {
  return (
    serializeStatusBlock({
      area,
      status: "blocked",
      steps_done: 0,
      steps_total: stepsTotal,
      plan_ref: planRef,
    }) +
    `\nThe recon call failed before producing a report; the pair is held for operator attention.\n\nLiteral error:\n\n\`\`\`\n${String(err)}\n\`\`\`\n`
  );
}

/**
 * Newest recon report for an area, walking rounds backwards — fix rounds have no
 * recon of their own, so later rounds fall back to the round that ran recon.
 */
export async function findLatestReconReport(root: string, area: string): Promise<string | null> {
  const paths = meshPaths(root);
  const rounds = (await listVisible(paths.roundsDir))
    .filter((n) => /^r\d{3,}$/.test(n))
    .sort((a, b) => Number(b.slice(1)) - Number(a.slice(1)));
  for (const round of rounds) {
    const reconDir = join(paths.round(round).dir, "recon");
    for (const pair of await listVisible(reconDir)) {
      const md = await safeRead(join(reconDir, pair, `${area}.report.md`));
      if (md !== null) return md;
    }
  }
  return null;
}

/**
 * Run every recon profile in parallel. Per pair: write the deterministic brief,
 * call the profile (vision gets inputs/ attachments), synthesize a blocked report
 * on a rejected call, and roll closure.json. Pairs whose report already parses
 * are skipped (resume).
 */
export async function runRecon(
  ctx: CallCtx,
  reconProfiles: Profile[],
  args: { root: string; goal: string; projectPath?: string },
): Promise<void> {
  const paths = meshPaths(args.root);
  const rp = paths.round(ctx.round);
  const bundle = args.projectPath ? await bundleProject(args.projectPath) : null;

  const results = await Promise.allSettled(
    reconProfiles.map(async (profile) => {
      const area = profile.area ?? profile.name;
      const pairDir = rp.reconPair(profile.name);
      const reportPath = rp.report(pairDir, area);
      const pairRef = `rounds/${ctx.round}/recon/planner__${profile.name}`;
      const briefRef = `${pairRef}/${area}.brief.md`;

      // Resume: a pair whose report parses is terminal — never re-run it.
      const existing = await safeRead(reportPath);
      if (existing !== null && parseReport(existing).status !== null) {
        await rollupPair(pairDir);
        return;
      }

      const brief = reconBriefMd(profile, args.goal, ctx.round);
      await atomicWrite(rp.brief(pairDir, area), brief);
      const asks = reconAsks(profile, area);

      let userParts: LlmContentPart[];
      if (profile.multimodal) {
        const { parts, notes } = await visualParts(paths.inputsDir);
        if (parts.length === 0) {
          const noteText = notes.length ? `\n${notes.map((n) => `- ${n}`).join("\n")}` : "";
          await atomicWrite(
            reportPath,
            serializeStatusBlock({
              area,
              status: "complete",
              steps_done: 0,
              steps_total: 0,
              plan_ref: briefRef,
            }) +
              `\nRecon skipped: no visual inputs (images: png/jpg/jpeg/webp; video: mp4/mov) were found in inputs/.${noteText}\n`,
          );
          await rollupPair(pairDir);
          return;
        }
        const noteText = notes.length
          ? `\n\nNotes on skipped attachments:\n${notes.map((n) => `- ${n}`).join("\n")}`
          : "";
        userParts = [{ type: "text", text: `${brief}${noteText}` }, ...parts];
      } else {
        const bundleText =
          bundle ??
          'No project bundle was provided. Recon from the goal text alone; mark project claims "not present in bundle".';
        userParts = [{ type: "text", text: `${brief}\n\n## Project bundle\n\n${bundleText}` }];
      }

      try {
        await callProfile(ctx, profile, userParts, reportPath, {
          GOAL: args.goal,
          ROUND: ctx.round,
          AREA: area,
          REPORT_PATH: `${pairRef}/${area}.report.md`,
        });
      } catch (err) {
        await atomicWrite(reportPath, blockedReportMd(area, briefRef, asks.length, err));
      }
      await rollupPair(pairDir);
    }),
  );

  // Rejected LLM calls became blocked reports above; anything still rejected is a real bug.
  const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failed) throw failed.reason;
}
