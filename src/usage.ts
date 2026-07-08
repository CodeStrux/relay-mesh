/** usage.ndjson accounting — one line per LLM call, single-host writer per protocol. */
import type { Profile } from "./profiles.js";
import { appendLine, atomicWrite, safeRead } from "./relay/fsio.js";

export type Stage = "recon" | "execute" | "verify";

export interface UsageLine {
  ts: string;
  round: string;
  profile: string;
  model: string;
  in: number;
  out: number;
  stage?: Stage; // which pipeline stage the call belongs to (added by callProfile)
  domain?: string; // the profile's domain — the key for per-domain rollups
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
  by: "profile" | "round" | "model" | "domain" | "stage",
): { key: string; in: number; out: number; calls: number }[] {
  const acc = new Map<string, { key: string; in: number; out: number; calls: number }>();
  for (const line of lines) {
    const key = String(line[by] ?? "(none)"); // domain/stage may be absent on legacy lines
    const row = acc.get(key) ?? { key, in: 0, out: 0, calls: 0 };
    row.in += line.in;
    row.out += line.out;
    row.calls += 1;
    acc.set(key, row);
  }
  return [...acc.values()];
}

export interface DomainUsage {
  domain: string;
  agents: number; // distinct profiles that ran for this domain (shards count separately)
  calls: number;
  in: number;
  out: number;
  total: number;
}

export interface StageUsage {
  stage: Stage;
  round: string;
  generated: string;
  byDomain: DomainUsage[];
  totals: { calls: number; in: number; out: number; total: number };
}

/** Seconds-precision ISO stamp (matches the closure.json `generated` convention). */
export function secondsStamp(now: Date = new Date()): string {
  return now.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * A line → domain resolver that tolerates legacy lines (no `domain` field):
 * fall back to the profile's declared domain, then to the profile name with any
 * shard suffix stripped, so minted/sharded workers still fold under one domain.
 */
export function makeResolver(profiles: Profile[]): (line: UsageLine) => string {
  const domainOf = new Map(profiles.map((p) => [p.name, p.domain]));
  return (line) => line.domain ?? domainOf.get(line.profile) ?? line.profile.replace(/__w\d+$/, "");
}

/** Pure per-domain roll-up of one (round, stage) slice — idempotently recomputable. */
export function rollupStage(
  lines: UsageLine[],
  stage: Stage,
  round: string,
  generated: string,
  resolve?: (line: UsageLine) => string,
): StageUsage {
  const rows = lines.filter((l) => l.round === round && l.stage === stage);
  const acc = new Map<string, { in: number; out: number; calls: number; profiles: Set<string> }>();
  for (const l of rows) {
    const domain = resolve ? resolve(l) : (l.domain ?? l.profile);
    const row = acc.get(domain) ?? { in: 0, out: 0, calls: 0, profiles: new Set<string>() };
    row.in += l.in;
    row.out += l.out;
    row.calls += 1;
    row.profiles.add(l.profile);
    acc.set(domain, row);
  }
  const byDomain: DomainUsage[] = [...acc.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([domain, r]) => ({
      domain,
      agents: r.profiles.size,
      calls: r.calls,
      in: r.in,
      out: r.out,
      total: r.in + r.out,
    }));
  const totals = byDomain.reduce(
    (t, d) => ({ calls: t.calls + d.calls, in: t.in + d.in, out: t.out + d.out, total: t.total + d.total }),
    { calls: 0, in: 0, out: 0, total: 0 },
  );
  return { stage, round, generated, byDomain, totals };
}

/** Atomically write a stage's per-domain roll-up JSON. Non-authoritative — safe to recompute. */
export async function writeStageRollup(
  path: string,
  lines: UsageLine[],
  stage: Stage,
  round: string,
  resolve?: (line: UsageLine) => string,
  now?: Date,
): Promise<void> {
  const rollup = rollupStage(lines, stage, round, secondsStamp(now), resolve);
  await atomicWrite(path, `${JSON.stringify(rollup, null, 2)}\n`);
}
