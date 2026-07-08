/** roster: human gate #2 — pin sha256(roster.json), then materialize exec briefs deterministically. */
import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { hostname, userInfo } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { briefPreamble } from "../agents/execute.js";
import { loadConfig } from "../config.js";
import { loadProfiles } from "../profiles.js";
import { atomicWrite, listVisible, safeRead } from "../relay/fsio.js";
import { meshPaths, type RoundPaths } from "../relay/paths.js";
import {
  defaultRoster,
  expandRoster,
  lintRoster,
  loadRoster,
  serializeRoster,
  type WorkerSpec,
} from "../relay/roster.js";
import { deriveState } from "../relay/state.js";

async function askGate(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.once("SIGINT", () => rl.close()); // Ctrl-C at the gate aborts, never approves
  try {
    return await Promise.race([
      rl.question(prompt),
      new Promise<string>((resolve) => rl.once("close", () => resolve(""))),
    ]);
  } finally {
    rl.close();
  }
}

/** Verbatim worker briefs + the fixed protocol preamble — no LLM between roster approval and execution. */
async function writeWorkerBriefs(rp: RoundPaths, round: string, workers: WorkerSpec[]): Promise<number> {
  for (const w of workers) {
    const shard = w.shardCount === 1 ? undefined : w.shardIndex;
    const pairDir = rp.execPair(w.area, shard);
    await atomicWrite(rp.brief(pairDir, w.area), briefPreamble(w.area, round, shard) + w.briefBody + "\n");
  }
  return workers.length;
}

/**
 * Remove exec pair dirs the approved roster no longer covers (a dropped domain,
 * or a stale un-sharded/over-sharded pair when the count changes). A pair holding
 * any report file — even an in-flight one — is never touched, so this can never
 * lose work; it only clears brief-only orphans that would wedge the phase machine.
 */
async function pruneStaleExecPairs(rp: RoundPaths, workers: WorkerSpec[]): Promise<void> {
  const keep = new Set(workers.map((w) => w.pairName));
  const execDir = join(rp.dir, "exec");
  for (const name of await listVisible(execDir)) {
    if (!name.includes("__") || keep.has(name)) continue;
    const pairDir = join(execDir, name);
    const files = await listVisible(pairDir);
    if (files.some((f) => f.endsWith(".report.md"))) continue;
    await rm(pairDir, { recursive: true, force: true });
  }
}

export async function run(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      round: { type: "string" },
      reject: { type: "string" },
      yes: { type: "boolean", default: false },
    },
  });
  if (values.round !== undefined && !/^r\d{3,}$/.test(values.round)) {
    throw new Error(
      [`invalid --round "${values.round}"`, "rounds are zero-padded names like r001", "pass --round rNNN"].join("\n"),
    );
  }

  const config = loadConfig({ requireApiKey: false }); // the gate is deterministic — no LLM call
  const profiles = await loadProfiles(config.profilesPath);
  const root = config.relayRoot;
  const state = await deriveState(root);
  const round = values.round ?? state.round;
  if (round === null) {
    throw new Error(
      ["no active round", `${root} has no rounds yet`, 'run: relay-mesh plan "<goal>"'].join("\n"),
    );
  }
  if (round !== state.round) {
    throw new Error(
      [
        `--round ${round} is not the active round (${state.round ?? "none"})`,
        "rounds are append-only — nothing in a finished round is rewritten",
        `work in ${state.round ?? "a new round"} instead (relay-mesh status shows the phase)`,
      ].join("\n"),
    );
  }
  if (state.verdict !== null) {
    throw new Error(
      [
        `rounds/${round} already has a verdict — the round is terminal`,
        "nothing in a terminal round is rewritten; fixes go in the next round",
        "run verify to scaffold the next fix round, then work that round",
      ].join("\n"),
    );
  }

  const rp = meshPaths(root).round(round);
  const planMd = await safeRead(rp.plan);
  if (planMd === null) {
    throw new Error(
      [`rounds/${round}/plan.md not found`, "the roster gate (#2) follows the plan gate (#1)", "run plan first"].join("\n"),
    );
  }

  // Gate ordering: the roster expands briefs from THIS plan, so gate #1 must still
  // hold — approved AND unedited since approval.
  const planSha = createHash("sha256").update(planMd).digest("hex");
  if (state.approval === null || state.approval.decision !== "approved") {
    throw new Error(
      [
        `rounds/${round}/plan.md is not approved`,
        "approve the plan (gate #1) before the roster gate (gate #2)",
        "run: relay-mesh approve",
      ].join("\n"),
    );
  }
  if (state.approval.planSha256 !== planSha) {
    throw new Error(
      [
        `rounds/${round}/plan.md was edited after approval`,
        "the roster expands briefs from the approved plan, so gate #1 must be re-approved first",
        "run: relay-mesh approve",
      ].join("\n"),
    );
  }

  // Author a default roster only when none exists; an advisor-authored roster is used verbatim.
  if ((await safeRead(rp.roster)) === null) {
    await atomicWrite(rp.roster, serializeRoster(defaultRoster(planMd, profiles)));
  }
  const { roster, sha256: rosterSha } = (await loadRoster(rp.roster))!; // throws on invalid JSON/schema

  const problems = lintRoster(planMd, roster, profiles, config);
  if (problems.length > 0) {
    console.log("roster is not approvable:");
    for (const p of problems) console.log(`  - ${p}`);
    console.log("fix rounds/" + round + "/roster.json (or the plan), then re-run relay-mesh roster");
    return 1; // hard block — the gate refuses an unsafe roster
  }

  const workers = expandRoster(planMd, roster, profiles);

  console.log(`roster: rounds/${round}/roster.json`);
  console.log(`sha256: ${rosterSha}`);
  console.log("execute fleet (models resolved from .env — the roster names only slots):");
  for (const e of roster.execute) {
    console.log(`  ${e.domain}: ${e.count}× ${e.template} @ ${config.modelFor(e.modelEnv)} (${e.modelEnv}, ${e.effort})`);
  }

  const by = `${userInfo().username}@${hostname()}`;
  const at = new Date().toISOString();

  if (values.reject !== undefined) {
    const approval = { decision: "rejected", by, at, roster_sha256: rosterSha, notes: values.reject };
    await atomicWrite(rp.rosterApproval, `${JSON.stringify(approval)}\n`);
    console.log(`rejected — rounds/${round}/roster.approval.json written`);
    return 2; // roster-revising: the gate stays armed for a revised roster
  }

  // Idempotent short-circuit: already approved at this exact roster hash.
  const existingRaw = await safeRead(rp.rosterApproval);
  if (existingRaw !== null) {
    try {
      const existing = JSON.parse(existingRaw) as { decision?: unknown; roster_sha256?: unknown };
      if (existing.decision === "approved" && existing.roster_sha256 === rosterSha) {
        await writeWorkerBriefs(rp, round, workers);
        await pruneStaleExecPairs(rp, workers);
        console.log("already approved at this roster hash — exec briefs are in place");
        console.log("next: relay-mesh execute");
        return 0;
      }
    } catch {
      // unparseable approval => run the gate again
    }
  }

  if (!values.yes) {
    const answer = await askGate(
      `type "approve" to approve rounds/${round}/roster.json (anything else aborts): `,
    );
    if (answer.trim() !== "approve") {
      console.log("not approved — nothing written; the roster gate remains armed");
      return 2;
    }
  }

  const approval = { decision: "approved", by, at, roster_sha256: rosterSha, notes: "" };
  await atomicWrite(rp.rosterApproval, `${JSON.stringify(approval)}\n`);
  const written = await writeWorkerBriefs(rp, round, workers);
  await pruneStaleExecPairs(rp, workers);
  console.log(`approved — ${written} exec brief(s) written`);
  console.log("next: relay-mesh execute");
  return 0;
}
