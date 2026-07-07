import { appendFile, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

function isMissing(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** Atomic publication: write <path>.part in the same dir, then rename(2). mkdir -p first. */
export async function atomicWrite(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const part = `${filePath}.part`;
  await writeFile(part, content, "utf8");
  await rename(part, filePath);
}

export async function safeRead(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
}

/** Protocol rule: readers ignore *.part and dot-prefixed entries. Sorted for determinism. */
export async function listVisible(dir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if (isMissing(err)) return [];
    throw err;
  }
  return names.filter((n) => !n.startsWith(".") && !n.endsWith(".part")).sort();
}

/** ndjson append; single writer per file per the protocol, so a plain append is safe. */
export async function appendLine(filePath: string, line: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await appendFile(filePath, line.endsWith("\n") ? line : `${line}\n`, "utf8");
}
