export type Status = "complete" | "partial" | "blocked";

export interface StatusBlock {
  area: string;
  status: Status;
  steps_done: number;
  steps_total: number;
  plan_ref: string;
}

// Same delimiter the relay-close.sh awk uses: /^---[ \t]*$/ (plus CRLF tolerance).
const DELIM = /^---[ \t]*\r?$/;
const KEYS = ["area", "status", "steps_done", "steps_total", "plan_ref"] as const;
type Key = (typeof KEYS)[number];

// awk parity: a trailing "# comment" is stripped only when preceded by whitespace.
function stripComment(value: string): string {
  return value.replace(/[ \t]+#.*$/, "").trim();
}

/**
 * Parse the flat key:value status block a report must open with (first line "---",
 * closed by "---"). null status => report is in-flight / not authoritative.
 * body = everything after the closing delimiter (the whole input when no block parses).
 */
export function parseReport(md: string): { status: StatusBlock | null; body: string } {
  const lines = md.split("\n");
  if (lines.length === 0 || !DELIM.test(lines[0]!)) return { status: null, body: md };

  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (DELIM.test(lines[i]!)) {
      close = i;
      break;
    }
  }
  if (close === -1) return { status: null, body: md };

  const body = lines.slice(close + 1).join("\n");
  const raw: Partial<Record<Key, string>> = {};
  for (const line of lines.slice(1, close)) {
    const m = /^[ \t]*([A-Za-z_]+):(.*)$/.exec(line.replace(/\r$/, ""));
    if (!m) continue; // unknown / malformed lines inside the block are ignored, like the awk
    const key = m[1] as Key;
    if ((KEYS as readonly string[]).includes(key)) raw[key] = stripComment(m[2]!);
  }

  const { area, status, steps_done, steps_total, plan_ref } = raw;
  if (!area || !plan_ref || status === undefined || steps_done === undefined || steps_total === undefined) {
    return { status: null, body };
  }
  if (status !== "complete" && status !== "partial" && status !== "blocked") return { status: null, body };
  if (!/^\d+$/.test(steps_done) || !/^\d+$/.test(steps_total)) return { status: null, body };

  return {
    status: {
      area,
      status,
      steps_done: Number(steps_done),
      steps_total: Number(steps_total),
      plan_ref,
    },
    body,
  };
}

export function serializeStatusBlock(s: StatusBlock): string {
  return [
    "---",
    `area: ${s.area}`,
    `status: ${s.status}`,
    `steps_done: ${s.steps_done}`,
    `steps_total: ${s.steps_total}`,
    `plan_ref: ${s.plan_ref}`,
    "---",
    "",
  ].join("\n");
}
