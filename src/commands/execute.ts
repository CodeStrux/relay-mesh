/** execute: hash check → monitor poller → parallel executors → poller stop → roll-up. */
import { rm, stat } from "node:fs/promises";
import { hostname, userInfo } from "node:os";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type { CallCtx } from "../agents/call.js";
import { ApprovalMismatchError, type ProjectRef, runExecute } from "../agents/execute.js";
import { runRollup, startPoller } from "../agents/monitor.js";
import { extractDomainBriefs } from "../agents/plan.js";
import { loadConfig } from "../config.js";
import { makeOpenRouterClient } from "../openrouter.js";
import { byRole, loadProfiles } from "../profiles.js";
import { safeRead } from "../relay/fsio.js";
import { meshPaths } from "../relay/paths.js";
import { deriveState } from "../relay/state.js";
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

  const executors = byRole(profiles, "executor");
  const known = executors.flatMap((p) => (p.area === undefined ? [] : [p.area]));
  const areaFlags = values.area ?? [];
  const forceFlags = values["force-area"] ?? [];
  for (const a of [...areaFlags, ...forceFlags]) {
    if (!known.includes(a)) {
      throw new Error(
        [
          `unknown area "${a}"`,
          `executor areas are: ${known.join(", ")}`,
          "fix the flag or add an executor profile to profiles.json",
        ].join("\n"),
      );
    }
  }

  const paths = meshPaths(root);
  const rp = paths.round(round);
  // Resolve --project BEFORE the destructive --force-area rm: a bad flag must
  // fail fast, never delete a terminal pair and then exit 1.
  const project = await resolveProject(root, values.project);
  // --force-area is the one sanctioned per-pair override: clear that pair's
  // report + workspace within the current round so the executor re-runs.
  for (const a of forceFlags) {
    await rm(rp.report(rp.execPair(a), a), { force: true });
    await rm(rp.workspace(a), { recursive: true, force: true });
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
    usagePath: paths.usage,
    transcriptsDir: rp.transcriptsDir,
  };

  const poller = startPoller(root, round, config.monitorPollMs);
  try {
    await runExecute(ctx, executors, { root, goal, areas, project });
  } finally {
    await poller.stop();
  }

  const planMd = (await safeRead(rp.plan))!;
  const briefed = extractDomainBriefs(planMd);
  const expected = known.filter((a) => briefed.has(a));
  if (expected.length === 0) {
    throw new Error(
      [
        "no executor area matches a domain brief in the plan",
        `plan briefs: ${[...briefed.keys()].join(", ") || "(none)"}; executor areas: ${known.join(", ")}`,
        "fix profiles.json or the plan's `## Domain brief:` headings, then re-approve",
      ].join("\n"),
    );
  }

  const rows = await readPairRows(root, round);
  const blockByArea = new Map(rows.filter((r) => r.kind === "exec").map((r) => [r.area, r.block]));
  for (const a of expected) {
    const b = blockByArea.get(a) ?? null;
    console.log(`  ${a}: ${b === null ? "no report (not run)" : `${b.status} ${b.steps_done}/${b.steps_total}`}`);
  }

  const allTerminal = expected.every((a) => (blockByArea.get(a) ?? null) !== null);
  if (allTerminal && (await safeRead(rp.rollup)) === null) {
    await runRollup(ctx, byRole(profiles, "monitor")[0]!, { root, goal });
    console.log(`monitor roll-up written: rounds/${round}/monitor/rollup.md`);
  }
  if (allTerminal) console.log("next: relay-mesh verify");

  const statuses = expected.map((a) => blockByArea.get(a)?.status ?? null);
  if (statuses.some((s) => s === "blocked")) return 3;
  if (statuses.every((s) => s === "complete")) return 0;
  return 2;
}
