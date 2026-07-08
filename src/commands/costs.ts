/** costs: aggregate usage.ndjson token spend by profile, round, model, domain, or stage. */
import { parseArgs } from "node:util";
import { loadConfig } from "../config.js";
import { loadProfiles } from "../profiles.js";
import { meshPaths } from "../relay/paths.js";
import { aggregate, makeResolver, readUsage } from "../usage.js";
import { renderTable } from "./status.js";

const BYS = ["profile", "round", "model", "domain", "stage"] as const;

export async function run(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { by: { type: "string", default: "profile" }, round: { type: "string" } },
  });
  if (!(BYS as readonly string[]).includes(values.by)) {
    throw new Error(
      [
        `invalid --by "${values.by}"`,
        "costs aggregates usage.ndjson along one dimension",
        `use --by ${BYS.join(" | ")}`,
      ].join("\n"),
    );
  }
  const by = values.by as (typeof BYS)[number];

  const config = loadConfig({ requireApiKey: false });
  const usagePath = meshPaths(config.relayRoot).usage;
  let lines = await readUsage(usagePath);
  if (values.round !== undefined) lines = lines.filter((l) => l.round === values.round);
  if (lines.length === 0) {
    console.log(`no usage recorded yet (${usagePath})`);
    return 0;
  }

  // For --by domain, resolve legacy/minted lines to their domain first.
  if (by === "domain") {
    const resolve = makeResolver(await loadProfiles(config.profilesPath));
    lines = lines.map((l) => ({ ...l, domain: resolve(l) }));
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
