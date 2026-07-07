/** Executor source context: deterministic path extraction + full-file bundling. */
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bundleForExecutor, extractPathHints } from "../src/context.js";
import { tmpRoot } from "./fixtures/roots.js";

const CAPS = { perFileBytes: 65536, totalBytes: 196608 };

describe("extractPathHints", () => {
  it("extracts backticked tokens, slash paths, and bare dotted filenames, deduped in first-mention order", () => {
    const hints = extractPathHints([
      "Edit `_config.yml` and src/app.ts. Also _config.yml again.",
      "see _includes/footer.html",
    ]);
    expect(hints).toEqual(["_config.yml", "src/app.ts", "_includes/footer.html"]);
  });

  it("strips trailing punctuation and a leading ./", () => {
    const hints = extractPathHints(["(see ./src/util.ts, then assets/css/main.scss.)"]);
    expect(hints).toEqual(["src/util.ts", "assets/css/main.scss"]);
  });

  it("rejects traversal, URLs, versions, relay-internal refs, and non-path backticks", () => {
    const hints = extractPathHints([
      "run `npm test` against `../secrets` or https://x.test/a/b at v1.2.3; see rounds/r001/plan.md",
    ]);
    expect(hints).toEqual([]);
  });

  it("ignores angle-bracket placeholders like <relative/path> in protocol prose", () => {
    const hints = extractPathHints([
      "open a block with === FILE: <relative/path> === and close it; report to <area>.report.md",
    ]);
    expect(hints).toEqual([]);
  });

  it("orders across texts by the order the texts are given (brief outranks later corpora)", () => {
    const hints = extractPathHints(["fix b/brief.ts", "fix a/recon.ts and b/brief.ts"]);
    expect(hints).toEqual(["b/brief.ts", "a/recon.ts"]);
  });

  it("extracts framework route paths with brackets, parens, and plus signs", () => {
    expect(extractPathHints(["edit `app/[slug]/page.tsx`"])).toEqual(["app/[slug]/page.tsx"]);
    expect(extractPathHints(["edit `src/routes/+page.svelte`"])).toEqual(["src/routes/+page.svelte"]);
    expect(extractPathHints(["edit `app/(marketing)/layout.tsx`"])).toEqual([
      "app/(marketing)/layout.tsx",
    ]);
  });

  it("extracts a backticked path containing a space", () => {
    expect(extractPathHints(["update `docs/release notes.md`"])).toEqual(["docs/release notes.md"]);
  });

  it("rejects relay-internal artifact paths (report/brief headers, pair dirs)", () => {
    expect(
      extractPathHints([
        "see `planner__frontend/frontend.report.md` and `backend.brief.md` and `closure.json`",
      ]),
    ).toEqual([]);
  });

  it("extracts well-known extensionless files named bare in prose", () => {
    expect(extractPathHints(["I need the current Dockerfile and the Makefile at repo root"])).toEqual([
      "Dockerfile",
      "Makefile",
    ]);
  });
});

describe("bundleForExecutor", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });

  async function project(): Promise<string> {
    const dir = await tmpRoot();
    dirs.push(dir);
    return dir;
  }

  it("includes the FULL contents of a resolved hint (beyond any head truncation)", async () => {
    const root = await project();
    const body = `title: Site\n${"x".repeat(3000)}\nEND_MARKER_XYZ\n`;
    await writeFile(join(root, "_config.yml"), body, "utf8");

    const b = await bundleForExecutor(root, ["_config.yml"], CAPS);
    expect(b.included).toEqual(["_config.yml"]);
    expect(b.text).toContain("END_MARKER_XYZ");
    expect(b.text).toContain("Provided in full");
  });

  it("resolves hints by basename anywhere and by path suffix", async () => {
    const root = await project();
    await mkdir(join(root, "deep", "nested"), { recursive: true });
    await mkdir(join(root, "assets", "css"), { recursive: true });
    await writeFile(join(root, "deep", "nested", "_config.yml"), "CFG_BODY\n", "utf8");
    await writeFile(join(root, "assets", "css", "main.scss"), "SCSS_BODY\n", "utf8");

    const b = await bundleForExecutor(root, ["_config.yml", "css/main.scss"], CAPS);
    expect(b.included).toEqual(["deep/nested/_config.yml", "assets/css/main.scss"]);
    expect(b.text).toContain("CFG_BODY");
    expect(b.text).toContain("SCSS_BODY");
  });

  it("falls back to case-insensitive matching when the exact case misses", async () => {
    const root = await project();
    await writeFile(join(root, "Readme.md"), "README_BODY\n", "utf8");

    const b = await bundleForExecutor(root, ["readme.md"], CAPS);
    expect(b.included).toEqual(["Readme.md"]);
    expect(b.text).toContain("README_BODY");
  });

  it("resolves dotfile paths via direct stat but refuses .git and .env targets", async () => {
    const root = await project();
    await mkdir(join(root, ".github", "workflows"), { recursive: true });
    await mkdir(join(root, ".git"), { recursive: true });
    await writeFile(join(root, ".github", "workflows", "ci.yml"), "CI_BODY\n", "utf8");
    await writeFile(join(root, ".git", "config"), "GIT_SECRET\n", "utf8");
    await writeFile(join(root, ".env"), "ENV_SECRET\n", "utf8");

    const b = await bundleForExecutor(root, [".github/workflows/ci.yml", ".git/config", ".env"], CAPS);
    expect(b.included).toEqual([".github/workflows/ci.yml"]);
    expect(b.text).toContain("CI_BODY");
    expect(b.text).not.toContain("GIT_SECRET");
    expect(b.text).not.toContain("ENV_SECRET");
  });

  it("expands a directory hint recursively, honoring .gitignore", async () => {
    const root = await project();
    await writeFile(join(root, ".gitignore"), "tmp/\n", "utf8");
    await mkdir(join(root, "_includes", "tmp"), { recursive: true });
    await writeFile(join(root, "_includes", "footer.html"), "FOOTER_BODY\n", "utf8");
    await writeFile(join(root, "_includes", "nav.html"), "NAV_BODY\n", "utf8");
    await writeFile(join(root, "_includes", "tmp", "skip.html"), "SKIPPED_BODY\n", "utf8");

    const b = await bundleForExecutor(root, ["_includes"], CAPS);
    expect(b.included.sort()).toEqual(["_includes/footer.html", "_includes/nav.html"]);
    expect(b.text).toContain("FOOTER_BODY");
    expect(b.text).toContain("NAV_BODY");
    expect(b.text).not.toContain("SKIPPED_BODY");
  });

  it("lists binary files in the manifest instead of inlining them", async () => {
    const root = await project();
    await writeFile(join(root, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));

    const b = await bundleForExecutor(root, ["logo.png"], CAPS);
    expect(b.included).toEqual([]);
    expect(b.omitted).toEqual(["logo.png"]);
    expect(b.text).toContain("Binary — not inlined: logo.png (6B)");
  });

  it("omits a file over the per-file cap WHOLE (never truncates) and names the knob", async () => {
    const root = await project();
    await writeFile(join(root, "big.css"), `START_${"y".repeat(300)}_FINISH\n`, "utf8");

    const b = await bundleForExecutor(root, ["big.css"], { perFileBytes: 100, totalBytes: 196608 });
    expect(b.included).toEqual([]);
    expect(b.omitted).toEqual(["big.css"]);
    expect(b.text).not.toContain("START_");
    expect(b.text).toContain("RELAY_EXEC_FILE_BYTES");
  });

  it("stops inlining at the total budget in first-mention order and names the knob", async () => {
    const root = await project();
    await writeFile(join(root, "first.txt"), `FIRST_${"a".repeat(150)}\n`, "utf8");
    await writeFile(join(root, "second.txt"), `SECOND_${"b".repeat(150)}\n`, "utf8");

    const b = await bundleForExecutor(root, ["first.txt", "second.txt"], {
      perFileBytes: 200,
      totalBytes: 200,
    });
    expect(b.included).toEqual(["first.txt"]);
    expect(b.omitted).toEqual(["second.txt"]);
    expect(b.text).toContain("FIRST_");
    expect(b.text).not.toContain("SECOND_");
    expect(b.text).toContain("RELAY_EXEC_BUNDLE_BYTES");
  });

  it("reports unresolved slash-hints as NEW files; silently drops unresolved bare tokens", async () => {
    const root = await project();
    await writeFile(join(root, "index.html"), "INDEX_BODY\n", "utf8");

    const b = await bundleForExecutor(root, ["_includes/newsletter.html", "e.g", "index.html"], CAPS);
    expect(b.included).toEqual(["index.html"]);
    expect(b.missing).toEqual(["_includes/newsletter.html"]);
    expect(b.text).toContain("not found in project");
    expect(b.text).toContain("block that ask");
    expect(b.text).not.toContain("treat as NEW files you create");
    expect(b.text).toContain("_includes/newsletter.html");
    expect(b.text).not.toContain("e.g (");
  });

  // --- R1: security containment of the direct-stat resolution tier ---

  it("does NOT follow a symlink whose target escapes the project root", async () => {
    const root = await project();
    const outside = await project();
    await writeFile(join(outside, "adc.json"), "OUTSIDE_SECRET_TOKEN\n", "utf8");
    await symlink(join(outside, "adc.json"), join(root, "credentials.json"));

    const b = await bundleForExecutor(root, ["credentials.json"], CAPS);
    expect(b.included).toEqual([]);
    expect(b.text).not.toContain("OUTSIDE_SECRET_TOKEN");
  });

  it("does NOT follow a mid-path directory symlink out of the project", async () => {
    const root = await project();
    const outside = await project();
    await mkdir(join(outside, "secrets"), { recursive: true });
    await writeFile(join(outside, "secrets", "key.txt"), "ESCAPED_DIR_SECRET\n", "utf8");
    await symlink(join(outside, "secrets"), join(root, "config"));

    const b = await bundleForExecutor(root, ["config/key.txt"], CAPS);
    expect(b.included).toEqual([]);
    expect(b.text).not.toContain("ESCAPED_DIR_SECRET");
  });

  it("refuses .env and .git targets case-insensitively (.ENV / .GIT/config)", async () => {
    const root = await project();
    await mkdir(join(root, ".git"), { recursive: true });
    await writeFile(join(root, ".env"), "DB_PASSWORD=hunter2\n", "utf8");
    await writeFile(join(root, ".git", "config"), "token=GIT_SECRET_TOKEN\n", "utf8");

    const b = await bundleForExecutor(root, [".ENV", ".GIT/config", ".env", ".git/config"], CAPS);
    expect(b.included).toEqual([]);
    expect(b.text).not.toContain("hunter2");
    expect(b.text).not.toContain("GIT_SECRET_TOKEN");
  });

  it("does NOT inline a gitignored secret file even on an exact hint", async () => {
    const root = await project();
    await writeFile(join(root, ".gitignore"), "serviceAccount.json\n", "utf8");
    await writeFile(join(root, "serviceAccount.json"), "PRIVATE_KEY_BLOB\n", "utf8");

    const b = await bundleForExecutor(root, ["serviceAccount.json"], CAPS);
    expect(b.included).toEqual([]);
    expect(b.text).not.toContain("PRIVATE_KEY_BLOB");
  });

  it("prefers the EXACT on-disk path over a suffix match when the walk missed it", async () => {
    const root = await project();
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "app.ts"), "RIGHT_ROOT_APP\n", "utf8");
    // A decoy under aaa/ (walked first, shares the "app.ts" suffix), then filler under mmm/
    // fills the 400-file cap so the real src/app.ts is never walked. Suffix would shadow it.
    await mkdir(join(root, "aaa", "legacy", "src"), { recursive: true });
    await writeFile(join(root, "aaa", "legacy", "src", "app.ts"), "WRONG_LEGACY_APP\n", "utf8");
    await mkdir(join(root, "mmm"), { recursive: true });
    for (let i = 0; i < 405; i++) {
      await writeFile(join(root, "mmm", `f${String(i).padStart(3, "0")}.txt`), `${i}\n`, "utf8");
    }

    const b = await bundleForExecutor(root, ["src/app.ts"], CAPS);
    expect(b.included).toContain("src/app.ts");
    expect(b.text).toContain("RIGHT_ROOT_APP");
    expect(b.text).not.toContain("WRONG_LEGACY_APP");
  });

  it("expands a dot-directory hint the walk never lists (.github/workflows)", async () => {
    const root = await project();
    await mkdir(join(root, ".github", "workflows"), { recursive: true });
    await writeFile(join(root, ".github", "workflows", "ci.yml"), "CI_WORKFLOW_BODY\n", "utf8");

    const b = await bundleForExecutor(root, [".github/workflows"], CAPS);
    expect(b.included).toContain(".github/workflows/ci.yml");
    expect(b.missing).toEqual([]);
    expect(b.text).toContain("CI_WORKFLOW_BODY");
  });

  it("strips a leading area segment to resolve area-prefixed workspace paths", async () => {
    const root = await project();
    await writeFile(join(root, "index.html"), "REAL_INDEX_BODY\n", "utf8");

    const b = await bundleForExecutor(root, ["frontend/index.html"], CAPS, "frontend");
    expect(b.included).toEqual(["index.html"]);
    expect(b.missing).toEqual([]);
    expect(b.text).toContain("REAL_INDEX_BODY");
  });

  // --- R3: bundle fidelity ---

  it("does not inline a non-UTF-8 file; lists it in the manifest instead", async () => {
    const root = await project();
    await writeFile(join(root, "legacy.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a])); // "café" latin-1

    const b = await bundleForExecutor(root, ["legacy.txt"], CAPS);
    expect(b.included).toEqual([]);
    expect(b.omitted).toContain("legacy.txt");
    expect(b.text).toContain("non-UTF-8");
    expect(b.text).not.toContain("�");
  });

  it("names directory-expansion overflow past the per-directory cap in the manifest", async () => {
    const root = await project();
    await mkdir(join(root, "_includes"), { recursive: true });
    for (let i = 0; i < 60; i++) {
      await writeFile(join(root, "_includes", `f${String(i).padStart(2, "0")}.html`), `body ${i}\n`, "utf8");
    }

    const b = await bundleForExecutor(root, ["_includes"], CAPS);
    expect(b.included.length).toBe(50);
    expect(b.text).toContain("Directory expansion capped at 50 files");
    expect(b.text).toContain("_includes");
  });

  it("always emits the file tree and the context manifest, even with no hints", async () => {
    const root = await project();
    await writeFile(join(root, "app.ts"), "APP_BODY\n", "utf8");

    const b = await bundleForExecutor(root, [], CAPS);
    expect(b.text).toContain("File tree");
    expect(b.text).toContain("app.ts");
    expect(b.text).toContain("Context manifest");
    expect(b.included).toEqual([]);
  });

  it("resolves an exact deep hint by direct stat even when the tree walk hit its file cap", async () => {
    const root = await project();
    await mkdir(join(root, "src"), { recursive: true });
    for (let i = 0; i < 405; i++) {
      await writeFile(join(root, "src", `f${String(i).padStart(3, "0")}.txt`), `${i}\n`, "utf8");
    }
    await mkdir(join(root, "zzz"), { recursive: true });
    await writeFile(join(root, "zzz", "target.txt"), "DEEP_TARGET_BODY\n", "utf8");

    const b = await bundleForExecutor(root, ["zzz/target.txt"], CAPS);
    expect(b.included).toEqual(["zzz/target.txt"]);
    expect(b.text).toContain("DEEP_TARGET_BODY");
    expect(b.text).toContain("tree truncated");
  });
});
