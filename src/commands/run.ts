/** run: chain plan → approve (interactive gate) → execute → verify, looping fix rounds. */
import { parseArgs } from "node:util";
import { loadConfig } from "../config.js";
import { deriveState } from "../relay/state.js";
import { run as approveCmd } from "./approve.js";
import { run as executeCmd } from "./execute.js";
import { readGoal, run as planCmd } from "./plan.js";
import { run as rosterCmd } from "./roster.js";
import { run as verifyCmd } from "./verify.js";

export async function run(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      attach: { type: "string", multiple: true },
      project: { type: "string" },
      force: { type: "boolean", default: false },
      yes: { type: "boolean", default: false },
    },
  });
  if (positionals.length > 1) {
    throw new Error(
      [
        `expected one goal argument, got ${positionals.length}`,
        "the goal must be a single (quoted) argument",
        'usage: relay-mesh run "<goal>" [--attach file]… [--project path]',
      ].join("\n"),
    );
  }
  const goalArg = positionals[0];

  const config = loadConfig();
  const root = config.relayRoot;
  const existing = await readGoal(root);
  if (goalArg === undefined && existing === null) {
    throw new Error(
      [
        "no goal given and no goal.md exists",
        `a run starts by writing the goal under ${root}`,
        'usage: relay-mesh run "<goal>"',
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

  let prevKey = "";
  let lastCode = 0;
  for (;;) {
    const state = await deriveState(root);
    if (state.phase === "done") {
      console.log("goal satisfied — run complete");
      return 0;
    }
    // Every loop turn must advance the phase machine; a repeat means the last
    // command had nothing left to do (e.g. max fix rounds reached).
    const key = `${state.round ?? "-"}:${state.phase}`;
    if (key === prevKey) {
      console.log(`no progress past ${state.phase} — stopping`);
      return lastCode === 0 ? 1 : lastCode;
    }
    prevKey = key;
    console.log(`\n== phase: ${state.phase}${state.round === null ? "" : ` (${state.round})`} ==`);

    switch (state.phase) {
      case "idle":
      case "recon":
      case "synthesis": {
        const args: string[] = goalArg === undefined ? [] : [goalArg];
        for (const a of values.attach ?? []) args.push("--attach", a);
        if (values.project !== undefined) args.push("--project", values.project);
        if (values.force) args.push("--force");
        lastCode = await planCmd(args);
        // 3 = a recon blocked — the approve gate surfaces it for the human next.
        if (lastCode === 1) return 1;
        break;
      }
      case "awaiting-approval":
      case "replanning": {
        lastCode = await approveCmd(values.yes ? ["--yes"] : []);
        if (lastCode !== 0) return lastCode; // gate-stop
        break;
      }
      case "awaiting-roster":
      case "roster-revising": {
        lastCode = await rosterCmd(values.yes ? ["--yes"] : []);
        if (lastCode !== 0) return lastCode; // gate-stop
        break;
      }
      case "executing":
      case "rollup": {
        lastCode = await executeCmd(
          values.project === undefined ? [] : ["--project", values.project],
        );
        if (lastCode === 1 || lastCode === 3) return lastCode; // blocked pairs stop the chain
        break;
      }
      case "verifying":
      case "fix-planning": {
        lastCode = await verifyCmd([]);
        if (lastCode === 0) {
          console.log("goal satisfied — run complete");
          return 0;
        }
        if (lastCode === 1 || lastCode === 3) return lastCode;
        break; // 2: fix round scaffolded (loop to the gate), or max rounds (no-progress stop)
      }
      default:
        return 0; // "done" — handled above
    }
  }
}
