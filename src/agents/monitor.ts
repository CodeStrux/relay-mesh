/** Monitoring: deterministic events.ndjson poller + ONE monitor roll-up call at phase end. */
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { Profile } from "../profiles.js";
import { appendLine, listVisible, safeRead } from "../relay/fsio.js";
import { meshPaths } from "../relay/paths.js";
import { parseReport } from "../relay/report.js";
import { callProfile, type CallCtx } from "./call.js";
import { listFilesRecursive } from "./execute.js";

const EVENTS_TAIL = 200;

export interface Poller {
  /** Clears the interval, runs one final sweep so closing deltas are recorded. */
  stop(): Promise<void>;
}

async function sizeOf(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size;
  } catch {
    return null;
  }
}

/**
 * Poll the round's exec pairs (stat + parseReport) on an interval, appending one
 * events.ndjson line per observed change. Polling, not fs.watch — the relay root
 * may live on NFS/syncthing. No AI here: observations are deterministic.
 */
export function startPoller(root: string, round: string, intervalMs: number): Poller {
  const rp = meshPaths(root).round(round);
  const execDir = join(rp.dir, "exec");
  const seen = new Map<string, string>();

  async function scan(): Promise<void> {
    for (const pair of await listVisible(execDir)) {
      if (!pair.includes("__")) continue;
      const area = pair.replace(/^.*__/, "");
      const reportPath = join(execDir, pair, `${area}.report.md`);
      // A .part's byte size is a liveness signal while the executor streams;
      // its content is never read (protocol rule 3).
      const bytes = (await sizeOf(reportPath)) ?? (await sizeOf(`${reportPath}.part`));
      if (bytes === null) continue;
      const md = await safeRead(reportPath);
      const status = md === null ? null : parseReport(md).status;
      const event = {
        t: new Date().toISOString(),
        event: "report_updated",
        pair,
        bytes,
        status: status?.status ?? null,
        steps_done: status?.steps_done ?? null,
        steps_total: status?.steps_total ?? null,
      };
      const key = JSON.stringify([event.bytes, event.status, event.steps_done, event.steps_total]);
      if (seen.get(pair) === key) continue;
      seen.set(pair, key);
      await appendLine(rp.eventsNdjson, JSON.stringify(event));
    }
  }

  // Scans are chained so ticks never overlap, and never throw — a dying poller
  // must not take the execution phase down with it.
  let chain: Promise<void> = scan().catch(() => {});
  const timer = setInterval(() => {
    chain = chain.then(scan).catch(() => {});
  }, intervalMs);
  timer.unref();

  return {
    async stop(): Promise<void> {
      clearInterval(timer);
      chain = chain.then(scan).catch(() => {});
      await chain;
    },
  };
}

/**
 * The monitor profile's ONE roll-up call: briefs, reports, closures, workspace
 * listings, and the events tail → monitor/rollup.md.
 */
export async function runRollup(
  ctx: CallCtx,
  monitor: Profile,
  args: { root: string; goal: string },
): Promise<string> {
  const rp = meshPaths(args.root).round(ctx.round);
  const execDir = join(rp.dir, "exec");

  const sections: string[] = [`## Goal\n\n${args.goal}`];
  for (const pair of await listVisible(execDir)) {
    if (!pair.includes("__")) continue;
    const pairDir = join(execDir, pair);
    const area = pair.replace(/^.*__/, "");
    const brief = await safeRead(join(pairDir, `${area}.brief.md`));
    const reportMd = await safeRead(join(pairDir, `${area}.report.md`));
    const report =
      reportMd === null
        ? "(no report yet)"
        : parseReport(reportMd).status === null
          ? `(status block does not parse yet — in-flight)\n\n${reportMd}`
          : reportMd;
    const closure = await safeRead(join(pairDir, "closure.json"));
    const files = await listFilesRecursive(join(rp.dir, "workspace", area));
    sections.push(
      [
        `## Area: ${area} (${pair})`,
        `### Brief\n\n${brief ?? "(missing)"}`,
        `### Latest report\n\n${report}`,
        `### closure.json\n\n${closure ?? "(missing)"}`,
        `### Workspace files\n\n${
          files.length ? files.map((f) => `${f.rel} (${f.size}B)`).join("\n") : "(none)"
        }`,
      ].join("\n\n"),
    );
  }

  const events = ((await safeRead(rp.eventsNdjson)) ?? "").split("\n").filter(Boolean);
  sections.push(
    `## Event log tail (${Math.min(events.length, EVENTS_TAIL)} of ${events.length} events)\n\n${
      events.slice(-EVENTS_TAIL).join("\n") || "(no events)"
    }`,
  );

  return callProfile(ctx, monitor, [{ type: "text", text: sections.join("\n\n") }], rp.rollup, {
    GOAL: args.goal,
    ROUND: ctx.round,
  });
}
