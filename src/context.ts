/** Read-only project bundle for recon: file tree + heads of key files, size-capped. */
import { open, readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

const DEFAULT_CAP_BYTES = 30_000;
const HEAD_BYTES = 2_000; // per-file head budget
const MAX_FILES = 400; // hard stop against runaway trees

// .gitignore-ish pruning; hidden entries (.git, .env, caches) are always skipped.
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

export async function bundleProject(
  projectPath: string,
  capBytes: number = DEFAULT_CAP_BYTES,
): Promise<string> {
  const entries = await walk(projectPath);
  const tree = entries.map((e) => `${e.rel} (${e.size}B)`).join("\n");
  let out = `# Project: ${projectPath}\n\n## File tree (${entries.length} files)\n${tree}\n\n## Key files\n`;

  const ordered = [...entries].sort(
    (a, b) => priority(a.rel) - priority(b.rel) || a.rel.localeCompare(b.rel),
  );
  for (const entry of ordered) {
    if (out.length >= capBytes) break;
    let head: Buffer;
    try {
      head = await readHead(join(projectPath, entry.rel), HEAD_BYTES);
    } catch {
      continue;
    }
    if (head.includes(0)) continue; // NUL byte ⇒ binary — tree-only
    const truncated = entry.size > HEAD_BYTES ? "\n… (truncated)" : "";
    const section = `\n### ${entry.rel}\n\`\`\`\n${head.toString("utf8")}${truncated}\n\`\`\`\n`;
    if (out.length + section.length > capBytes) break;
    out += section;
  }
  return out.length > capBytes ? out.slice(0, capBytes) : out;
}

async function walk(root: string): Promise<Entry[]> {
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
      if (item.isDirectory()) {
        if (SKIP_DIRS.has(item.name)) continue;
        await visit(full);
      } else if (item.isFile()) {
        // Symlinks are neither branch — skipped, which also avoids cycles.
        try {
          const s = await stat(full);
          entries.push({ rel: relative(root, full).split(sep).join("/"), size: s.size });
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
