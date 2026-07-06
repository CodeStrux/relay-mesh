/** approve: the human gate — pin sha256(plan.md), then extract exec briefs deterministically. */
import { createHash } from "node:crypto";
import { hostname, userInfo } from "node:os";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { briefPreamble } from "../agents/execute.js";
import { extractDomainBriefs } from "../agents/plan.js";
import { loadConfig } from "../config.js";
import { byRole, loadProfiles, type Profile } from "../profiles.js";
import { atomicWrite, safeRead } from "../relay/fsio.js";
import { meshPaths, type RoundPaths } from "../relay/paths.js";
import { deriveState } from "../relay/state.js";
import { readPairRows } from "./status.js";

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

async function askGate(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.once("SIGINT", () => rl.close()); // Ctrl-C at the gate aborts, never approves
  try {
    return await Promise.race([
      rl.question(prompt),
      new Promise<string>((resolve) => rl.once("close", () => resolve(""))),
    ]);
  } finally {
    rl.close();
  }
}

/** Verbatim domain briefs + the fixed protocol preamble — no LLM between approval and execution. */
async function writeBriefs(
  rp: RoundPaths,
  round: string,
  executors: Profile[],
  briefs: Map<string, string>,
): Promise<number> {
  let written = 0;
  for (const p of executors) {
    const md = p.area === undefined ? undefined : briefs.get(p.area);
    if (p.area === undefined || md === undefined) continue;
    const pairDir = rp.execPair(p.area);
    await atomicWrite(rp.brief(pairDir, p.area), briefPreamble(p.area, round) + md + "\n");
    written++;
  }
  return written;
}

export async function run(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      round: { type: "string" },
      reject: { type: "string" },
      yes: { type: "boolean", default: false },
    },
  });
  if (values.round !== undefined && !/^r\d{3,}$/.test(values.round)) {
    throw new Error(
      [
        `invalid --round "${values.round}"`,
        "rounds are zero-padded names like r001",
        "pass --round rNNN",
      ].join("\n"),
    );
  }

  const config = loadConfig({ requireApiKey: false }); // the gate is deterministic — no LLM call
  const profiles = await loadProfiles(config.profilesPath);
  const root = config.relayRoot;
  const state = await deriveState(root);
  const round = values.round ?? state.round;
  if (round === null) {
    throw new Error(
      ["no active round", `${root} has no rounds yet`, 'run: relay-mesh plan "<goal>"'].join("\n"),
    );
  }
  const rp = meshPaths(root).round(round);
  const planMd = await safeRead(rp.plan);
  if (planMd === null) {
    throw new Error(
      [
        `rounds/${round}/plan.md not found`,
        "there is no plan to approve for this round",
        "run plan first (or verify, which scaffolds fix-round plans)",
      ].join("\n"),
    );
  }

  const planSha = createHash("sha256").update(planMd).digest("hex");
  const briefs = extractDomainBriefs(planMd);
  const executors = byRole(profiles, "executor");

  console.log(`plan: rounds/${round}/plan.md`);
  console.log(`sha256: ${planSha}`);
  console.log("domain briefs:");
  for (const [area, md] of briefs) {
    const hasExec = executors.some((p) => p.area === area);
    console.log(`  ${area}: ${wordCount(md)} words${hasExec ? "" : "  (no executor profile — will not run)"}`);
  }
  for (const p of executors) {
    if (p.area !== undefined && !briefs.has(p.area)) {
      console.log(`  ${p.area}: MISSING domain brief — this executor will be skipped`);
    }
  }
  const blocked = (await readPairRows(root, round))
    .filter((r) => r.kind === "recon" && r.block?.status === "blocked")
    .map((r) => r.area);
  if (blocked.length) console.log(`blocked recon pairs: ${blocked.join(", ")}`);

  const by = `${userInfo().username}@${hostname()}`;
  const at = new Date().toISOString();

  if (values.reject !== undefined) {
    const approval = { decision: "rejected", by, at, plan_sha256: planSha, notes: values.reject };
    await atomicWrite(rp.approval, `${JSON.stringify(approval)}\n`);
    console.log(`rejected — rounds/${round}/plan.approval.json written`);
    return 0;
  }

  // Idempotent short-circuit: already approved at this exact plan hash.
  const existingRaw = await safeRead(rp.approval);
  if (existingRaw !== null) {
    try {
      const existing = JSON.parse(existingRaw) as { decision?: unknown; plan_sha256?: unknown };
      if (existing.decision === "approved" && existing.plan_sha256 === planSha) {
        await writeBriefs(rp, round, executors, briefs);
        console.log("already approved at this plan hash — exec briefs are in place");
        console.log("next: relay-mesh execute");
        return 0;
      }
    } catch {
      // unparseable approval => run the gate again
    }
  }

  if (!values.yes) {
    const answer = await askGate(
      `type "approve" to approve rounds/${round}/plan.md (anything else aborts): `,
    );
    if (answer.trim() !== "approve") {
      console.log("not approved — nothing written; the gate remains armed");
      return 2;
    }
  }

  const approval = { decision: "approved", by, at, plan_sha256: planSha, notes: "" };
  await atomicWrite(rp.approval, `${JSON.stringify(approval)}\n`);
  const written = await writeBriefs(rp, round, executors, briefs);
  console.log(`approved — ${written} exec brief(s) written`);
  console.log("next: relay-mesh execute");
  return 0;
}
