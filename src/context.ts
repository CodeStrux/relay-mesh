/**
 * Read-only project bundles.
 * - bundleProject: git-aware file tree + heads of key files, size-capped (recon).
 * - bundleForExecutor: FULL current contents of files a brief references (execute).
 */
import { open, readdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

const DEFAULT_CAP_BYTES = 30_000;
const HEAD_BYTES = 2_000; // per-file head budget
const MAX_FILES = 400; // hard stop against runaway trees

// Fallback pruning for non-git trees; hidden entries (.git, .env, caches) are always skipped.
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  "target",
  "out",
  "vendor",
  "__pycache__",
]);

const MANIFEST_NAMES = new Set([
  "package.json",
  "pyproject.toml",
  "cargo.toml",
  "go.mod",
  "tsconfig.json",
  "docker-compose.yml",
  "dockerfile",
  "makefile",
]);

interface Entry {
  rel: string;
  size: number;
}

interface IgnoreRule {
  re: RegExp;
  dirOnly: boolean;
}

function globToRegExpSource(glob: string): string {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i++;
      } else out += "[^/]*";
    } else if (c === "?") out += "[^/]";
    else out += c.replace(/[.+^${}()|[\]\\]/, "\\$&");
  }
  return out;
}

/**
 * Git-awareness: honor the project root's .gitignore so ignored artifact dirs
 * (logs/, generated/, …) never crowd real source out of the capped bundle.
 * Supported: comments, dir-only trailing "/", root-anchored patterns (leading
 * "/" or an inner slash), *, ** and ?. Negations ("!") are skipped — a skipped
 * negation only means we ignore slightly more, never less.
 */
export function parseGitignore(text: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\r$/, "").replace(/[ \t]+$/, "");
    if (line === "" || line.startsWith("#") || line.startsWith("!")) continue;
    let pat = line;
    const dirOnly = pat.endsWith("/");
    if (dirOnly) pat = pat.slice(0, -1);
    const anchored = pat.startsWith("/") || pat.includes("/");
    if (pat.startsWith("/")) pat = pat.slice(1);
    const body = globToRegExpSource(pat);
    // Anchored patterns match from the project root; bare names match any path segment.
    rules.push({ re: new RegExp(anchored ? `^${body}$` : `(^|/)${body}$`), dirOnly });
  }
  return rules;
}

export async function bundleProject(
  projectPath: string,
  capBytes: number = DEFAULT_CAP_BYTES,
): Promise<string> {
  const entries = await walk(projectPath);
  const tree = entries.map((e) => `${e.rel} (${e.size}B)`).join("\n");
  let out = `# Project: ${projectPath}\n\n## File tree (${entries.length} files)\n${tree}\n\n## Key files\n`;
  let outBytes = Buffer.byteLength(out, "utf8"); // the cap is bytes on the wire, not UTF-16 units

  const ordered = [...entries].sort(
    (a, b) => priority(a.rel) - priority(b.rel) || a.rel.localeCompare(b.rel),
  );
  for (const entry of ordered) {
    if (outBytes >= capBytes) break;
    let head: Buffer;
    try {
      head = await readHead(join(projectPath, entry.rel), HEAD_BYTES);
    } catch {
      continue;
    }
    if (head.includes(0)) continue; // NUL byte ⇒ binary — tree-only
    const truncated = entry.size > HEAD_BYTES ? "\n… (truncated)" : "";
    const section = `\n### ${entry.rel}\n\`\`\`\n${trimIncompleteUtf8(head).toString("utf8")}${truncated}\n\`\`\`\n`;
    const sectionBytes = Buffer.byteLength(section, "utf8");
    if (outBytes + sectionBytes > capBytes) break;
    out += section;
    outBytes += sectionBytes;
  }
  return outBytes > capBytes ? truncateUtf8(out, capBytes) : out;
}

async function walk(root: string): Promise<Entry[]> {
  let ignores: IgnoreRule[] = [];
  try {
    ignores = parseGitignore(await readFile(join(root, ".gitignore"), "utf8"));
  } catch {
    // no .gitignore — the SKIP_DIRS fallback still applies
  }
  const ignored = (rel: string, isDir: boolean): boolean =>
    ignores.some((r) => (isDir || !r.dirOnly) && r.re.test(rel));

  const entries: Entry[] = [];
  async function visit(dir: string): Promise<void> {
    let items;
    try {
      items = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    items.sort((a, b) => a.name.localeCompare(b.name));
    for (const item of items) {
      if (entries.length >= MAX_FILES) return;
      if (item.name.startsWith(".")) continue;
      const full = join(dir, item.name);
      const rel = relative(root, full).split(sep).join("/");
      if (item.isDirectory()) {
        if (SKIP_DIRS.has(item.name) || ignored(rel, true)) continue;
        await visit(full);
      } else if (item.isFile()) {
        if (ignored(rel, false)) continue;
        // Symlinks are neither branch — skipped, which also avoids cycles.
        try {
          const s = await stat(full);
          entries.push({ rel, size: s.size });
        } catch {
          // vanished mid-walk — ignore
        }
      }
    }
  }
  await visit(root);
  return entries;
}

/** READMEs first, then manifests, then source files shallowest-first. */
function priority(rel: string): number {
  const base = rel.split("/").pop()!.toLowerCase();
  if (base.startsWith("readme")) return 0;
  if (MANIFEST_NAMES.has(base)) return 1;
  return 2 + rel.split("/").length;
}

async function readHead(path: string, bytes: number): Promise<Buffer> {
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/** Drop a trailing incomplete UTF-8 sequence (a byte-cut can split a char). */
function trimIncompleteUtf8(buf: Buffer): Buffer {
  let i = buf.length - 1;
  let continuations = 0;
  while (i >= 0 && continuations < 3 && (buf[i]! & 0xc0) === 0x80) {
    i--;
    continuations++;
  }
  if (i < 0) return buf;
  const lead = buf[i]!;
  const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  return buf.length - i < need ? buf.subarray(0, i) : buf;
}

/** Byte-accurate truncation that never splits a multi-byte character. */
function truncateUtf8(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= maxBytes) return s;
  let end = maxBytes;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--; // back up off a split char
  return buf.subarray(0, end).toString("utf8");
}

// ---------------------------------------------------------------------------
// Executor source context: executors emit COMPLETE replacement files, so every
// file a brief asks them to edit must arrive whole — a truncated head invites a
// fabricated rewrite, which is exactly the failure this bundle exists to stop.

const MAX_HINTS = 500;
const DIR_EXPAND_CAP = 50; // files pulled in per directory hint

// Extensionless files a brief may name bare (no backticks, no extension).
const WELL_KNOWN_FILES = [
  "Makefile",
  "Dockerfile",
  "LICENSE",
  "Gemfile",
  "Procfile",
  "Rakefile",
  "Jenkinsfile",
  "Vagrantfile",
];

// "<…>" stays out of the delimiter sets: angle-bracket tokens are protocol
// placeholders (=== FILE: <relative/path> ===), never real paths.
const BACKTICK_RE = /`([^`\n]{1,256})`/g;
const SLASH_TOKEN_RE = /(?<=^|[\s"'(\[{])\.?[\w.@-]+(?:\/[\w.@-]+)+\/?/gm;
const DOTTED_NAME_RE =
  /(?<=^|[\s"'(\[{])[\w@-]+(?:\.[\w@-]+)*\.[A-Za-z][A-Za-z0-9]{0,7}(?=$|[\s"')\]}.,;:!?])/gm;
const WELL_KNOWN_RE = new RegExp(
  `(?<=^|[\\s"'(\\[{])(?:${WELL_KNOWN_FILES.join("|")})(?=$|[\\s"')\\]}.,;:!?])`,
  "gm",
);

/** True for relay's own on-disk artifacts — never a project source file. */
function isRelayInternal(t: string): boolean {
  const segments = t.split("/");
  if (segments.some((s) => s.startsWith("planner__"))) return true;
  if (/^rounds\/r\d{3}(\/|$)/.test(t)) return true;
  const base = segments[segments.length - 1]!;
  return (
    /\.(report|brief)\.md$/.test(base) ||
    base === "closure.json" ||
    base === "rollup.md" ||
    base === "raw.md" ||
    base === "events.ndjson" ||
    /^verdict\.(json|md)$/.test(base)
  );
}

/** A candidate must survive normalization to count as a path hint. */
function normalizeHint(raw: string): string | null {
  let t = raw.trim();
  // Strip wrapping quotes and trailing sentence punctuation, but preserve
  // path-significant [ ] ( ) + (framework route files like app/[slug]/page.tsx).
  t = t.replace(/^["']+/, "").replace(/["']+$/, "").replace(/[.,;:!?]+$/, "");
  if (t.startsWith("./")) t = t.slice(2);
  if (t.startsWith("/")) t = t.slice(1);
  if (t.endsWith("/")) t = t.slice(0, -1);
  if (t === "" || t.length > 256) return null;
  if (t.includes("://") || /[\\<>|:*?"\x00-\x1f]/.test(t)) return null; // URLs, shell/control chars
  if (!/^[\w.@+/()[\] -]+$/.test(t)) return null;
  if (/\s/.test(t) && !(t.includes("/") || /\.[A-Za-z0-9]{1,8}$/.test(t))) return null; // "npm test" is prose
  const segments = t.split("/");
  if (segments.includes("..") || segments.includes(".") || segments.includes("")) return null;
  if (/^v?\d+(\.\d+)+$/.test(t)) return null; // version-ish, not a file
  if (isRelayInternal(t)) return null;
  return t;
}

/** Never serve VCS internals or env secrets, even on an exact hint (case-insensitive). */
function forbiddenHint(hint: string): boolean {
  const segments = hint.toLowerCase().split("/");
  return segments.includes(".git") || segments[segments.length - 1]!.startsWith(".env");
}

/**
 * Deterministic path-like tokens from prose: backticked tokens, bare slash
 * paths, bare dotted filenames, well-known extensionless files. Deduped in
 * first-mention order across texts in the order given — so the caller's corpus
 * order (brief before prior reports before recon) is the budget priority order.
 */
export function extractPathHints(texts: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const text of texts) {
    const found: { index: number; hint: string }[] = [];
    for (const re of [BACKTICK_RE, SLASH_TOKEN_RE, DOTTED_NAME_RE, WELL_KNOWN_RE]) {
      for (const m of text.matchAll(re)) {
        const hint = normalizeHint(m[1] ?? m[0]);
        if (hint !== null) found.push({ index: m.index, hint });
      }
    }
    found.sort((a, b) => a.index - b.index);
    for (const f of found) {
      if (out.length >= MAX_HINTS) return out;
      if (!seen.has(f.hint)) {
        seen.add(f.hint);
        out.push(f.hint);
      }
    }
  }
  return out;
}

export interface ExecutorBundle {
  text: string; // file tree + full file contents + context manifest
  included: string[]; // rel paths inlined whole
  omitted: string[]; // rel paths matched but not inlined (caps, binary)
  missing: string[]; // slash-hints that resolved to nothing (new-file candidates)
}

function matchesIgnore(ignores: IgnoreRule[], rel: string, isDir: boolean): boolean {
  return ignores.some((r) => (isDir || !r.dirOnly) && r.re.test(rel));
}

async function loadIgnores(root: string): Promise<IgnoreRule[]> {
  try {
    return parseGitignore(await readFile(join(root, ".gitignore"), "utf8"));
  } catch {
    return [];
  }
}

/** Scoped walk of one subdirectory, project-relative rels, same rules as walk(). */
async function walkDir(
  root: string,
  startRel: string,
  ignores: IgnoreRule[],
  cap: number,
): Promise<{ rels: string[]; truncated: boolean }> {
  const rels: string[] = [];
  let truncated = false;
  async function visit(dirRel: string): Promise<void> {
    let items;
    try {
      items = await readdir(join(root, dirRel), { withFileTypes: true });
    } catch {
      return;
    }
    items.sort((a, b) => a.name.localeCompare(b.name));
    for (const item of items) {
      if (truncated) return;
      if (item.name.startsWith(".")) continue; // children only; the start dir itself may be a dotdir
      const rel = `${dirRel}/${item.name}`;
      if (item.isDirectory()) {
        if (SKIP_DIRS.has(item.name) || matchesIgnore(ignores, rel, true)) continue;
        await visit(rel);
      } else if (item.isFile()) {
        if (matchesIgnore(ignores, rel, false)) continue;
        if (rels.length >= cap) {
          truncated = true;
          return;
        }
        rels.push(rel);
      }
      // Symlinks are neither branch — skipped, matching walk() and avoiding escape.
    }
  }
  await visit(startRel);
  return { rels, truncated };
}

/**
 * Direct filesystem resolution of an exact hint, contained to the project.
 * realpath resolves symlinks; the target MUST stay within realpath(projectPath)
 * — a symlink (leaf or mid-path) pointing outside the checkout is rejected, so
 * secrets on the wider filesystem never reach the prompt. Honors .gitignore and
 * the .git/.env guard on the RESOLVED path, catching case-variant and aliased
 * bypasses (.ENV, a symlink named config → ../.env). Returns canonical casing.
 */
async function safeDirect(
  projectPath: string,
  projectReal: string,
  hint: string,
  ignores: IgnoreRule[],
): Promise<{ rels: string[]; truncated: boolean } | null> {
  let real: string;
  try {
    real = await realpath(join(projectPath, hint));
  } catch {
    return null;
  }
  const relReal = relative(projectReal, real);
  if (relReal === "" || relReal.startsWith("..") || isAbsolute(relReal)) return null; // escaped root
  const canonical = relReal.split(sep).join("/");
  if (forbiddenHint(canonical)) return null;
  let st;
  try {
    st = await stat(real);
  } catch {
    return null;
  }
  if (st.isFile()) {
    return matchesIgnore(ignores, canonical, false) ? null : { rels: [canonical], truncated: false };
  }
  if (st.isDirectory()) {
    if (matchesIgnore(ignores, canonical, true)) return null;
    return walkDir(projectPath, canonical, ignores, DIR_EXPAND_CAP);
  }
  return null;
}

/**
 * Resolve one hint to project-relative paths. Order: exact tree match, then an
 * exact contained direct-stat (so a precise path wins over a fuzzy suffix even
 * when the walk missed it — MAX_FILES cap, dotfiles, gitignored-but-named), then
 * suffix, then case-insensitive. A directory resolves to its files. When a
 * slash-hint misses and it carries a leading `<area>/` segment (fix-round briefs
 * echo area-prefixed workspace paths), one retry strips that segment.
 */
async function resolveHint(
  projectPath: string,
  projectReal: string,
  hint: string,
  entries: Entry[],
  byRel: Set<string>,
  ignores: IgnoreRule[],
  area: string | undefined,
): Promise<{ rels: string[]; dirTruncated: string[] }> {
  const dirTruncated: string[] = [];
  const attempt = async (h: string): Promise<string[]> => {
    if (byRel.has(h)) return [h];
    const direct = await safeDirect(projectPath, projectReal, h, ignores);
    if (direct !== null) {
      if (direct.truncated) dirTruncated.push(h);
      if (direct.rels.length > 0) return direct.rels;
    }
    const suffix = entries.filter((e) => e.rel.endsWith(`/${h}`)).map((e) => e.rel);
    if (suffix.length > 0) return suffix;
    const lower = h.toLowerCase();
    return entries
      .filter((e) => e.rel.toLowerCase() === lower || e.rel.toLowerCase().endsWith(`/${lower}`))
      .map((e) => e.rel);
  };
  let rels = await attempt(hint);
  if (rels.length === 0 && area !== undefined && hint.startsWith(`${area}/`)) {
    rels = await attempt(hint.slice(area.length + 1));
  }
  return { rels, dirTruncated };
}

/**
 * Full current contents of the project files the hints reference, whole-file-
 * or-nothing under the caps, plus the file tree and an explicit manifest of
 * everything NOT inlined and why. No silent truncation anywhere.
 */
export async function bundleForExecutor(
  projectPath: string,
  hints: string[],
  caps: { perFileBytes: number; totalBytes: number },
  area?: string,
): Promise<ExecutorBundle> {
  const entries = await walk(projectPath);
  const treeCapped = entries.length >= MAX_FILES;
  const byRel = new Set(entries.map((e) => e.rel));
  const ignores = await loadIgnores(projectPath);
  let projectReal: string;
  try {
    projectReal = await realpath(projectPath);
  } catch {
    projectReal = projectPath;
  }

  const queue: string[] = [];
  const queued = new Set<string>();
  const missing: string[] = [];
  const dirCapped = new Set<string>();
  for (const raw of hints) {
    const hint = normalizeHint(raw);
    if (hint === null || forbiddenHint(hint)) continue;
    const { rels, dirTruncated } = await resolveHint(
      projectPath,
      projectReal,
      hint,
      entries,
      byRel,
      ignores,
      area,
    );
    for (const d of dirTruncated) dirCapped.add(d);
    if (rels.length === 0) {
      // Only path-shaped misses are worth surfacing; a bare dotted token that
      // resolves to nothing is prose, not a reference.
      if (hint.includes("/")) missing.push(hint);
      continue;
    }
    for (const rel of rels) {
      if (!queued.has(rel)) {
        queued.add(rel);
        queue.push(rel);
      }
    }
  }

  const included: { rel: string; size: number; content: string }[] = [];
  const overFile: { rel: string; size: number }[] = [];
  const overTotal: { rel: string; size: number }[] = [];
  const binaries: { rel: string; size: number }[] = [];
  const nonUtf8: { rel: string; size: number }[] = [];
  let used = 0;
  for (const rel of queue) {
    let size: number;
    try {
      size = (await stat(join(projectPath, rel))).size;
    } catch {
      continue; // vanished — tree-only
    }
    if (size > caps.perFileBytes) {
      overFile.push({ rel, size });
      continue;
    }
    let buf: Buffer;
    try {
      buf = await readFile(join(projectPath, rel));
    } catch {
      continue;
    }
    if (buf.subarray(0, 8192).includes(0)) {
      binaries.push({ rel, size });
      continue;
    }
    const content = buf.toString("utf8");
    // A lossy decode means non-UTF-8 bytes; inlining would silently replace them
    // with U+FFFD while the prompt asserts "exact on-disk state" — omit instead.
    if (!Buffer.from(content, "utf8").equals(buf)) {
      nonUtf8.push({ rel, size });
      continue;
    }
    if (used + size > caps.totalBytes) {
      overTotal.push({ rel, size });
      continue;
    }
    used += size;
    included.push({ rel, size, content });
  }

  const fmt = (xs: { rel: string; size: number }[]): string =>
    xs.map((x) => `${x.rel} (${x.size}B)`).join(", ");
  const manifest = [
    `Provided in full (${included.length} files, ${used}B of ${caps.totalBytes}B budget): ${
      included.length > 0 ? included.map((f) => f.rel).join(", ") : "(none)"
    }`,
  ];
  if (overFile.length > 0) {
    manifest.push(
      `Omitted — over the ${caps.perFileBytes}B per-file cap (RELAY_EXEC_FILE_BYTES): ${fmt(overFile)}`,
    );
  }
  if (overTotal.length > 0) {
    manifest.push(
      `Omitted — over the ${caps.totalBytes}B total budget (RELAY_EXEC_BUNDLE_BYTES): ${fmt(overTotal)}`,
    );
  }
  if (binaries.length > 0) manifest.push(`Binary — not inlined: ${fmt(binaries)}`);
  if (nonUtf8.length > 0) {
    manifest.push(
      `Not inlined — non-UTF-8 (edit the on-disk file directly, or block that ask): ${fmt(nonUtf8)}`,
    );
  }
  if (dirCapped.size > 0) {
    manifest.push(
      `Directory expansion capped at ${DIR_EXPAND_CAP} files — some files under these hints are not shown: ${[...dirCapped].join(", ")}`,
    );
  }
  if (missing.length > 0) {
    manifest.push(
      `Referenced but not found in project — create it if it is genuinely new; otherwise re-check the exact path and block that ask: ${missing.join(", ")}`,
    );
  }

  const sections = [
    `### File tree (${entries.length} files)\n${entries.map((e) => `${e.rel} (${e.size}B)`).join("\n")}${
      treeCapped
        ? `\n(tree truncated at ${MAX_FILES} entries — exact paths named in reports still resolve)`
        : ""
    }`,
    ...included.map(
      (f) =>
        `### ${f.rel} (${f.size}B)\n\`\`\`\n${f.content}${f.content.endsWith("\n") ? "" : "\n"}\`\`\``,
    ),
    `### Context manifest\n${manifest.join("\n")}`,
  ];
  return {
    text: sections.join("\n\n"),
    included: included.map((f) => f.rel),
    omitted: [...overFile, ...overTotal, ...binaries, ...nonUtf8].map((x) => x.rel),
    missing,
  };
}
