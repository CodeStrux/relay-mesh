/** usage.ndjson accounting — one line per LLM call, single-host writer per protocol. */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface UsageLine {
  ts: string;
  round: string;
  profile: string;
  model: string;
  in: number;
  out: number;
}

export async function recordUsage(usagePath: string, line: UsageLine): Promise<void> {
  await mkdir(dirname(usagePath), { recursive: true });
  await appendFile(usagePath, JSON.stringify(line) + "\n", "utf8");
}

export async function readUsage(usagePath: string): Promise<UsageLine[]> {
  let raw: string;
  try {
    raw = await readFile(usagePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const lines: UsageLine[] = [];
  for (const l of raw.split("\n")) {
    if (l.trim() === "") continue;
    try {
      lines.push(JSON.parse(l) as UsageLine);
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
