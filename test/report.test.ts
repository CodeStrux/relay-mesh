import { describe, expect, it } from "vitest";
import { parseReport, serializeStatusBlock, type StatusBlock } from "../src/relay/report.js";

const block: StatusBlock = {
  area: "backend",
  status: "complete",
  steps_done: 5,
  steps_total: 5,
  plan_ref: "rounds/r001/plan.md",
};

describe("serializeStatusBlock", () => {
  it("emits the exact protocol shape ending with ---\\n", () => {
    expect(serializeStatusBlock(block)).toBe(
      "---\narea: backend\nstatus: complete\nsteps_done: 5\nsteps_total: 5\nplan_ref: rounds/r001/plan.md\n---\n",
    );
  });
});

describe("parseReport", () => {
  it("round-trips a serialized block with empty body", () => {
    const { status, body } = parseReport(serializeStatusBlock(block));
    expect(status).toEqual(block);
    expect(body).toBe("");
  });

  it("preserves the body verbatim after the closing delimiter", () => {
    const md = `${serializeStatusBlock(block)}1. Ask #1 — done.\n2. Ask #2 — done.\n`;
    const { status, body } = parseReport(md);
    expect(status).toEqual(block);
    expect(body).toBe("1. Ask #1 — done.\n2. Ask #2 — done.\n");
  });

  it("strips trailing # comments preceded by whitespace", () => {
    const md =
      "---\narea: backend\nstatus: partial   # still working\nsteps_done: 3  # of five\nsteps_total: 5\nplan_ref: rounds/r001/plan.md\n---\n";
    const { status } = parseReport(md);
    expect(status).toEqual({
      area: "backend",
      status: "partial",
      steps_done: 3,
      steps_total: 5,
      plan_ref: "rounds/r001/plan.md",
    });
  });

  it("keeps # without preceding whitespace (awk parity)", () => {
    const md =
      "---\narea: backend\nstatus: complete\nsteps_done: 5\nsteps_total: 5\nplan_ref: plans/a#1.md\n---\n";
    expect(parseReport(md).status?.plan_ref).toBe("plans/a#1.md");
  });

  it("accepts keys in any order and ignores unknown keys", () => {
    const md =
      "---\nplan_ref: rounds/r001/plan.md\nsteps_total: 4\nnote: something else\nsteps_done: 1\nstatus: blocked\narea: infra\n---\nbody\n";
    const { status } = parseReport(md);
    expect(status).toEqual({
      area: "infra",
      status: "blocked",
      steps_done: 1,
      steps_total: 4,
      plan_ref: "rounds/r001/plan.md",
    });
  });

  it("tolerates trailing whitespace on delimiter lines", () => {
    const md =
      "---  \narea: backend\nstatus: complete\nsteps_done: 0\nsteps_total: 0\nplan_ref: p.md\n--- \n";
    expect(parseReport(md).status?.status).toBe("complete");
  });

  it("returns null status when a required key is missing", () => {
    const md = "---\narea: backend\nstatus: complete\nsteps_done: 5\nsteps_total: 5\n---\n";
    expect(parseReport(md).status).toBeNull();
  });

  it("returns null status on an invalid status value", () => {
    const md = "---\narea: backend\nstatus: wip\nsteps_done: 1\nsteps_total: 5\nplan_ref: p.md\n---\n";
    expect(parseReport(md).status).toBeNull();
  });

  it("returns null status on non-numeric or negative steps", () => {
    const bad =
      "---\narea: backend\nstatus: partial\nsteps_done: abc\nsteps_total: 5\nplan_ref: p.md\n---\n";
    expect(parseReport(bad).status).toBeNull();
    const neg =
      "---\narea: backend\nstatus: partial\nsteps_done: -1\nsteps_total: 5\nplan_ref: p.md\n---\n";
    expect(parseReport(neg).status).toBeNull();
  });

  it("returns null status and the full body when the first line is not ---", () => {
    const md = "In progress, block coming soon.\n---\narea: backend\n---\n";
    const res = parseReport(md);
    expect(res.status).toBeNull();
    expect(res.body).toBe(md);
  });

  it("returns null status on an unterminated block", () => {
    const md = "---\narea: backend\nstatus: complete\n";
    const res = parseReport(md);
    expect(res.status).toBeNull();
    expect(res.body).toBe(md);
  });

  it("returns null status on empty input", () => {
    expect(parseReport("").status).toBeNull();
  });
});
