import { basename, join } from "node:path";
import { atomicWrite, listVisible, safeRead } from "./fsio.js";

export interface ClosureBrief {
  area: string;
  // Any string, for relay-close.sh byte-parity — canonical values are the
  // Status union, but the awk carries whatever the report said verbatim.
  status: string;
  steps_done: number;
  steps_total: number;
  pct: number;
  plan_ref: string;
}

export interface Closure {
  pair: string;
  generated: string;
  briefs: ClosureBrief[];
  totals: { pct: number; blocked: string[] };
}

/**
 * Numeric coercion pinned to the leading INTEGER prefix ("3.7" → 3, "5e1" → 5,
 * "abc" → 0). awk implementations disagree on float coercion (BSD awk truncates,
 * gawk keeps the fraction), so the port takes the strictest common reading —
 * canonical status blocks only ever carry integers.
 */
function awkNum(value: string): number {
  const m = /^[ \t]*[-+]?\d+/.exec(value);
  return m ? Number(m[0]) : 0;
}

interface AwkBrief {
  area: string;
  status: string;
  done: number;
  total: number;
  plan_ref: string;
}

/**
 * Faithful port of relay-close.sh's awk over ONE report file: every `---` line
 * toggles the frontmatter state (a horizontal rule in the body re-opens it,
 * exactly like the awk), keys are matched as `$1 == "key:"`, values get the
 * trailing-comment strip + trim of getval(), and missing keys keep awk defaults
 * ("" / 0). The last occurrence of a key wins.
 */
function parseAwkBrief(md: string): AwkBrief {
  let infm = false;
  let area = "";
  let status = "";
  let plan_ref = "";
  let done = 0;
  let total = 0;
  for (const line of md.split("\n")) {
    if (/^---[ \t]*$/.test(line)) {
      infm = !infm;
      continue;
    }
    if (!infm) continue;
    const f1 = line.trimStart().split(/[ \t]+/, 1)[0] ?? ""; // awk $1
    const getval = (): string =>
      line
        .replace(/^[^:]*:[ \t]*/, "")
        .replace(/[ \t]+#.*$/, "")
        .replace(/^[ \t]+|[ \t]+$/g, "");
    if (f1 === "area:") area = getval();
    else if (f1 === "status:") status = getval();
    else if (f1 === "steps_done:") done = awkNum(getval());
    else if (f1 === "steps_total:") total = awkNum(getval());
    else if (f1 === "plan_ref:") plan_ref = getval();
  }
  return { area, status, done, total, plan_ref };
}

/**
 * Deterministic roll-up, byte-compatible with relay-close.sh (the same reports
 * produce the same closure.json, key order included):
 * pct = int(done*100/total); total==0 => 100 iff status=="complete" else 0;
 * totals.pct = int(Σdone*100/Σtotal) (0 when Σtotal==0); blocked areas in order.
 * Like the awk's flush(), a report contributes only when it set an `area:` key.
 */
export function computeClosure(
  pair: string,
  reports: { area: string; md: string }[],
  generated: string,
): Closure {
  const briefs: ClosureBrief[] = [];
  const blocked: string[] = [];
  let sumDone = 0;
  let sumTotal = 0;

  for (const r of reports) {
    const b = parseAwkBrief(r.md);
    if (b.area === "") continue; // the awk flush() no-ops without an area
    const pct =
      b.total > 0
        ? Math.trunc((b.done * 100) / b.total)
        : b.status === "complete"
          ? 100
          : 0;
    briefs.push({
      area: b.area,
      status: b.status,
      steps_done: Math.trunc(b.done), // awk %d truncation
      steps_total: Math.trunc(b.total),
      pct,
      plan_ref: b.plan_ref,
    });
    sumDone += b.done;
    sumTotal += b.total;
    if (b.status === "blocked") blocked.push(b.area);
  }

  const totalPct = sumTotal > 0 ? Math.trunc((sumDone * 100) / sumTotal) : 0;
  return { pair, generated, briefs, totals: { pct: totalPct, blocked } };
}

/** Reads every *.report.md in the pair dir (sorted, glob order) and writes closure.json atomically. */
export async function rollupPair(pairDir: string, now?: Date): Promise<Closure> {
  const names = (await listVisible(pairDir)).filter((n) => n.endsWith(".report.md"));
  const reports: { area: string; md: string }[] = [];
  for (const name of names) {
    const md = await safeRead(join(pairDir, name));
    if (md !== null) reports.push({ area: name.slice(0, -".report.md".length), md });
  }
  // date -u +%FT%TZ shape: seconds precision, no milliseconds.
  const generated = (now ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
  const closure = computeClosure(basename(pairDir), reports, generated);
  await atomicWrite(join(pairDir, "closure.json"), `${JSON.stringify(closure)}\n`);
  return closure;
}
