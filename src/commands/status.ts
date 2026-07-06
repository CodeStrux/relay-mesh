/** status: derived state, per-area table, spend per profile, next suggested command. */
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "../config.js";
import { listVisible, safeRead } from "../relay/fsio.js";
import { meshPaths } from "../relay/paths.js";
import { parseReport, type StatusBlock } from "../relay/report.js";
import { deriveState, type RunState } from "../relay/state.js";
import { aggregate, readUsage } from "../usage.js";

export interface PairRow {
  kind: "recon" | "exec";
  pair: string;
  area: string;
  block: StatusBlock | null; // null = no report or its status block does not parse
  bytes: number | null; // report bytes; falls back to the .part size (liveness)
  live: boolean; // true when bytes came from a .part
}

/** Same pct math as closure.json (relay-close.sh parity). */
export function pctOf(b: StatusBlock): number {
  if (b.steps_total > 0) return Math.floor((b.steps_done * 100) / b.steps_total);
  return b.status === "complete" ? 100 : 0;
}

export function renderTable(headers: string[], rows: string[][]): string {
  const all = [headers, ...rows];
  const widths = headers.map((_, i) => Math.max(...all.map((r) => (r[i] ?? "").length)));
  const line = (r: string[]): string =>
    ("  " + r.map((c, i) => (c ?? "").padEnd(widths[i]!)).join("  ")).trimEnd();
  return all.map(line).join("\n");
}

async function sizeOf(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size;
  } catch {
    return null;
  }
}

/** One row per recon/exec pair dir in the round, read-only. */
export async function readPairRows(root: string, round: string): Promise<PairRow[]> {
  const dir = meshPaths(root).round(round).dir;
  const rows: PairRow[] = [];
  for (const kind of ["recon", "exec"] as const) {
    const parent = join(dir, kind);
    for (const pair of await listVisible(parent)) {
      if (!pair.includes("__")) continue; // pair dirs are always <from>__<to>
      const pairDir = join(parent, pair);
      const files = await listVisible(pairDir);
      const brief = files.find((f) => f.endsWith(".brief.md"));
      const report = files.find((f) => f.endsWith(".report.md"));
      let area: string;
      if (brief !== undefined) area = brief.slice(0, -".brief.md".length);
      else if (report !== undefined) area = report.slice(0, -".report.md".length);
      else {
        const tail = pair.replace(/^.*__/, "");
        area = kind === "recon" ? tail.replace(/^recon-/, "") : tail;
      }
      const reportPath = join(pairDir, `${area}.report.md`);
      const md = await safeRead(reportPath);
      const block = md === null ? null : parseReport(md).status;
      let bytes = await sizeOf(reportPath);
      let live = false;
      if (bytes === null) {
        bytes = await sizeOf(`${reportPath}.part`);
        live = bytes !== null;
      }
      rows.push({ kind, pair, area, block, bytes, live });
    }
  }
  return rows;
}

export function nextCommand(state: RunState): string {
  switch (state.phase) {
    case "idle":
      return 'relay-mesh plan "<goal>"';
    case "recon":
    case "synthesis":
      return "relay-mesh plan";
    case "awaiting-approval":
      return "relay-mesh approve";
    case "replanning":
      return `revise rounds/${state.round}/plan.md, then relay-mesh approve`;
    case "executing":
    case "rollup":
      return "relay-mesh execute";
    case "verifying":
    case "fix-planning":
      return "relay-mesh verify";
    case "done":
      return "(none — goal satisfied)";
    default:
      return "relay-mesh status";
  }
}

function statusCell(r: PairRow): string {
  return r.block?.status ?? (r.bytes === null ? "(no report)" : "(in-flight)");
}

export async function run(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { json: { type: "boolean", default: false } },
  });
  const config = loadConfig({ requireApiKey: false });
  const root = config.relayRoot;
  const state = await deriveState(root);
  const usage = aggregate(await readUsage(meshPaths(root).usage), "profile");
  const rows = state.round === null ? [] : await readPairRows(root, state.round);

  if (values.json) {
    console.log(JSON.stringify({ ...state, usage }, null, 2));
  } else {
    console.log(`root   ${root}`);
    console.log(`round  ${state.round ?? "(none)"}`);
    console.log(`phase  ${state.phase}`);
    for (const kind of ["recon", "exec"] as const) {
      const sub = rows.filter((r) => r.kind === kind);
      if (sub.length === 0) continue;
      console.log(`\n${kind} pairs`);
      console.log(
        renderTable(
          ["area", "status", "steps", "pct", "blocked"],
          sub.map((r) => [
            r.area,
            statusCell(r),
            r.block ? `${r.block.steps_done}/${r.block.steps_total}` : "-",
            r.block ? `${pctOf(r.block)}%` : "-",
            r.block?.status === "blocked" ? "yes" : "",
          ]),
        ),
      );
    }
    console.log("\nspend");
    if (usage.length === 0) console.log("  (no usage recorded)");
    else {
      console.log(
        renderTable(
          ["profile", "calls", "tokens in", "tokens out"],
          usage.map((u) => [u.key, String(u.calls), String(u.in), String(u.out)]),
        ),
      );
    }
    console.log(`\nnext: ${nextCommand(state)}`);
  }

  if (rows.some((r) => r.block?.status === "blocked")) return 3;
  if (state.phase === "done" || state.phase === "idle") return 0;
  return 2; // work (or a human) is still pending
}
