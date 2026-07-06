import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Loads a profile prompt file; expands "{{> _partial.md}}" includes (one level)
 * from the prompt file's own directory; interpolates {{GOAL}}, {{REPORT_PATH}},
 * {{AREA}}, {{ROUND}} style vars. Unknown vars are left intact. Concatenation only.
 */
export async function composePrompt(
  promptPath: string,
  vars: Record<string, string>,
): Promise<string> {
  const raw = await readFile(promptPath, "utf8");
  const expanded = await expandIncludes(raw, dirname(promptPath));
  return interpolate(expanded, vars);
}

/** One level only: included content is never re-scanned for further includes. */
async function expandIncludes(text: string, dir: string): Promise<string> {
  const includeRe = /\{\{>\s*([^\s}][^}]*?)\s*\}\}/g;
  const parts: string[] = [];
  let last = 0;
  for (const match of text.matchAll(includeRe)) {
    parts.push(text.slice(last, match.index));
    parts.push(await readFile(join(dir, match[1]!), "utf8"));
    last = match.index + match[0].length;
  }
  parts.push(text.slice(last));
  return parts.join("");
}

function interpolate(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{([A-Za-z0-9_]+)\}\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? vars[name]! : whole,
  );
}
