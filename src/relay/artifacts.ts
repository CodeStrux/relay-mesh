import { join, resolve, sep } from "node:path";
import { atomicWrite } from "./fsio.js";
import { parseReport } from "./report.js";

export interface ExtractResult {
  files: { relpath: string; bytes: number }[];
  reportMd: string | null; // the REPORT section incl. status block, or null if unparseable
  problems: string[];
}

const FILE_RE = /^===\s*FILE:\s*(.+?)\s*===\s*$/;
const END_RE = /^===\s*END\s*===\s*$/;
const REPORT_RE = /^===\s*REPORT\s*===\s*$/;

function badPath(relpath: string): string | null {
  if (relpath.startsWith("/")) return `absolute path rejected: ${relpath}`;
  if (relpath.includes("..")) return `path traversal rejected: ${relpath}`;
  return null;
}

interface ParsedWire {
  files: { relpath: string; content: string }[];
  reportMd: string | null;
  problems: string[];
}

function parseWire(output: string): ParsedWire {
  const lines = output.split("\n");
  const files: ParsedWire["files"] = [];
  const problems: string[] = [];
  let reportMd: string | null = null;
  let i = 0;

  outer: while (i < lines.length) {
    const fm = FILE_RE.exec(lines[i]!);
    if (fm) {
      const relpath = fm[1]!;
      i++;
      const content: string[] = [];
      while (i < lines.length) {
        const l = lines[i]!;
        if (END_RE.test(l)) {
          i++;
          const err = badPath(relpath);
          if (err) problems.push(err);
          else files.push({ relpath, content: content.length ? `${content.join("\n")}\n` : "" });
          continue outer;
        }
        if (REPORT_RE.test(l)) {
          // Salvage the report even when a FILE block never closed; the file is discarded.
          problems.push(`unterminated FILE block: ${relpath}`);
          continue outer;
        }
        content.push(l);
        i++;
      }
      problems.push(`unterminated FILE block: ${relpath}`);
      break;
    }
    if (REPORT_RE.test(lines[i]!)) {
      reportMd = lines.slice(i + 1).join("\n");
      break;
    }
    i++; // prose outside blocks is ignored
  }

  if (reportMd === null) {
    problems.push("no REPORT section found");
  } else {
    // Models often leave a blank line after the marker; the status block must start at line 1.
    reportMd = reportMd.replace(/^(?:[ \t\r]*\n)+/, "");
    if (parseReport(reportMd).status === null) {
      problems.push("REPORT status block does not parse");
      reportMd = null;
    }
  }
  return { files, reportMd, problems };
}

/** Pure parse of the executor wire format (=== FILE: p === … === END === … === REPORT ===). */
export function extractArtifacts(output: string): ExtractResult {
  const p = parseWire(output);
  return {
    files: p.files.map((f) => ({ relpath: f.relpath, bytes: Buffer.byteLength(f.content, "utf8") })),
    reportMd: p.reportMd,
    problems: p.problems,
  };
}

/**
 * Writes extracted FILE blocks under <ws>/files/ (re-parsed from output — ExtractResult
 * carries only metadata) and, when reportMd === null or any parse problem was recorded
 * (unterminated FILE blocks, rejected paths), salvages the verbatim output at
 * <ws>/raw.md so tokens are never lost.
 */
export async function writeArtifacts(
  res: ExtractResult,
  areaWorkspaceDir: string,
  output: string,
): Promise<void> {
  const parsed = parseWire(output);
  const filesRoot = resolve(areaWorkspaceDir, "files");
  for (const f of parsed.files) {
    const dest = resolve(filesRoot, f.relpath);
    // Belt-and-braces confinement on top of badPath(): never escape the area dir.
    if (!dest.startsWith(filesRoot + sep)) continue;
    await atomicWrite(dest, f.content);
  }
  if (res.reportMd === null || res.problems.length > 0) {
    await atomicWrite(join(areaWorkspaceDir, "raw.md"), output);
  }
}
