import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { byRole, loadProfiles, type Profile } from "../src/profiles.js";

type Loose = Record<string, unknown>;

function fleet(overrides?: { profiles?: Loose[]; version?: number }): Loose {
  const profiles: Loose[] = overrides?.profiles ?? [
    { name: "planner", role: "planner", domain: "orchestration", modelEnv: "PLANNER_MODEL", effort: "xhigh", prompt: "prompts/planner.md" },
    { name: "exec-backend", role: "executor", domain: "backend", area: "backend", modelEnv: "BACKEND_MODEL", effort: "high", prompt: "prompts/executor-backend.md" },
    { name: "monitor", role: "monitor", domain: "observation", modelEnv: "MONITOR_MODEL", effort: "low", prompt: "prompts/monitor.md" },
    { name: "verifier", role: "verifier", domain: "verification", modelEnv: "PLANNER_MODEL", effort: "xhigh", prompt: "prompts/verifier.md" },
  ];
  return { version: overrides?.version ?? 1, profiles };
}

async function writeFleet(json: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "relay-mesh-profiles-"));
  const path = join(dir, "profiles.json");
  await writeFile(path, typeof json === "string" ? json : JSON.stringify(json), "utf8");
  return path;
}

describe("loadProfiles", () => {
  it("loads the bundled profiles.json by default", async () => {
    const profiles = await loadProfiles();
    expect(profiles).toHaveLength(10);
    expect(byRole(profiles, "planner")).toHaveLength(1);
    expect(byRole(profiles, "recon")).toHaveLength(4);
    expect(byRole(profiles, "executor")).toHaveLength(3);
    const vision = profiles.find((p) => p.name === "recon-vision");
    expect(vision?.multimodal).toBe(true);
  });

  it("defaults multimodal to false", async () => {
    const path = await writeFleet(fleet());
    const profiles = await loadProfiles(path);
    for (const p of profiles) expect(p.multimodal).toBe(false);
  });

  it("rejects duplicate profile names", async () => {
    const base = fleet();
    const profiles = base.profiles as Loose[];
    profiles.push({ ...(profiles[1] as Loose), area: "other" });
    const path = await writeFleet(base);
    await expect(loadProfiles(path)).rejects.toThrow(/duplicate profile name "exec-backend"/);
  });

  it("rejects a fleet with two planners", async () => {
    const base = fleet();
    (base.profiles as Loose[]).push({
      name: "planner-2", role: "planner", domain: "d", modelEnv: "PLANNER_MODEL", effort: "high", prompt: "p.md",
    });
    const path = await writeFleet(base);
    await expect(loadProfiles(path)).rejects.toThrow(/exactly one "planner".*found 2/);
  });

  it("rejects a fleet missing its monitor", async () => {
    const base = fleet();
    base.profiles = (base.profiles as Loose[]).filter((p) => p.role !== "monitor");
    const path = await writeFleet(base);
    await expect(loadProfiles(path)).rejects.toThrow(/exactly one "monitor".*found 0/);
  });

  it("rejects an executor without an area", async () => {
    const base = fleet();
    const exec = (base.profiles as Loose[]).find((p) => p.role === "executor") as Loose;
    delete exec.area;
    const path = await writeFleet(base);
    await expect(loadProfiles(path)).rejects.toThrow(/must declare an area/);
  });

  it("rejects duplicate executor areas", async () => {
    const base = fleet();
    (base.profiles as Loose[]).push({
      name: "exec-backend-2", role: "executor", domain: "d", area: "backend",
      modelEnv: "BACKEND_MODEL", effort: "high", prompt: "p.md",
    });
    const path = await writeFleet(base);
    await expect(loadProfiles(path)).rejects.toThrow(/duplicate executor area "backend"/);
  });

  it("rejects an unknown effort", async () => {
    const base = fleet();
    ((base.profiles as Loose[])[0] as Loose).effort = "ultra";
    const path = await writeFleet(base);
    await expect(loadProfiles(path)).rejects.toThrow(/effort/);
  });

  it("rejects an unsupported version", async () => {
    const path = await writeFleet(fleet({ version: 2 }));
    await expect(loadProfiles(path)).rejects.toThrow(/version/);
  });

  it("rejects broken JSON with the path in the message", async () => {
    const path = await writeFleet("{ nope");
    await expect(loadProfiles(path)).rejects.toThrow(/not valid JSON/);
    await expect(loadProfiles(path)).rejects.toThrow(new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });
});

describe("byRole", () => {
  it("filters by role without mutating the input", () => {
    const profiles: Profile[] = [
      { name: "a", role: "planner", domain: "d", modelEnv: "M", effort: "low", prompt: "p", multimodal: false },
      { name: "b", role: "executor", domain: "d", area: "x", modelEnv: "M", effort: "low", prompt: "p", multimodal: false },
    ];
    expect(byRole(profiles, "executor").map((p) => p.name)).toEqual(["b"]);
    expect(profiles).toHaveLength(2);
  });
});
