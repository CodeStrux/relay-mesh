/** verify: verifier verdict vs the goal; scaffolds the next fix round on gaps. */
import { parseArgs } from "node:util";
import type { CallCtx } from "../agents/call.js";
import { runVerify, scaffoldFixRound, type Verdict, type VerdictGap } from "../agents/verify.js";
import { loadConfig } from "../config.js";
import { makeOpenRouterClient } from "../openrouter.js";
import { byRole, loadProfiles } from "../profiles.js";
import { safeRead } from "../relay/fsio.js";
import { meshPaths } from "../relay/paths.js";
import { deriveState } from "../relay/state.js";
import { readGoal } from "./plan.js";
import { readPairRows } from "./status.js";

function isGap(g: unknown): g is VerdictGap {
  return (
    typeof g === "object" &&
    g !== null &&
    typeof (g as VerdictGap).area === "string" &&
    typeof (g as VerdictGap).description === "string"
  );
}

/** A verdict.json already on disk (resume) — verify never re-runs a settled verifier. */
function parseStoredVerdict(raw: string): Verdict | null {
  try {
    const j = JSON.parse(raw) as { satisfied?: unknown; gaps?: unknown };
    if (typeof j.satisfied === "boolean" && Array.isArray(j.gaps) && j.gaps.every(isGap)) {
      return { satisfied: j.satisfied, gaps: j.gaps };
    }
  } catch {
    // unparseable => re-run the verifier
  }
  return null;
}

export async function run(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { round: { type: "string" } },
  });
  if (values.round !== undefined && !/^r\d{3,}$/.test(values.round)) {
    throw new Error(
      [
        `invalid --round "${values.round}"`,
        "rounds are zero-padded names like r001",
        "pass --round rNNN",
      ].join("\n"),
    );
  }

  const config = loadConfig();
  const profiles = await loadProfiles(config.profilesPath);
  const root = config.relayRoot;
  const state = await deriveState(root);
  const round = values.round ?? state.round;
  if (round === null) {
    throw new Error(
      ["no active round", `${root} has no rounds yet`, 'run: relay-mesh plan "<goal>"'].join("\n"),
    );
  }
  const goal = await readGoal(root);
  if (goal === null) {
    throw new Error(
      ["goal.md not found", "verify judges the outcome against the goal that plan wrote", "run plan first"].join("\n"),
    );
  }
  const paths = meshPaths(root);
  const rp = paths.round(round);
  if ((await safeRead(rp.rollup)) === null) {
    throw new Error(
      [
        `rounds/${round}/monitor/rollup.md not found`,
        "verify runs after execution finished and the monitor roll-up was written",
        "run execute first",
      ].join("\n"),
    );
  }

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

  const stored = await safeRead(rp.verdictJson);
  let verdict = stored === null ? null : parseStoredVerdict(stored);
  if (verdict === null) {
    verdict = await runVerify(ctx, byRole(profiles, "verifier")[0]!, { root, goal });
  }

  // Blocked pairs exit 3 on EVERY verdict (protocol: "blocked outcomes present → 3",
  // all commands) — status returns 3 on this exact tree, so verify must agree.
  const blocked = (await readPairRows(root, round)).some(
    (r) => r.kind === "exec" && r.block?.status === "blocked",
  );

  if (verdict.satisfied) {
    console.log("verdict: satisfied — the outcome matches the goal");
    if (blocked) console.log("blocked exec pairs remain held for operator attention");
    return blocked ? 3 : 0;
  }
  console.log("verdict: NOT satisfied");
  verdict.gaps.forEach((g, i) => console.log(`  ${i + 1}. [${g.area}] ${g.description}`));

  const n = Number(round.slice(1));
  if (n < config.maxFixRounds) {
    const next = await scaffoldFixRound(ctx, byRole(profiles, "planner")[0]!, { root, goal });
    console.log(`fix round scaffolded: rounds/${next}/plan.md`);
    console.log(`next: relay-mesh approve --round ${next}`);
  } else {
    console.log(`max fix rounds reached (MAX_FIX_ROUNDS=${config.maxFixRounds}) — no fix round scaffolded`);
  }

  return blocked ? 3 : 2;
}
