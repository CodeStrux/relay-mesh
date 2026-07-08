/**
 * Deterministic, verbatim extraction of "## Domain brief: <area>" plan sections.
 * A relay-layer primitive: the only path from an approved plan to execution
 * briefs, shared by the planner (lint), the approval preview, the roster
 * expansion (gate #2), and execute — no LLM in between.
 */

const BRIEF_HEADING = /^##\s+Domain brief:\s*(.+?)\s*$/;

/**
 * Map each "## Domain brief: <area>" heading to its verbatim section (the
 * heading line through the line before the next level-2 heading), in document
 * order.
 */
export function extractDomainBriefs(planMd: string): Map<string, string> {
  const lines = planMd.split("\n");
  const briefs = new Map<string, string>();
  let area: string | null = null;
  let start = 0;
  const flush = (end: number): void => {
    if (area !== null) briefs.set(area, lines.slice(start, end).join("\n"));
  };
  for (let i = 0; i < lines.length; i++) {
    const m = BRIEF_HEADING.exec(lines[i]!);
    if (m) {
      flush(i);
      area = m[1]!;
      start = i;
      continue;
    }
    if (area !== null && /^##\s/.test(lines[i]!)) {
      flush(i);
      area = null;
    }
  }
  flush(lines.length);
  return briefs;
}
