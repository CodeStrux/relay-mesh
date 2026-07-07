/** usage.ndjson accounting — one line per LLM call, single-host writer per protocol. */
import { appendLine, safeRead } from "./relay/fsio.js";

export interface UsageLine {
  ts: string;
  round: string;
  profile: string;
  model: string;
  in: number;
  out: number;
}

/** Shape guard: a valid-JSON line of the wrong shape (hand edit, other tool
 *  version, sync conflict-merge) must not poison the sums with NaN. */
function isUsageLine(v: unknown): v is UsageLine {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.ts === "string" &&
    typeof o.round === "string" &&
    typeof o.profile === "string" &&
    typeof o.model === "string" &&
    typeof o.in === "number" &&
    Number.isFinite(o.in) &&
    typeof o.out === "number" &&
    Number.isFinite(o.out)
  );
}

export async function recordUsage(usagePath: string, line: UsageLine): Promise<void> {
  await appendLine(usagePath, JSON.stringify(line));
}

export async function readUsage(usagePath: string): Promise<UsageLine[]> {
  const raw = await safeRead(usagePath); // missing file (or a file mid-path) => no usage
  if (raw === null) return [];
  const lines: UsageLine[] = [];
  for (const l of raw.split("\n")) {
    if (l.trim() === "") continue;
    try {
      const parsed: unknown = JSON.parse(l);
      if (isUsageLine(parsed)) lines.push(parsed);
    } catch {
      // Torn trailing line mid-append on a shared root — skip, never crash a read.
    }
  }
  return lines;
}

export function aggregate(
  lines: UsageLine[],
  by: "profile" | "round" | "model",
): { key: string; in: number; out: number; calls: number }[] {
  const acc = new Map<string, { key: string; in: number; out: number; calls: number }>();
  for (const line of lines) {
    const key = line[by];
    const row = acc.get(key) ?? { key, in: 0, out: 0, calls: 0 };
    row.in += line.in;
    row.out += line.out;
    row.calls += 1;
    acc.set(key, row);
  }
  return [...acc.values()];
}
