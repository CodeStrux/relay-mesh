/** close: standalone deterministic closure.json roll-up for one pair dir (relay-close.sh parity). */
import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { rollupPair } from "../relay/closure.js";

export async function run(argv: string[]): Promise<number> {
  const { positionals } = parseArgs({ args: argv, allowPositionals: true, options: {} });
  if (positionals.length !== 1) {
    throw new Error(
      [
        "expected exactly one <pair-dir> argument",
        "close rolls one relay pair directory up into closure.json",
        "usage: relay-mesh close <pair-dir>",
      ].join("\n"),
    );
  }
  const dir = positionals[0]!;
  let isDir = false;
  try {
    isDir = (await stat(dir)).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    throw new Error(
      [
        `${dir}: not a directory`,
        "close expects an existing pair dir like <root>/rounds/r001/exec/planner__backend",
        "check the path",
      ].join("\n"),
    );
  }

  const closure = await rollupPair(dir);
  for (const b of closure.briefs) {
    console.log(`  ${b.area}  ${b.status}  ${b.steps_done}/${b.steps_total}  ${b.pct}%`);
  }
  const blocked = closure.totals.blocked.length ? ` — blocked: ${closure.totals.blocked.join(", ")}` : "";
  console.log(`totals: ${closure.totals.pct}%${blocked}`);
  console.log(`wrote ${join(resolve(dir), "closure.json")}`);
  return 0;
}
