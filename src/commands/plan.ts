/** plan: mint the relay root, copy attachments, run recon, synthesize the plan. */
import { copyFile, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { hostname, userInfo } from "node:os";
import { basename, join, resolve } from "node:path";
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
import { makeResolver, readUsage, writeStageRollup } from "../usage.js";
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

export interface ProjectRecord {
  path: string;
  host?: string;
}

/**
 * The project checkout recorded by `plan --project`, or null. Advisory: the
 * path was valid on the recording host and may not exist on this one.
 */
export async function readProjectRecord(root: string): Promise<ProjectRecord | null> {
  const raw = await safeRead(meshPaths(root).projectJson);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as { path?: unknown; host?: unknown };
    if (typeof parsed.path === "string" && parsed.path !== "") {
      return typeof parsed.host === "string"
        ? { path: parsed.path, host: parsed.host }
        : { path: parsed.path };
    }
  } catch {
    // corrupt project.json — advisory record, treat as absent
  }
  return null;
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

  // Fail fast on a bad --project BEFORE any write or LLM spend: today's silent
  // empty bundle helps nobody downstream.
  let projectAbs: string | undefined;
  if (values.project !== undefined) {
    let isDir = false;
    try {
      isDir = (await stat(values.project)).isDirectory();
    } catch {
      // unreadable — handled below
    }
    if (!isDir) {
      throw new Error(
        [
          `--project ${values.project}: not an accessible directory`,
          "recon and executors bundle source files from the project checkout",
          "fix the path and re-run plan",
        ].join("\n"),
      );
    }
    projectAbs = resolve(values.project);
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

  // The nothing-to-plan guard runs BEFORE any write: past synthesis, plan must
  // not mint mesh.json, mutate inputs/ (immutable after plan), or touch goal.md.
  const state = await deriveState(root);
  if (state.round !== null && !["recon", "synthesis"].includes(state.phase)) {
    const blocked = await blockedReconAreas(root, state.round);
    console.log(`rounds/${state.round}/plan.md already exists (phase: ${state.phase}) — nothing to plan`);
    if (blocked.length) console.log(`blocked recon pairs: ${blocked.join(", ")}`);
    console.log(`next: ${nextCommand(state)}`);
    return blocked.length ? 3 : 0;
  }

  if ((await safeRead(paths.meshJson)) === null) {
    const mesh = { protocol: 1, created: new Date().toISOString(), tool: `relay-mesh@${await toolVersion()}` };
    await atomicWrite(paths.meshJson, `${JSON.stringify(mesh)}\n`);
  }

  // Record where the project lives so execute (any round, any invocation) can
  // bundle source files without re-passing the flag. Host-stamped: the path is
  // advisory on other machines.
  if (projectAbs !== undefined) {
    const record = {
      path: projectAbs,
      host: `${userInfo().username}@${hostname()}`,
      recorded: new Date().toISOString(),
    };
    await atomicWrite(paths.projectJson, `${JSON.stringify(record)}\n`);
  } else if (values.force && goalArg !== undefined && existing !== null && goalArg !== existing) {
    // --force replaced the goal with a different one and no new --project was
    // given: the recorded project belongs to the old goal — drop it rather than
    // feed the new goal's executors another project's bytes as authoritative.
    await rm(paths.projectJson, { force: true });
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
    // Protocol rule 2: .part + rename, so a reader on a shared root never sees
    // a half-copied attachment.
    const dest = join(paths.inputsDir, basename(attach));
    await copyFile(attach, `${dest}.part`);
    await rename(`${dest}.part`, dest);
  }

  // goal.md is written once; only --force with an explicit new goal replaces it.
  if (existing === null || (values.force && goalArg !== undefined)) {
    await atomicWrite(paths.goal, goalMd(goal, await inputsManifest(root)));
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
    stage: "recon",
    usagePath: paths.usage,
    transcriptsDir: paths.round(round).transcriptsDir,
  };

  // Recon gets the raw flag value (byte-identical bundle header to prior runs);
  // the resolved absolute path is only for project.json + execute.
  await runRecon(ctx, byRole(profiles, "recon"), { root, goal, projectPath: values.project });
  const execAreas = byRole(profiles, "executor").flatMap((p) => (p.area === undefined ? [] : [p.area]));
  await synthesizePlan(ctx, byRole(profiles, "planner")[0]!, { root, goal, execAreas });

  const blocked = await blockedReconAreas(root, round);
  console.log(`plan written: rounds/${round}/plan.md`);
  if (blocked.length) {
    console.log(`blocked recon pairs (held for operator attention): ${blocked.join(", ")}`);
  }
  console.log("next: relay-mesh approve");
  // Per-domain usage for the recon+synthesis stage. Non-authoritative: the exit
  // code is decided above; a failed roll-up warns and never changes it.
  try {
    await writeStageRollup(
      paths.round(round).usageStage("recon"),
      await readUsage(paths.usage),
      "recon",
      round,
      makeResolver(profiles),
    );
  } catch (err) {
    console.log(`warning: usage roll-up not written: ${String(err)}`);
  }
  // Blocked outcomes are first-class and exit 3 across all commands (protocol exit table).
  return blocked.length ? 3 : 0;
}
