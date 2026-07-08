#!/usr/bin/env node
/** relay-mesh CLI: dispatch table, protocol exit codes, three-line error style. */
import { run as approve } from "./commands/approve.js";
import { run as close } from "./commands/close.js";
import { run as costs } from "./commands/costs.js";
import { run as doctor } from "./commands/doctor.js";
import { run as execute } from "./commands/execute.js";
import { run as plan } from "./commands/plan.js";
import { run as roster } from "./commands/roster.js";
import { run as runCmd } from "./commands/run.js";
import { run as status } from "./commands/status.js";
import { run as verify } from "./commands/verify.js";
import { run as watch } from "./commands/watch.js";

const COMMANDS: Record<string, (argv: string[]) => Promise<number>> = {
  doctor,
  plan,
  approve,
  roster,
  execute,
  verify,
  run: runCmd,
  status,
  watch,
  close,
  costs,
};

const USAGE = `relay-mesh — parallel workstream orchestrator over open-weight models

usage: relay-mesh <command> [options]

commands:
  doctor [--models]                         check env, key, profiles, prompts, root, model slugs
  plan "<goal>" [--attach f]… [--project p] [--force]
                                            mint the relay root, run recon, synthesize the plan
  approve [--round rNNN] [--yes] [--reject "notes"]
                                            human gate #1: pin sha256(plan.md)
  roster [--round rNNN] [--yes] [--reject "notes"]
                                            human gate #2: pin sha256(roster.json), write exec briefs
  execute [--area a]… [--force-area a]… [--project p]
                                            parallel executors + monitor poller + roll-up
  verify [--round rNNN]                     verdict vs the goal; scaffolds a fix round on gaps
  run ["<goal>"] [plan flags] [--yes]       chain plan → approve → execute → verify (resumable)
  status [--json]                           derived state, per-area table, spend, next command
  watch [--interval ms]                     read-only live fleet table (Ctrl-C exits)
  close <pair-dir>                          deterministic closure.json roll-up for one pair dir
  costs [--by profile|round|model|domain|stage] [--round rNNN]
                                            token spend from usage.ndjson

exit codes: 0 ok · 1 error · 2 awaiting a human · 3 blocked outcomes present`;

async function main(): Promise<number> {
  const [name, ...argv] = process.argv.slice(2);
  if (name === undefined) {
    console.error(USAGE);
    return 1;
  }
  if (name === "help" || name === "--help" || name === "-h") {
    console.log(USAGE);
    return 0;
  }
  const command = COMMANDS[name];
  if (command === undefined) {
    console.error(`unknown command: ${name}\n\n${USAGE}`);
    return 1;
  }
  try {
    return await command(argv);
  } catch (err) {
    // Errors arrive pre-formatted in the three-line style: what broke (literal),
    // what the tool believes, what to do next.
    const message = err instanceof Error ? err.message : String(err);
    console.error(`relay-mesh ${name}: ${message}`);
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string" && code.startsWith("ERR_PARSE_ARGS")) {
      console.error("the command's arguments did not parse");
      console.error("run `relay-mesh help` for usage");
    }
    if (process.env.RELAY_DEBUG === "1" && err instanceof Error && err.stack !== undefined) {
      console.error(err.stack);
    }
    return 1;
  }
}

process.exitCode = await main();
