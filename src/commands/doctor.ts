/** doctor: preflight — env, profiles, prompt files, relay root, model slugs. Run first, always. */
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "../config.js";
import { makeOpenRouterClient } from "../openrouter.js";
import { loadProfiles, type Profile } from "../profiles.js";

interface Check {
  name: string;
  ok: boolean | null; // null = skipped
  detail: string;
}

function maskKey(key: string): string {
  return key.length <= 12 ? "(set)" : `${key.slice(0, 8)}…${key.slice(-4)}`;
}

function levenshtein(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return row[b.length]!;
}

/** Nearest model id: case-insensitive substring match wins, else smallest edit distance. */
export function suggestModel(slug: string, ids: string[]): string | null {
  const s = slug.toLowerCase();
  const sub = ids.find((id) => id.toLowerCase().includes(s) || s.includes(id.toLowerCase()));
  if (sub !== undefined) return sub;
  let best: string | null = null;
  let bestD = Infinity;
  for (const id of ids) {
    const d = levenshtein(s, id.toLowerCase());
    if (d < bestD) {
      bestD = d;
      best = id;
    }
  }
  return best;
}

export async function run(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { models: { type: "boolean", default: false } },
  });
  const config = loadConfig({ requireApiKey: false });
  const checks: Check[] = [];
  const push = (name: string, ok: boolean | null, detail: string): void => {
    checks.push({ name, ok, detail });
  };

  const hasKey = config.apiKey !== "";
  push("api key", hasKey, hasKey ? maskKey(config.apiKey) : "OPENROUTER_API_KEY is not set");

  let profiles: Profile[] = [];
  try {
    profiles = await loadProfiles(config.profilesPath);
    push("profiles", true, `${profiles.length} profiles (${config.profilesPath})`);
  } catch (err) {
    push("profiles", false, (err as Error).message);
  }

  if (profiles.length > 0) {
    const missing: string[] = [];
    for (const p of profiles) {
      // Same resolution rule as agents/call.ts: relative to the profiles.json that declared it.
      const path = isAbsolute(p.prompt) ? p.prompt : join(dirname(config.profilesPath), p.prompt);
      try {
        if (!(await stat(path)).isFile()) missing.push(`${p.name}: ${path} is not a file`);
      } catch {
        missing.push(`${p.name}: ${path} missing`);
      }
    }
    push(
      "prompts",
      missing.length === 0,
      missing.length === 0 ? `${profiles.length} prompt files exist` : missing.join("; "),
    );
  }

  try {
    await mkdir(config.relayRoot, { recursive: true });
    const probe = join(config.relayRoot, ".doctor-probe"); // dot-prefixed = protocol-invisible
    await writeFile(probe, "", "utf8");
    await rm(probe);
    push("relay root", true, `${config.relayRoot} writable`);
  } catch (err) {
    push("relay root", false, `${config.relayRoot}: ${(err as Error).message}`);
  }

  const envs: string[] = [];
  for (const p of profiles) if (!envs.includes(p.modelEnv)) envs.push(p.modelEnv);
  const resolved = new Map<string, string>();
  for (const env of envs) {
    try {
      const slug = config.modelFor(env);
      resolved.set(env, slug);
      push(env, true, slug);
    } catch (err) {
      push(env, false, (err as Error).message.split("\n")[0]!);
    }
  }

  let modelIds: string[] | null = null;
  if (hasKey) {
    const client = makeOpenRouterClient({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      referer: config.referer,
      title: config.title,
    });
    try {
      modelIds = await client.listModels();
      for (const [env, slug] of resolved) {
        if (modelIds.includes(slug)) push(`model ${slug}`, true, `valid (${env})`);
        else {
          const near = suggestModel(slug, modelIds);
          push(
            `model ${slug}`,
            false,
            `not on OpenRouter (${env})${near === null ? "" : ` — did you mean "${near}"?`}`,
          );
        }
      }
    } catch (err) {
      push("model validation", false, `listing models failed: ${(err as Error).message}`);
    }
  } else {
    push("model validation", null, "skipped (no key)");
  }

  const width = Math.max(...checks.map((c) => c.name.length));
  for (const c of checks) {
    const mark = c.ok === null ? "--  " : c.ok ? "ok  " : "FAIL";
    console.log(`  ${c.name.padEnd(width)}  ${mark}  ${c.detail}`);
  }

  if (values.models && modelIds !== null) {
    console.log(`\nmodels (${modelIds.length}):`);
    for (const id of modelIds) console.log(`  ${id}`);
  }

  const failures = checks.filter((c) => c.ok === false);
  if (failures.length > 0) {
    console.error(
      [
        `${failures.length} check(s) failed: ${failures.map((c) => c.name).join(", ")}`,
        "the environment is not ready for a run",
        hasKey
          ? "fix the failed checks above, then re-run doctor"
          : "add OPENROUTER_API_KEY to .env (see .env.example), then re-run doctor",
      ].join("\n"),
    );
    return 1;
  }
  console.log("\nall checks passed");
  return 0;
}
