/** costs: aggregate usage.ndjson token spend by profile, round, or model. */
import { parseArgs } from "node:util";
import { loadConfig } from "../config.js";
import { meshPaths } from "../relay/paths.js";
import { aggregate, readUsage } from "../usage.js";
import { renderTable } from "./status.js";

const BYS = ["profile", "round", "model"] as const;

export async function run(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { by: { type: "string", default: "profile" } },
  });
  if (!(BYS as readonly string[]).includes(values.by)) {
    throw new Error(
      [
        `invalid --by "${values.by}"`,
        "costs aggregates usage.ndjson along one dimension",
        "use --by profile | round | model",
      ].join("\n"),
    );
  }
  const by = values.by as (typeof BYS)[number];

  const config = loadConfig({ requireApiKey: false });
  const usagePath = meshPaths(config.relayRoot).usage;
  const lines = await readUsage(usagePath);
  if (lines.length === 0) {
    console.log(`no usage recorded yet (${usagePath})`);
    return 0;
  }

  const agg = aggregate(lines, by).sort((a, b) => a.key.localeCompare(b.key));
  const rows = agg.map((r) => [r.key, String(r.calls), String(r.in), String(r.out)]);
  rows.push([
    "total",
    String(agg.reduce((n, r) => n + r.calls, 0)),
    String(agg.reduce((n, r) => n + r.in, 0)),
    String(agg.reduce((n, r) => n + r.out, 0)),
  ]);
  console.log(renderTable([by, "calls", "tokens in", "tokens out"], rows));
  return 0;
}
