/** watch: read-only live fleet table on an interval; NEVER writes under the root. */
import { parseArgs } from "node:util";
import { loadConfig } from "../config.js";
import { safeRead } from "../relay/fsio.js";
import { meshPaths } from "../relay/paths.js";
import { deriveState } from "../relay/state.js";
import { pctOf, readPairRows, renderTable } from "./status.js";

const CLEAR = "\x1b[2J\x1b[H"; // clear screen + cursor home
const EVENTS_TAIL = 5;

export async function run(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { interval: { type: "string" } },
  });
  const intervalMs = Number(values.interval ?? "1000");
  if (!Number.isInteger(intervalMs) || intervalMs <= 0) {
    throw new Error(
      [
        `invalid --interval "${values.interval}"`,
        "the interval is a positive number of milliseconds",
        "e.g. relay-mesh watch --interval 500",
      ].join("\n"),
    );
  }
  const config = loadConfig({ requireApiKey: false });
  const root = config.relayRoot;

  async function frame(): Promise<string> {
    const state = await deriveState(root);
    const lines = [
      `relay-mesh watch — ${root} — round ${state.round ?? "(none)"} — ${state.phase} — ${new Date().toISOString()}`,
    ];
    if (state.round === null) {
      lines.push("", "(no rounds yet)");
    } else {
      const rows = await readPairRows(root, state.round);
      lines.push(
        "",
        renderTable(
          ["pair", "status", "steps", "pct", "bytes"],
          rows.map((r) => [
            r.pair,
            r.block?.status ?? (r.bytes === null ? "(no report)" : "(in-flight)"),
            r.block ? `${r.block.steps_done}/${r.block.steps_total}` : "-",
            r.block ? `${pctOf(r.block)}%` : "-",
            // A .part size is the liveness signal while an executor streams.
            r.bytes === null ? "-" : r.live ? `${r.bytes} (.part)` : String(r.bytes),
          ]),
        ),
      );
      const events = ((await safeRead(meshPaths(root).round(state.round).eventsNdjson)) ?? "")
        .split("\n")
        .filter(Boolean);
      lines.push("", `events (${events.length} total, last ${Math.min(events.length, EVENTS_TAIL)}):`);
      for (const e of events.slice(-EVENTS_TAIL)) lines.push(`  ${e}`);
    }
    lines.push("", "Ctrl-C to exit");
    return CLEAR + lines.join("\n") + "\n";
  }

  let stopped = false;
  const done = new Promise<void>((resolve) => {
    process.once("SIGINT", () => {
      stopped = true;
      resolve();
    });
  });

  // Frames are chained so a slow render never overlaps the next tick; a failed
  // frame keeps the previous one on screen rather than killing the watcher.
  let chain = frame()
    .then((f) => {
      if (!stopped) process.stdout.write(f);
    })
    .catch(() => {});
  // The interval is deliberately ref'd: it is what keeps the process alive until Ctrl-C.
  const timer = setInterval(() => {
    chain = chain
      .then(frame)
      .then((f) => {
        if (!stopped) process.stdout.write(f);
      })
      .catch(() => {});
  }, intervalMs);

  await done;
  clearInterval(timer);
  return 0;
}
