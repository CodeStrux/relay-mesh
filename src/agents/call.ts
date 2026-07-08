/** One profile LLM call: compose prompt → stream to <outPath>.part → publish → account. */
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { Config } from "../config.js";
import type { LlmClient, LlmContentPart } from "../openrouter.js";
import type { Profile, Role } from "../profiles.js";
import { composePrompt } from "../prompts.js";
import { atomicWrite } from "../relay/fsio.js";
import { recordUsage, type Stage } from "../usage.js";

/** Per-role LLM call timeouts (ms). */
export const TIMEOUT_MS: Record<Role, number> = {
  recon: 300_000,
  monitor: 300_000,
  planner: 600_000,
  verifier: 600_000,
  executor: 900_000,
};

export interface CallCtx {
  client: LlmClient;
  config: Config;
  round: string;
  stage: Stage;
  usagePath: string;
  transcriptsDir: string;
}

// Same-millisecond calls (re-prompts, fast fakes in tests) must not collide on transcript names.
let transcriptSeq = 0;

function partText(p: LlmContentPart): string {
  if (p.type === "text") return p.text;
  const url = p.type === "image_url" ? p.image_url.url : p.video_url.url;
  return `[${p.type}: ${url.slice(0, 64)}… (${url.length} chars)]`;
}

/**
 * Compose the profile's prompt, stream the completion into `<outPath>.part`
 * (liveness signal for watchers), publish `outPath` atomically on success,
 * append a usage line, and save the raw transcript. On failure the error
 * propagates verbatim — callers synthesize blocked reports from it.
 *
 * `publish: false` skips the final rename: the `.part` still streams for
 * liveness, but the raw output never becomes protocol-visible — the caller
 * publishes the real artifact (executor wire output can parse as a report,
 * so it must never land at a report path verbatim).
 */
export async function callProfile(
  ctx: CallCtx,
  profile: Profile,
  userParts: LlmContentPart[],
  outPath: string,
  vars: Record<string, string>,
  opts: { publish?: boolean } = {},
): Promise<string> {
  // profile.prompt paths are relative to the profiles.json that declared them.
  const promptPath = isAbsolute(profile.prompt)
    ? profile.prompt
    : join(dirname(ctx.config.profilesPath), profile.prompt);
  const system = await composePrompt(promptPath, vars);
  const model = ctx.config.modelFor(profile.modelEnv);

  // Create the .part up front so watchers see the call is live before the first chunk.
  const part = `${outPath}.part`;
  await mkdir(dirname(part), { recursive: true });
  await writeFile(part, "", "utf8");

  // Chunk appends are serialized; failures are swallowed because the .part is
  // liveness-only — the authoritative bytes are published by atomicWrite below.
  let appends: Promise<void> = Promise.resolve();
  const result = await ctx.client.complete({
    model,
    effort: profile.effort,
    system,
    user: userParts,
    maxOutputTokens: profile.maxOutputTokens,
    timeoutMs: TIMEOUT_MS[profile.role],
    onChunk: (text) => {
      appends = appends.then(() => appendFile(part, text, "utf8")).catch(() => {});
    },
  });
  // No stray append may land between atomicWrite's .part rewrite and its rename.
  await appends;

  if (opts.publish ?? true) await atomicWrite(outPath, result.text);

  await recordUsage(ctx.usagePath, {
    ts: new Date().toISOString(),
    round: ctx.round,
    profile: profile.name,
    model,
    in: result.usage.in,
    out: result.usage.out,
    stage: ctx.stage,
    domain: profile.domain,
  });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const name = `${stamp}-${String(++transcriptSeq).padStart(3, "0")}__${profile.name}.md`;
  await atomicWrite(
    join(ctx.transcriptsDir, name),
    [
      `# ${profile.name} @ ${model} — round ${ctx.round}`,
      "",
      "## System",
      "",
      system,
      "",
      "## User",
      "",
      userParts.map(partText).join("\n\n"),
      "",
      "## Output",
      "",
      result.text,
      "",
    ].join("\n"),
  );

  return result.text;
}
