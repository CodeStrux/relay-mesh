/** Unit pins for review-confirmed gaps: model suggestions, usage validation, project bundling. */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { suggestModel } from "../src/commands/doctor.js";
import { bundleProject } from "../src/context.js";
import { aggregate, readUsage } from "../src/usage.js";
import { tmpRoot } from "./fixtures/roots.js";

describe("suggestModel", () => {
  const ids = ["z-ai/glm-5.2", "deepseek/deepseek-v4-pro", "moonshotai/kimi-k2.7-code"];
  it("suggests on a near-miss slug", () => {
    expect(suggestModel("z-ai/glm-5.1", ids)).toBe("z-ai/glm-5.2");
    expect(suggestModel("kimi-k2.7-code", ids)).toBe("moonshotai/kimi-k2.7-code");
  });
  it("returns null when nothing is close", () => {
    expect(suggestModel("acme/completely-different", ids)).toBeNull();
  });
});

describe("readUsage shape validation", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });

  it("skips wrong-shape JSON lines; aggregate never NaNs", async () => {
    const root = await tmpRoot();
    dirs.push(root);
    const p = join(root, "usage.ndjson");
    const good = { ts: "2026-07-06T21:00:00Z", round: "r001", profile: "planner", model: "m", in: 10, out: 5 };
    await writeFile(
      p,
      [JSON.stringify(good), '{"foo":1}', '{"ts":1,"round":null}', "{torn", ""].join("\n"),
      "utf8",
    );
    const lines = await readUsage(p);
    expect(lines).toEqual([good]);
    const agg = aggregate(lines, "profile");
    expect(agg).toEqual([{ key: "planner", in: 10, out: 5, calls: 1 }]);
  });
});

describe("bundleProject", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });

  it("includes text, skips binary and gitignored paths, respects the byte cap", async () => {
    const root = await tmpRoot();
    dirs.push(root);
    await writeFile(join(root, ".gitignore"), "vendor/\n", "utf8");
    await mkdir(join(root, "vendor"), { recursive: true });
    await writeFile(join(root, "vendor", "big.js"), "IGNORED CONTENT", "utf8");
    await writeFile(join(root, "app.ts"), 'export const app = "hello";\n', "utf8");
    await writeFile(join(root, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));

    const bundle = await bundleProject(root);
    expect(bundle).toContain('export const app = "hello";');
    expect(bundle).not.toContain("IGNORED CONTENT");

    const capped = await bundleProject(root, 200);
    expect(Buffer.byteLength(capped, "utf8")).toBeLessThanOrEqual(200 + 1024); // tree header slack only
    expect(capped.length).toBeLessThan(bundle.length + 1);
  });
});
