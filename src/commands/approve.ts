/** approve: human gate #1 — pin sha256(plan.md). Exec briefs are authored at the roster gate (#2). */
import { createHash } from "node:crypto";
import { hostname, userInfo } from "node:os";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { extractDomainBriefs } from "../relay/briefs.js";
import { loadConfig } from "../config.js";
import { atomicWrite, safeRead } from "../relay/fsio.js";
import { meshPaths } from "../relay/paths.js";
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
  const root = config.relayRoot;
  const state = await deriveState(root);
  const round = values.round ?? state.round;
  if (round === null) {
    throw new Error(
      ["no active round", `${root} has no rounds yet`, 'run: relay-mesh plan "<goal>"'].join("\n"),
    );
  }
  // Rounds are append-only (protocol rule 5): approval only ever targets the
  // round the phase machine is in, and never a round that already has a verdict.
  if (round !== state.round) {
    throw new Error(
      [
        `--round ${round} is not the active round (${state.round ?? "none"})`,
        "rounds are append-only — nothing in a finished round is rewritten",
        `work in ${state.round ?? "a new round"} instead (relay-mesh status shows the phase)`,
      ].join("\n"),
    );
  }
  if (state.verdict !== null) {
    throw new Error(
      [
        `rounds/${round} already has a verdict — the round is terminal`,
        "nothing in a terminal round is rewritten; fixes go in the next round",
        "run verify to scaffold the next fix round, then approve that round",
      ].join("\n"),
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

  console.log(`plan: rounds/${round}/plan.md`);
  console.log(`sha256: ${planSha}`);
  console.log("domain briefs (the roster gate decides which run, and how many):");
  for (const [area, md] of briefs) {
    console.log(`  ${area}: ${wordCount(md)} words`);
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
    return 2; // replanning: the gate stays armed for a revised plan
  }

  // Idempotent short-circuit: already approved at this exact plan hash.
  const existingRaw = await safeRead(rp.approval);
  if (existingRaw !== null) {
    try {
      const existing = JSON.parse(existingRaw) as { decision?: unknown; plan_sha256?: unknown };
      if (existing.decision === "approved" && existing.plan_sha256 === planSha) {
        console.log("already approved at this plan hash");
        console.log("next: relay-mesh roster");
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
  console.log("approved — plan.approval.json written");
  console.log("next: relay-mesh roster");
  return 0;
}
