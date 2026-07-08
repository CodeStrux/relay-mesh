/** execute: hash check → monitor poller → parallel executors → poller stop → roll-up. */
import { rm, stat } from "node:fs/promises";
import { hostname, userInfo } from "node:os";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type { CallCtx } from "../agents/call.js";
import {
  ApprovalMismatchError,
  type ProjectRef,
  RosterMismatchError,
  runExecute,
} from "../agents/execute.js";
import { runRollup, startPoller } from "../agents/monitor.js";
import { loadConfig } from "../config.js";
import { makeOpenRouterClient } from "../openrouter.js";
import { byRole, loadProfiles } from "../profiles.js";
import { safeRead } from "../relay/fsio.js";
import { meshPaths } from "../relay/paths.js";
import { expandRoster, loadRoster } from "../relay/roster.js";
import { deriveState } from "../relay/state.js";
import { makeResolver, readUsage, writeStageRollup } from "../usage.js";
import { readGoal, readProjectRecord } from "./plan.js";
import { readPairRows } from "./status.js";

/**
 * Where executors read source bytes from: --project flag > project.json > none.
 * An explicit flag that doesn't resolve is an operator error (throw); a recorded
 * path that doesn't resolve on THIS box degrades to a visible note.
 */
async function resolveProject(root: string, flag: string | undefined): Promise<ProjectRef> {
  if (flag !== undefined) {
    let isDir = false;
    try {
      isDir = (await stat(flag)).isDirectory();
    } catch {
      // unreadable — handled below
    }
    if (!isDir) {
      throw new Error(
        [
          `--project ${flag}: not an accessible directory`,
          "executors bundle source files from the project checkout",
          "fix the path and re-run execute",
        ].join("\n"),
      );
    }
    return { path: resolve(flag), note: null };
  }
  const record = await readProjectRecord(root);
  if (record === null) return { path: null, note: null };
  try {
    await stat(record.path);
    // Shared root (syncthing/NFS): the recorded path resolves here, but it was
    // recorded on another machine — a coincidental same-path collision would
    // bundle the wrong project. Surface it so the operator can pass --project.
    const here = `${userInfo().username}@${hostname()}`;
    if (record.host !== undefined && record.host !== here) {
      console.log(
        `note: using project.json path ${record.path} recorded on ${record.host} (this box is ${here}); pass --project to override`,
      );
    }
    return { path: record.path, note: null };
  } catch {
    const where = record.host === undefined ? "" : ` (recorded on ${record.host})`;
    const note = `project path ${record.path}${where} is not accessible on this machine.`;
    console.log(`warning: ${note} pass --project <local-checkout> or expect precise blocks`);
    return { path: null, note };
  }
}

export async function run(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      area: { type: "string", multiple: true },
      "force-area": { type: "string", multiple: true },
      project: { type: "string" },
    },
  });

  const config = loadConfig();
  const profiles = await loadProfiles(config.profilesPath);
  const root = config.relayRoot;
  const state = await deriveState(root);
  if (state.round === null) {
    throw new Error(
      ["no active round", `${root} has no rounds yet`, 'run: relay-mesh plan "<goal>"'].join("\n"),
    );
  }
  const round = state.round;
  const goal = await readGoal(root);
  if (goal === null) {
    throw new Error(
      ["goal.md not found", "execute needs the goal that plan wrote", "run plan first"].join("\n"),
    );
  }

  // Approval integrity first: never start work against an unapproved or edited plan.
  if (state.planSha256 === null) {
    throw new Error(
      [
        `rounds/${round}/plan.md not found`,
        "execute extracts its briefs from an approved plan",
        "run plan and approve first",
      ].join("\n"),
    );
  }
  if (state.approval === null || state.approval.decision !== "approved") {
    throw new Error(
      [
        `no approval for rounds/${round}/plan.md`,
        "execute only runs briefs extracted from an approved plan",
        "run the approve command first",
      ].join("\n"),
    );
  }
  if (state.approval.planSha256 !== state.planSha256) throw new ApprovalMismatchError(round);

  // Gate #2: the roster must be approved and unedited since approval.
  if (state.rosterSha256 === null) {
    throw new Error(
      [
        `no roster for rounds/${round}`,
        "execute runs the fleet the roster gate approved",
        "run the roster command first",
      ].join("\n"),
    );
  }
  if (state.rosterApproval === null || state.rosterApproval.decision !== "approved") {
    throw new Error(
      [
        `roster for rounds/${round} is not approved`,
        "execute only runs an approved roster",
        "run the roster command first",
      ].join("\n"),
    );
  }
  if (state.rosterApproval.rosterSha256 !== state.rosterSha256) throw new RosterMismatchError(round);

  const paths = meshPaths(root);
  const rp = paths.round(round);
  const planMd = (await safeRead(rp.plan))!; // present: state.planSha256 !== null
  const workers = expandRoster(planMd, (await loadRoster(rp.roster))!.roster, profiles);

  const known = [...new Set(workers.map((w) => w.area))];
  const areaFlags = values.area ?? [];
  const forceFlags = values["force-area"] ?? [];
  for (const a of [...areaFlags, ...forceFlags]) {
    if (!known.includes(a)) {
      throw new Error(
        [
          `unknown area "${a}"`,
          `roster areas are: ${known.join(", ")}`,
          "fix the flag or add the area to roster.json, then re-approve the roster",
        ].join("\n"),
      );
    }
  }

  // Resolve --project BEFORE the destructive --force-area rm: a bad flag must
  // fail fast, never delete a terminal pair and then exit 1.
  const project = await resolveProject(root, values.project);
  // --force-area is the one sanctioned per-pair override: clear every shard of
  // that area's report + workspace within the current round so it re-runs.
  for (const a of forceFlags) {
    for (const w of workers.filter((wk) => wk.area === a)) {
      const shard = w.shardCount === 1 ? undefined : w.shardIndex;
      await rm(rp.report(rp.execPair(a, shard), a), { force: true });
      await rm(rp.workspace(a, shard), { recursive: true, force: true });
    }
  }
  const areas =
    areaFlags.length + forceFlags.length > 0
      ? [...new Set([...areaFlags, ...forceFlags])]
      : undefined;

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
    stage: "execute",
    usagePath: paths.usage,
    transcriptsDir: rp.transcriptsDir,
  };

  const poller = startPoller(root, round, config.monitorPollMs);
  try {
    await runExecute(ctx, workers, { root, goal, areas, project });
  } finally {
    await poller.stop();
  }

  // One row per exec pair dir (a shard is its own pair); the roster gate wrote a
  // brief for each, so a not-yet-run worker still shows up (in-flight → status null).
  const execRows = (await readPairRows(root, round)).filter((r) => r.kind === "exec");
  for (const r of execRows) {
    const b = r.block;
    console.log(
      `  ${r.pair}: ${b === null ? "no report (not run)" : `${b.status} ${b.steps_done}/${b.steps_total}`}`,
    );
  }

  const statuses = execRows.map((r) => r.block?.status ?? null);
  const allTerminal = statuses.length > 0 && statuses.every((s) => s !== null);
  if (allTerminal && (await safeRead(rp.rollup)) === null) {
    await runRollup(ctx, byRole(profiles, "monitor")[0]!, { root, goal });
    console.log(`monitor roll-up written: rounds/${round}/monitor/rollup.md`);
  }
  if (allTerminal) {
    console.log("next: relay-mesh verify");
    // Only the completing host writes the roll-up (single-writer, like rollup.md).
    // Non-authoritative: a failed write warns and never changes the exit code below.
    try {
      await writeStageRollup(rp.usageStage("execute"), await readUsage(paths.usage), "execute", round, makeResolver(profiles));
    } catch (err) {
      console.log(`warning: usage roll-up not written: ${String(err)}`);
    }
  }

  if (statuses.some((s) => s === "blocked")) return 3;
  if (allTerminal && statuses.every((s) => s === "complete")) return 0;
  return 2;
}
