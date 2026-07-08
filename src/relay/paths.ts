import { join } from "node:path";

export interface RoundPaths {
  dir: string;
  plan: string;
  approval: string;
  roster: string;
  rosterApproval: string;
  reconPair(profileName: string): string;
  execPair(area: string, shard?: number): string;
  brief(pairDir: string, area: string): string;
  report(pairDir: string, area: string): string;
  closure(pairDir: string): string;
  workspace(area: string, shard?: number): string;
  workspaceFiles(area: string, shard?: number): string;
  raw(area: string, shard?: number): string;
  eventsNdjson: string;
  rollup: string;
  verdictJson: string;
  verdictMd: string;
  usageDir: string;
  usageStage(stage: string): string;
  transcriptsDir: string;
}

/** Every path in docs/protocol.md, derived from a root. */
export interface MeshPaths {
  root: string;
  meshJson: string;
  projectJson: string;
  goal: string;
  inputsDir: string;
  usage: string;
  roundsDir: string;
  round(r: string): RoundPaths;
}

export function meshPaths(root: string): MeshPaths {
  const roundsDir = join(root, "rounds");
  return {
    root,
    meshJson: join(root, "mesh.json"),
    projectJson: join(root, "project.json"),
    goal: join(root, "goal.md"),
    inputsDir: join(root, "inputs"),
    usage: join(root, "usage.ndjson"),
    roundsDir,
    round(r: string): RoundPaths {
      const dir = join(roundsDir, r);
      return {
        dir,
        plan: join(dir, "plan.md"),
        approval: join(dir, "plan.approval.json"),
        roster: join(dir, "roster.json"),
        rosterApproval: join(dir, "roster.approval.json"),
        reconPair: (profileName) => join(dir, "recon", `planner__${profileName}`),
        execPair: (area, shard) =>
          join(dir, "exec", shard === undefined ? `planner__${area}` : `planner__${area}__w${shard}`),
        brief: (pairDir, area) => join(pairDir, `${area}.brief.md`),
        report: (pairDir, area) => join(pairDir, `${area}.report.md`),
        closure: (pairDir) => join(pairDir, "closure.json"),
        workspace: (area, shard) =>
          join(dir, "workspace", area, ...(shard === undefined ? [] : [`w${shard}`])),
        workspaceFiles: (area, shard) =>
          join(dir, "workspace", area, ...(shard === undefined ? [] : [`w${shard}`]), "files"),
        raw: (area, shard) =>
          join(dir, "workspace", area, ...(shard === undefined ? [] : [`w${shard}`]), "raw.md"),
        eventsNdjson: join(dir, "monitor", "events.ndjson"),
        rollup: join(dir, "monitor", "rollup.md"),
        verdictJson: join(dir, "verify", "verdict.json"),
        verdictMd: join(dir, "verify", "verdict.md"),
        usageDir: join(dir, "usage"),
        usageStage: (stage) => join(dir, "usage", `${stage}.json`),
        transcriptsDir: join(dir, ".transcripts"),
      };
    },
  };
}

/** ["r001"] -> "r002"; [] -> "r001". Ignores names that are not rNNN. */
export function nextRound(existing: string[]): string {
  let max = 0;
  for (const name of existing) {
    const m = /^r(\d+)$/.exec(name);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `r${String(max + 1).padStart(3, "0")}`;
}
