import { join } from "node:path";

export interface RoundPaths {
  dir: string;
  plan: string;
  approval: string;
  reconPair(profileName: string): string;
  execPair(area: string): string;
  brief(pairDir: string, area: string): string;
  report(pairDir: string, area: string): string;
  closure(pairDir: string): string;
  workspace(area: string): string;
  workspaceFiles(area: string): string;
  raw(area: string): string;
  eventsNdjson: string;
  rollup: string;
  verdictJson: string;
  verdictMd: string;
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
        reconPair: (profileName) => join(dir, "recon", `planner__${profileName}`),
        execPair: (area) => join(dir, "exec", `planner__${area}`),
        brief: (pairDir, area) => join(pairDir, `${area}.brief.md`),
        report: (pairDir, area) => join(pairDir, `${area}.report.md`),
        closure: (pairDir) => join(pairDir, "closure.json"),
        workspace: (area) => join(dir, "workspace", area),
        workspaceFiles: (area) => join(dir, "workspace", area, "files"),
        raw: (area) => join(dir, "workspace", area, "raw.md"),
        eventsNdjson: join(dir, "monitor", "events.ndjson"),
        rollup: join(dir, "monitor", "rollup.md"),
        verdictJson: join(dir, "verify", "verdict.json"),
        verdictMd: join(dir, "verify", "verdict.md"),
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
