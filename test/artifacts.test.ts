import { access, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractArtifacts, writeArtifacts } from "../src/relay/artifacts.js";
import { tmpRoot } from "./fixtures/roots.js";

const REPORT =
  "=== REPORT ===\n" +
  "---\n" +
  "area: backend\n" +
  "status: complete\n" +
  "steps_done: 2\n" +
  "steps_total: 2\n" +
  "plan_ref: rounds/r001/plan.md\n" +
  "---\n" +
  "1. Ask #1 — done.\n";

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

const dirs: string[] = [];
async function ws(): Promise<string> {
  const d = await tmpRoot();
  dirs.push(d);
  return join(d, "workspace", "backend");
}
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

describe("extractArtifacts", () => {
  it("extracts multiple FILE blocks and the REPORT section", () => {
    const output =
      "Some preamble the model chatted.\n" +
      "=== FILE: src/a.ts ===\n" +
      "export const a = 1;\n" +
      "=== END ===\n" +
      "=== FILE: docs/readme.md ===\n" +
      "# hi\n" +
      "line2\n" +
      "=== END ===\n" +
      REPORT;
    const res = extractArtifacts(output);
    expect(res.problems).toEqual([]);
    expect(res.files).toEqual([
      { relpath: "src/a.ts", bytes: Buffer.byteLength("export const a = 1;\n") },
      { relpath: "docs/readme.md", bytes: Buffer.byteLength("# hi\nline2\n") },
    ]);
    expect(res.reportMd).toMatch(/^---\narea: backend\n/);
    expect(res.reportMd).toContain("1. Ask #1 — done.");
  });

  it("rejects .. and absolute paths but keeps valid siblings", () => {
    const output =
      "=== FILE: ../evil.ts ===\nx\n=== END ===\n" +
      "=== FILE: /abs.ts ===\ny\n=== END ===\n" +
      "=== FILE: ok/fine.ts ===\nz\n=== END ===\n" +
      REPORT;
    const res = extractArtifacts(output);
    expect(res.files.map((f) => f.relpath)).toEqual(["ok/fine.ts"]);
    expect(res.problems).toEqual([
      "path traversal rejected: ../evil.ts",
      "absolute path rejected: /abs.ts",
    ]);
    expect(res.reportMd).not.toBeNull();
  });

  it("flags an unterminated FILE block but still salvages the REPORT after it", () => {
    const output = "=== FILE: src/a.ts ===\nnever closed\n" + REPORT;
    const res = extractArtifacts(output);
    expect(res.files).toEqual([]);
    expect(res.problems).toEqual(["unterminated FILE block: src/a.ts"]);
    expect(res.reportMd).toMatch(/^---\narea: backend\n/);
  });

  it("unterminated FILE block at EOF: problem + null reportMd", () => {
    const res = extractArtifacts("=== FILE: src/a.ts ===\nnever closed\n");
    expect(res.files).toEqual([]);
    expect(res.reportMd).toBeNull();
    expect(res.problems).toEqual(["unterminated FILE block: src/a.ts", "no REPORT section found"]);
  });

  it("garbage without markers: no files, null reportMd, a problem", () => {
    const res = extractArtifacts("hello, I could not do the task, sorry\n");
    expect(res.files).toEqual([]);
    expect(res.reportMd).toBeNull();
    expect(res.problems).toEqual(["no REPORT section found"]);
  });

  it("REPORT whose status block does not parse yields null reportMd", () => {
    const res = extractArtifacts("=== REPORT ===\nthis is not a status block\n");
    expect(res.reportMd).toBeNull();
    expect(res.problems).toEqual(["REPORT status block does not parse"]);
  });

  it("tolerates blank lines between the REPORT marker and the status block", () => {
    const res = extractArtifacts("=== REPORT ===\n\n" + REPORT.slice("=== REPORT ===\n".length));
    expect(res.reportMd).toMatch(/^---\narea: backend\n/);
  });
});

describe("writeArtifacts", () => {
  it("writes files under <ws>/files/ with nested dirs and exact content", async () => {
    const dir = await ws();
    const output =
      "=== FILE: src/deep/nested/mod.ts ===\nexport {};\n=== END ===\n" +
      "=== FILE: top.txt ===\nline1\nline2\n=== END ===\n" +
      REPORT;
    const res = extractArtifacts(output);
    await writeArtifacts(res, dir, output);

    expect(await readFile(join(dir, "files", "src", "deep", "nested", "mod.ts"), "utf8")).toBe("export {};\n");
    expect(await readFile(join(dir, "files", "top.txt"), "utf8")).toBe("line1\nline2\n");
    expect(await exists(join(dir, "raw.md"))).toBe(false);
    // bytes in the result match what landed on disk
    const onDisk = await readFile(join(dir, "files", "top.txt"), "utf8");
    expect(Buffer.byteLength(onDisk)).toBe(res.files.find((f) => f.relpath === "top.txt")!.bytes);
  });

  it("never writes outside the area dir for rejected paths", async () => {
    const dir = await ws();
    const output = "=== FILE: ../escape.ts ===\nboom\n=== END ===\n" + REPORT;
    const res = extractArtifacts(output);
    await writeArtifacts(res, dir, output);
    expect(await exists(join(dir, "..", "escape.ts"))).toBe(false);
    expect(await exists(join(dir, "files", "escape.ts"))).toBe(false);
  });

  it("salvages the verbatim output to raw.md when reportMd is null", async () => {
    const dir = await ws();
    const output = "totally malformed output with no markers\n";
    const res = extractArtifacts(output);
    await writeArtifacts(res, dir, output);
    expect(await readFile(join(dir, "raw.md"), "utf8")).toBe(output);
  });

  it("still writes well-formed FILE blocks even when the report failed to parse", async () => {
    const dir = await ws();
    const output = "=== FILE: kept.ts ===\nexport const kept = true;\n=== END ===\nno report follows\n";
    const res = extractArtifacts(output);
    expect(res.reportMd).toBeNull();
    await writeArtifacts(res, dir, output);
    expect(await readFile(join(dir, "files", "kept.ts"), "utf8")).toBe("export const kept = true;\n");
    expect(await readFile(join(dir, "raw.md"), "utf8")).toBe(output);
  });

  it("salvages raw.md when the report parses but a FILE block was malformed (tokens never lost)", async () => {
    const dir = await ws();
    // Unterminated FILE block: its 300-lines-of-code moment — the content is
    // discarded by the parser, so the verbatim output MUST survive at raw.md.
    const output = "=== FILE: src/a.ts ===\nconst a = 1;\n" + REPORT;
    const res = extractArtifacts(output);
    expect(res.reportMd).not.toBeNull();
    expect(res.problems).toEqual(["unterminated FILE block: src/a.ts"]);
    await writeArtifacts(res, dir, output);
    expect(await readFile(join(dir, "raw.md"), "utf8")).toBe(output);
  });
});
