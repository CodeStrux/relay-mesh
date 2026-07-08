# Internal interface seams (implementation contract)

Wave implementers: export EXACTLY these signatures so the layers compose without rework.
TypeScript, ESM, NodeNext — **relative imports must use the `.js` suffix** (`from "./report.js"`).
Runtime deps are `openai` and `zod` (v4) only. Node builtins: `node:util` `parseArgs`,
`process.loadEnvFile`, `node:crypto` `createHash`, `node:fs/promises`.

## src/relay/report.ts

```ts
export type Status = "complete" | "partial" | "blocked";
export interface StatusBlock {
  area: string; status: Status; steps_done: number; steps_total: number; plan_ref: string;
}
/** null status ⇒ report is in-flight / not authoritative. body = everything after the block. */
export function parseReport(md: string): { status: StatusBlock | null; body: string };
export function serializeStatusBlock(s: StatusBlock): string; // "---\narea: …\n---\n"
```

## src/relay/closure.ts

```ts
// status is a plain string for relay-close.sh byte-parity (the awk carries the
// report's value verbatim); canonical values are the Status union.
export interface ClosureBrief { area: string; status: string; steps_done: number; steps_total: number; pct: number; plan_ref: string; }
export interface Closure {
  pair: string; generated: string; briefs: ClosureBrief[];
  totals: { pct: number; blocked: string[] };
}
export function computeClosure(pair: string, reports: { area: string; md: string }[], generated: string): Closure;
export function rollupPair(pairDir: string, now?: Date): Promise<Closure>; // reads *.report.md, writes closure.json atomically
```

## src/relay/fsio.ts

```ts
export function atomicWrite(filePath: string, content: string): Promise<void>; // .part + rename, mkdir -p
export function safeRead(filePath: string): Promise<string | null>;            // null if missing
export function listVisible(dir: string): Promise<string[]>;                   // skips *.part and dotfiles; [] if missing
export function appendLine(filePath: string, line: string): Promise<void>;     // ndjson append (single host writer)
```

## src/relay/paths.ts

```ts
export interface MeshPaths { /* every path in docs/protocol.md as a method */ }
export function meshPaths(root: string): {
  root: string; meshJson: string; goal: string; inputsDir: string; usage: string; roundsDir: string;
  round(r: string): {
    dir: string; plan: string; approval: string; roster: string; rosterApproval: string;
    reconPair(profileName: string): string;         // rounds/rX/recon/planner__<profileName>
    execPair(area: string, shard?: number): string; // planner__<area> | planner__<area>__w<shard>
    brief(pairDir: string, area: string): string; report(pairDir: string, area: string): string;
    closure(pairDir: string): string;
    // shard undefined ⇒ workspace/<area>/… (byte-identical to today); else workspace/<area>/w<shard>/…
    workspace(area: string, shard?: number): string; workspaceFiles(area: string, shard?: number): string; raw(area: string, shard?: number): string;
    eventsNdjson: string; rollup: string; verdictJson: string; verdictMd: string;
    usageDir: string; usageStage(stage: string): string;   // rounds/rX/usage/<stage>.json
    transcriptsDir: string;
  };
};
export function nextRound(existing: string[]): string; // ["r001"] -> "r002"; [] -> "r001"
```

## src/relay/state.ts

```ts
export type Phase = "idle" | "recon" | "synthesis" | "awaiting-approval" | "replanning"
  | "awaiting-roster" | "roster-revising" | "executing" | "rollup" | "verifying" | "fix-planning" | "done";
export interface PairState { pair: string; area: string; hasBrief: boolean; hasReport: boolean; status: import("./report.js").Status | null; }
export interface RunState {
  root: string; round: string | null; phase: Phase;
  recon: PairState[]; exec: PairState[];
  approval: { decision: "approved" | "rejected"; planSha256: string } | null;
  planSha256: string | null;   // current hash of plan.md, null if absent
  rosterApproval: { decision: "approved" | "rejected"; rosterSha256: string } | null;
  rosterSha256: string | null; // current hash of roster.json, null if absent
  verdict: { satisfied: boolean } | null;
}
export function deriveState(root: string): Promise<RunState>; // pure fn of the filesystem, per docs/protocol.md
/** shard-aware area from a pair name: strips a trailing __w<i>, then the sender prefix. */
export function areaOf(pairName: string, files: string[], recon: boolean): string;
```

## src/relay/artifacts.ts

```ts
export interface ExtractResult {
  files: { relpath: string; bytes: number }[];
  reportMd: string | null;      // the REPORT section incl. status block, or null if unparseable
  problems: string[];           // human-readable parse problems (traversal rejects, unterminated blocks…)
}
export function extractArtifacts(output: string): ExtractResult;                    // pure parse
export function writeArtifacts(res: ExtractResult, areaWorkspaceDir: string, output: string): Promise<void>;
// writes files under <ws>/files/ (paths validated); raw.md when reportMd === null
// or problems is non-empty — tokens are never lost (docs/protocol.md)
```

## src/openrouter.ts

```ts
export type Effort = "low" | "medium" | "high" | "xhigh";
export type LlmContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }      // data: URLs for local files
  | { type: "video_url"; video_url: { url: string } };
export interface LlmCallOpts {
  model: string; effort: Effort; system: string;
  user: LlmContentPart[];
  maxOutputTokens?: number; timeoutMs: number;
  onChunk?: (text: string) => void;                        // streaming hook
}
export interface LlmResult { text: string; usage: { in: number; out: number }; }
export interface LlmClient { complete(opts: LlmCallOpts): Promise<LlmResult>; listModels(): Promise<string[]>; }
export function makeOpenRouterClient(cfg: { apiKey: string; baseUrl: string; referer: string; title: string }): LlmClient;
// effort mapping: low|medium|high -> reasoning:{effort}; xhigh -> reasoning:{effort:"high"};
// on HTTP 400 mentioning "reasoning", retry once with the param stripped + one-line warning.
// Retry once ONLY if failure precedes the first streamed chunk. Never retry on abort.
```

## src/config.ts

```ts
export interface Config {
  apiKey: string; baseUrl: string; referer: string; title: string;
  relayRoot: string; profilesPath: string;
  monitorPollMs: number; maxFixRounds: number; debug: boolean;
  execFileBytes: number; execBundleBytes: number; // executor source-context caps (RELAY_EXEC_*_BYTES)
  modelFor(envName: string): string;   // env value ?? DEFAULTS[envName] ?? throw MissingEnvError (friendly table)
}
export function loadConfig(opts?: { requireApiKey?: boolean }): Config; // process.loadEnvFile(".env") if present — never throw if .env missing
export const MODEL_DEFAULTS: Record<string, string>; // the † defaults from .env.example
```

## src/profiles.ts

```ts
export type Role = "planner" | "recon" | "executor" | "monitor" | "verifier";
export interface Profile {
  name: string; role: Role; domain: string; area?: string;
  modelEnv: string; effort: import("./openrouter.js").Effort;
  prompt: string; multimodal: boolean; maxOutputTokens?: number;
  template?: boolean; // an area-less executor persona the roster mints new domains from
}
export function loadProfiles(path: string): Promise<Profile[]>; // zod-validated; unique names; exactly 1 planner/monitor/verifier; unique CONCRETE executor areas; area/domain !~ /^w\d+$/
export function byRole(profiles: Profile[], role: Role): Profile[];
```

## src/relay/briefs.ts

```ts
export const BRIEF_HEADING: string; // "## Domain brief:"
/** area → brief body, parsed from an approved plan.md's "## Domain brief: <area>" sections. */
export function extractDomainBriefs(planMd: string): Map<string, string>;
```

## src/relay/roster.ts

The execute-stage fan-out contract (gate #2). Pure + deterministic — no LLM. Models resolve only
through slot names; an inline id or unknown slot is a lint failure and an `expandRoster` throw.

```ts
export interface RosterEntry { domain: string; template: string; count: number; modelEnv: string; effort: import("../openrouter.js").Effort; }
export interface Roster { version: 1; execute: RosterEntry[]; }
export interface WorkerSpec {
  profile: import("../profiles.js").Profile;  // minted per shard: name=domain|domain__w<i>, area=domain, DOMAIN=domain
  domain: string; area: string;
  pairName: string;            // planner__<area> (count 1) | planner__<area>__w<i> (count>1)
  shardIndex: number; shardCount: number;
  briefBody: string;           // verbatim plan brief + shardInstruction(i,n)
}
export const rosterSchema; // z.strictObject ⇒ an inline `model` key is a PARSE error
export function parseRoster(raw: string): Roster;
export function serializeRoster(r: Roster): string;      // 2-space + trailing \n (byte-stable, for sha)
export function rosterSha256(rawBytes: string): string;  // over EXACT on-disk bytes (mirrors sha256(plan.md))
export function loadRoster(path: string): Promise<{ roster: Roster; raw: string; sha256: string } | null>;
export function defaultRoster(planMd: string, profiles: Profile[]): Roster;  // no-advisor fallback: one entry per brief heading
export function expandRoster(planMd: string, roster: Roster, profiles: Profile[]): WorkerSpec[]; // pure; re-checks models-lock/reserved/brief (throws)
export function shardInstruction(i: number, n: number): string;             // "" when n===1 (byte-identical single-worker path)
export function knownSlots(profiles: Profile[]): Set<string>;               // Object.keys(MODEL_DEFAULTS) ∪ every profile.modelEnv
export function lintRoster(planMd: string, roster: Roster, profiles: Profile[], config: import("../config.js").Config): string[]; // gate-#2 problems; [] = ok
```

## src/prompts.ts

```ts
/** Loads a profile prompt file; expands "{{> _partial.md}}" includes (one level) from prompts/;
 *  interpolates {{GOAL}}, {{REPORT_PATH}}, {{AREA}}, {{ROUND}} style vars. Concatenation only. */
export function composePrompt(promptPath: string, vars: Record<string, string>): Promise<string>;
```

## src/usage.ts

```ts
export type Stage = "recon" | "execute" | "verify";
export interface UsageLine { ts: string; round: string; profile: string; model: string; in: number; out: number; stage?: Stage; domain?: string; }
export function recordUsage(usagePath: string, line: UsageLine): Promise<void>;
export function readUsage(usagePath: string): Promise<UsageLine[]>;
export function aggregate(lines: UsageLine[], by: "profile" | "round" | "model" | "domain" | "stage"): { key: string; in: number; out: number; calls: number }[];

// Per-domain stage roll-up (the JSON token report at each stage boundary).
export interface DomainUsage { domain: string; agents: number; calls: number; in: number; out: number; total: number; }
export interface StageUsage { stage: Stage; round: string; generated: string; byDomain: DomainUsage[]; totals: { calls: number; in: number; out: number; total: number }; }
export function secondsStamp(now?: Date): string;   // ISO with .SSS stripped (closure `generated` convention)
export function makeResolver(profiles: import("./profiles.js").Profile[]): (line: UsageLine) => string; // line→domain, legacy-tolerant
export function rollupStage(lines: UsageLine[], stage: Stage, round: string, generated: string, resolve?: (l: UsageLine) => string): StageUsage; // pure
export function writeStageRollup(path: string, lines: UsageLine[], stage: Stage, round: string, resolve?: (l: UsageLine) => string, now?: Date): Promise<void>; // atomicWrite
```

## src/context.ts

```ts
/** Read-only project bundle for recon: git-aware file tree + key file contents, size-capped. */
export function bundleProject(projectPath: string, capBytes?: number): Promise<string>; // default cap ~30_000

/** Deterministic path-like tokens (backticked incl. [](){}+ route paths, slash paths, dotted
 *  filenames, well-known extensionless files) from prose; rejects relay-internal artifact paths;
 *  deduped in first-mention order across texts in the order given. */
export function extractPathHints(texts: string[]): string[];

export interface ExecutorBundle {
  text: string;      // file tree + full file contents + context manifest
  included: string[]; // rel paths inlined whole
  omitted: string[];  // rel paths matched but not inlined (caps, binary, non-UTF-8) — named in the manifest
  missing: string[];  // slash-hints that resolved to nothing (new-file candidates)
}
/** FULL current contents of the project files the hints reference, whole-file-or-nothing
 *  under the caps (RELAY_EXEC_FILE_BYTES / RELAY_EXEC_BUNDLE_BYTES). No silent truncation.
 *  Contained to the project via realpath (symlinks escaping the root are rejected); honors
 *  .gitignore and the .git/.env guard; `area` strips a leading `<area>/` on a missed slash-hint. */
export function bundleForExecutor(
  projectPath: string,
  hints: string[],
  caps: { perFileBytes: number; totalBytes: number },
  area?: string,
): Promise<ExecutorBundle>;
```

## src/agents/call.ts

```ts
import type { LlmClient } from "../openrouter.js";
import type { Profile } from "../profiles.js";
export interface CallCtx { client: LlmClient; config: import("../config.js").Config; round: string; stage: import("../usage.js").Stage; usagePath: string; transcriptsDir: string; }
/** One profile call: compose prompt → stream to <outPath>.part (via onChunk) → rename; usage line; transcript.
 *  publish: false skips the rename — the .part still streams for liveness and the CALLER publishes
 *  (raw executor/planner output must never become protocol-visible before it is vetted). */
export function callProfile(ctx: CallCtx, profile: Profile, userParts: import("../openrouter.js").LlmContentPart[], outPath: string, vars: Record<string, string>, opts?: { publish?: boolean }): Promise<string>; // returns final text
```

## CLI conventions (src/cli.ts + src/commands/*)

- `node:util parseArgs` with a dispatch table; each command module exports
  `run(argv: string[]): Promise<number>` returning the exit code (0/1/2/3 per protocol).
- Three-line error style: what broke (literal) / what the tool believes / what to do next.
  Stack traces only when `RELAY_DEBUG=1`.
- Commands never hold state between invocations; first act is `deriveState`.

## Testing conventions

- `test/fakes/llm.ts` exports `class FakeLlmClient implements LlmClient` scripted per profile/model
  with queued responses, failures, timeouts, malformed outputs; zero network anywhere in tests.
- Fixtures live in `test/fixtures/` as builders (functions that lay a relay root in a tmpdir),
  not committed trees.
