/** Read-only project bundle for recon: git-aware file tree + heads of key files, size-capped. */
import { open, readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

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
