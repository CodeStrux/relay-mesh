/** plan: mint the relay root, copy attachments, run recon, synthesize the plan. */
import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import type { CallCtx } from "../agents/call.js";
import { synthesizePlan } from "../agents/plan.js";
import { runRecon } from "../agents/recon.js";
import { loadConfig } from "../config.js";
import { makeOpenRouterClient } from "../openrouter.js";
import { byRole, loadProfiles } from "../profiles.js";
import { atomicWrite, listVisible, safeRead } from "../relay/fsio.js";
import { meshPaths, nextRound } from "../relay/paths.js";
import { deriveState } from "../relay/state.js";
import { nextCommand, readPairRows } from "./status.js";

const ATTACH_HEADING = "\n\n## Attachments\n";

/** goal.md = the goal verbatim + attachment manifest; parseGoal strips the manifest back off. */
export function goalMd(goal: string, attachments: { name: string; size: number }[]): string {
  if (attachments.length === 0) return `${goal}\n`;
  const manifest = attachments.map((a) => `- ${a.name} (${a.size}B)`).join("\n");
  return `${goal}${ATTACH_HEADING}\n${manifest}\n`;
}

export function parseGoal(md: string): string {
  const cut = md.lastIndexOf(ATTACH_HEADING);
  return (cut === -1 ? md : md.slice(0, cut)).replace(/\n$/, "");
}

/** The verbatim goal stored in goal.md, or null when the root has none. */
export async function readGoal(root: string): Promise<string | null> {
  const md = await safeRead(meshPaths(root).goal);
  return md === null ? null : parseGoal(md);
}

let versionCache: string | null = null;
async function toolVersion(): Promise<string> {
  if (versionCache === null) {
    try {
      // ../../package.json resolves from both src/commands (vitest) and dist/commands (built).
      const raw = await readFile(new URL("../../package.json", import.meta.url), "utf8");
      versionCache = (JSON.parse(raw) as { version?: string }).version ?? "0.0.0";
    } catch {
      versionCache = "0.0.0";
    }
  }
  return versionCache;
}

async function inputsManifest(root: string): Promise<{ name: string; size: number }[]> {
  const dir = meshPaths(root).inputsDir;
  const out: { name: string; size: number }[] = [];
  for (const name of await listVisible(dir)) {
    out.push({ name, size: (await stat(join(dir, name))).size });
  }
  return out;
}

async function blockedReconAreas(root: string, round: string): Promise<string[]> {
  return (await readPairRows(root, round))
    .filter((r) => r.kind === "recon" && r.block?.status === "blocked")
    .map((r) => r.area);
}

export async function run(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      attach: { type: "string", multiple: true },
      project: { type: "string" },
      force: { type: "boolean", default: false },
    },
  });
  if (positionals.length > 1) {
    throw new Error(
      [
        `expected one goal argument, got ${positionals.length}`,
        "the goal must be a single (quoted) argument",
        'usage: relay-mesh plan "<goal>" [--attach file]… [--project path]',
      ].join("\n"),
    );
  }

  const config = loadConfig();
  const profiles = await loadProfiles(config.profilesPath);
  const root = config.relayRoot;
  const paths = meshPaths(root);

  const goalArg = positionals[0];
  const existing = await readGoal(root);
  if (goalArg === undefined && existing === null) {
    throw new Error(
      [
        "no goal given and no goal.md exists",
        `a run starts by writing the goal to ${paths.goal}`,
        'usage: relay-mesh plan "<goal>"',
      ].join("\n"),
    );
  }
  if (goalArg !== undefined && existing !== null && goalArg !== existing && !values.force) {
    throw new Error(
      [
        "goal.md already holds a different goal",
        `this relay root (${root}) belongs to an existing run`,
        "re-run with --force to replace the goal, or point RELAY_ROOT at a fresh directory",
      ].join("\n"),
    );
  }
  const goal = goalArg ?? existing!;

  if ((await safeRead(paths.meshJson)) === null) {
    const mesh = { protocol: 1, created: new Date().toISOString(), tool: `relay-mesh@${await toolVersion()}` };
    await atomicWrite(paths.meshJson, `${JSON.stringify(mesh)}\n`);
  }

  for (const attach of values.attach ?? []) {
    try {
      await stat(attach);
    } catch {
      throw new Error(
        [
          `--attach ${attach}: file not found`,
          "attachments are copied into inputs/ before recon",
          "fix the path and re-run plan",
        ].join("\n"),
      );
    }
    await mkdir(paths.inputsDir, { recursive: true });
    await copyFile(attach, join(paths.inputsDir, basename(attach)));
  }

  // goal.md is written once; only --force with an explicit new goal replaces it.
  if (existing === null || (values.force && goalArg !== undefined)) {
    await atomicWrite(paths.goal, goalMd(goal, await inputsManifest(root)));
  }

  const state = await deriveState(root);
  if (state.round !== null && !["recon", "synthesis"].includes(state.phase)) {
    const blocked = await blockedReconAreas(root, state.round);
    console.log(`rounds/${state.round}/plan.md already exists (phase: ${state.phase}) — nothing to plan`);
    if (blocked.length) console.log(`blocked recon pairs: ${blocked.join(", ")}`);
    console.log(`next: ${nextCommand(state)}`);
    return blocked.length ? 2 : 0;
  }
  const round = state.round ?? nextRound(await listVisible(paths.roundsDir));

  const client = makeOpenRouterClient({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    referer: config.referer,
    title: config.title,
  });
  const ctx: CallCtx = {
    client,
    config,
    round,
    usagePath: paths.usage,
    transcriptsDir: paths.round(round).transcriptsDir,
  };

  await runRecon(ctx, byRole(profiles, "recon"), { root, goal, projectPath: values.project });
  const execAreas = byRole(profiles, "executor").flatMap((p) => (p.area === undefined ? [] : [p.area]));
  await synthesizePlan(ctx, byRole(profiles, "planner")[0]!, { root, goal, execAreas });

  const blocked = await blockedReconAreas(root, round);
  console.log(`plan written: rounds/${round}/plan.md`);
  if (blocked.length) {
    console.log(`blocked recon pairs (held for operator attention): ${blocked.join(", ")}`);
  }
  console.log("next: relay-mesh approve");
  return blocked.length ? 2 : 0;
}
