/**
 * roster.json — the human-gated execute-stage fleet spec (gate #2).
 *
 * The roster is the single authority for which executor workers run in a round.
 * Per domain it declares a `count` (shards), a model SLOT (`modelEnv` — a name,
 * never an inline model id), an `effort`, and a `template` (an executor profile
 * that supplies the persona/prompt). After the human approves it, the roster is
 * expanded DETERMINISTICALLY into WorkerSpecs (no LLM), exactly mirroring how the
 * plan gate extracts verbatim domain briefs.
 *
 * Models resolve ONLY via config.modelFor(modelEnv): the roster names a slot from
 * a fixed allowlist (profiles' modelEnv ∪ MODEL_DEFAULTS keys), so the advisor can
 * pick among operator-declared slots but can never inject a model id or bind a
 * worker to an arbitrary env var.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { MODEL_DEFAULTS, type Config } from "../config.js";
import type { Effort } from "../openrouter.js";
import type { Profile } from "../profiles.js";
import { extractDomainBriefs } from "./briefs.js";
import { safeRead } from "./fsio.js";

/** Upper bound on workers per domain (a runaway-roster backstop). */
export const MAX_SHARDS = 16;

/** The shard-suffix namespace (planner__<area>__w<i>); reserved as a domain/area name. */
export const RESERVED_AREA = /^w\d+$/;

const EFFORTS = ["low", "medium", "high", "xhigh"] as const;

export interface RosterEntry {
  domain: string; // executor area; may be NEW (minted) — MUST have "## Domain brief: <domain>" in plan.md
  template: string; // an executor profile NAME; supplies prompt/multimodal/maxOutputTokens
  count: number; // >=1 shards
  modelEnv: string; // a SLOT NAME from the allowlist; resolved ONLY via config.modelFor
  effort: Effort;
}

export interface Roster {
  version: 1;
  execute: RosterEntry[];
}

export interface WorkerSpec {
  profile: Profile; // minted from the template: name/domain/area = the domain, modelEnv/effort from the roster
  domain: string;
  area: string;
  pairName: string; // planner__<area> (count 1) | planner__<area>__w<i> (count>1)
  shardIndex: number; // 1-based
  shardCount: number;
  briefBody: string; // verbatim plan brief + shardInstruction(i, n)
}

const rosterEntrySchema = z.strictObject({
  domain: z.string().min(1),
  template: z.string().min(1),
  count: z.number().int().min(1).max(MAX_SHARDS).default(1),
  modelEnv: z.string().min(1),
  effort: z.enum(EFFORTS),
});

/** strictObject ⇒ an inline `model` key (or any stray key) is a parse error. */
export const rosterSchema = z.strictObject({
  version: z.literal(1),
  execute: z.array(rosterEntrySchema).min(1),
});

export function parseRoster(raw: string): Roster {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      [
        `roster.json: not valid JSON — ${(err as Error).message}`,
        "roster.json declares the execute-stage fleet and must parse before the gate can show it",
        "fix the JSON syntax, then re-run relay-mesh roster",
      ].join("\n"),
    );
  }
  const parsed = rosterSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      [
        `roster.json: invalid — ${parsed.error.issues
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; ")}`,
        "the roster must validate before the gate can show it",
        "fix the listed fields in roster.json, then re-run relay-mesh roster",
      ].join("\n"),
    );
  }
  return parsed.data;
}

/** Byte-stable JSON (2-space + trailing newline), so the on-disk sha256 is deterministic. */
export function serializeRoster(roster: Roster): string {
  return `${JSON.stringify(roster, null, 2)}\n`;
}

/** sha256 over the EXACT on-disk bytes (mirrors sha256(plan.md) at the plan gate). */
export function rosterSha256(rawBytes: string): string {
  return createHash("sha256").update(rawBytes).digest("hex");
}

export async function loadRoster(
  path: string,
): Promise<{ roster: Roster; raw: string; sha256: string } | null> {
  const raw = await safeRead(path);
  if (raw === null) return null;
  return { roster: parseRoster(raw), raw, sha256: rosterSha256(raw) };
}

/** The sanctioned model slots: every profile's modelEnv ∪ the MODEL_DEFAULTS keys. */
export function knownSlots(profiles: Profile[]): Set<string> {
  const slots = new Set<string>(Object.keys(MODEL_DEFAULTS));
  for (const p of profiles) slots.add(p.modelEnv);
  return slots;
}

/** Extra brief text appended to a sharded worker's body (empty for a single worker). */
export function shardInstruction(index: number, count: number): string {
  if (count <= 1) return "";
  return [
    "",
    `## Shard ${index} of ${count}`,
    "",
    `You are worker ${index} of ${count} on this domain, running in parallel with the other workers.`,
    `Do ONLY the brief's asks at 1-based positions ${index}, ${index + count}, ${index + 2 * count}, … (every ${count}th ask starting at ask ${index}). The other workers cover the remaining asks.`,
    "Set steps_total to the number of asks in YOUR shard and report only on those. Do not edit files outside your shard's asks.",
    "",
  ].join("\n");
}

/** The no-advisor fallback: one count-1 entry per "## Domain brief:" heading in plan.md. */
export function defaultRoster(planMd: string, profiles: Profile[]): Roster {
  const executors = profiles.filter((p) => p.role === "executor");
  const fallback = executors.find((p) => p.area !== undefined) ?? executors[0];
  const execute: RosterEntry[] = [];
  for (const domain of extractDomainBriefs(planMd).keys()) {
    const template = executors.find((p) => p.area === domain) ?? fallback;
    if (template === undefined) continue; // no executor profiles at all
    execute.push({
      domain,
      template: template.name,
      count: 1,
      modelEnv: template.modelEnv,
      effort: template.effort,
    });
  }
  return { version: 1, execute };
}

/**
 * Deterministic expansion (NO LLM) of an approved roster into worker specs.
 * Each entry yields `count` workers, minted from the template with area = domain.
 * Re-checks the models-lock and brief presence as defence-in-depth at spawn.
 */
export function expandRoster(planMd: string, roster: Roster, profiles: Profile[]): WorkerSpec[] {
  const briefs = extractDomainBriefs(planMd);
  const executors = profiles.filter((p) => p.role === "executor");
  const slots = knownSlots(profiles);
  const workers: WorkerSpec[] = [];
  for (const entry of roster.execute) {
    const d = entry.domain;
    if (RESERVED_AREA.test(d)) {
      throw new Error(`expandRoster: reserved domain name "${d}" (matches /^w\\d+$/)`);
    }
    const brief = briefs.get(d);
    if (brief === undefined) {
      throw new Error(`expandRoster: roster domain "${d}" has no "## Domain brief: ${d}" in the plan`);
    }
    if (entry.modelEnv.includes("/") || !slots.has(entry.modelEnv)) {
      throw new Error(`expandRoster: roster modelEnv "${entry.modelEnv}" is not a known model slot`);
    }
    const template = executors.find((p) => p.name === entry.template);
    if (template === undefined) {
      throw new Error(`expandRoster: roster template "${entry.template}" is not an executor profile`);
    }
    const count = entry.count;
    for (let i = 1; i <= count; i++) {
      const pairName = count === 1 ? `planner__${d}` : `planner__${d}__w${i}`;
      const profile: Profile = {
        ...template,
        name: count === 1 ? d : `${d}__w${i}`,
        role: "executor",
        domain: d, // usage/per-domain accounting keys on this
        area: d,
        modelEnv: entry.modelEnv,
        effort: entry.effort,
      };
      workers.push({
        profile,
        domain: d,
        area: d,
        pairName,
        shardIndex: i,
        shardCount: count,
        briefBody: brief + shardInstruction(i, count),
      });
    }
  }
  return workers;
}

/**
 * Gate #2 lint (mirrors lintPlan): fail-closed problems that block roster
 * approval. An empty list means the roster is safe to approve and expand.
 */
export function lintRoster(
  planMd: string,
  roster: Roster,
  profiles: Profile[],
  config: Config,
): string[] {
  const problems: string[] = [];
  const briefs = extractDomainBriefs(planMd);
  const executors = profiles.filter((p) => p.role === "executor");
  const slots = knownSlots(profiles);
  const seen = new Set<string>();
  for (const entry of roster.execute) {
    const d = entry.domain;
    if (seen.has(d)) problems.push(`duplicate roster domain "${d}"`);
    seen.add(d);
    if (RESERVED_AREA.test(d)) {
      problems.push(`roster domain "${d}" is reserved (matches /^w\\d+$/, the shard-suffix namespace)`);
    }
    if (!briefs.has(d)) {
      problems.push(`roster domain "${d}" has no "## Domain brief: ${d}" in the plan`);
    }
    if (!executors.some((p) => p.name === entry.template)) {
      problems.push(`roster domain "${d}": template "${entry.template}" is not an executor profile`);
    }
    if (entry.modelEnv.includes("/")) {
      problems.push(
        `roster domain "${d}": modelEnv "${entry.modelEnv}" looks like an inline model id (contains "/") — name a model SLOT; models come only from .env`,
      );
    } else if (!slots.has(entry.modelEnv)) {
      problems.push(
        `roster domain "${d}": modelEnv "${entry.modelEnv}" is not a known model slot (declare it in profiles.json, MODEL_DEFAULTS, or .env)`,
      );
    } else {
      try {
        config.modelFor(entry.modelEnv);
      } catch {
        problems.push(
          `roster domain "${d}": modelEnv "${entry.modelEnv}" does not resolve to a model — set ${entry.modelEnv} in .env`,
        );
      }
    }
  }
  return problems;
}
