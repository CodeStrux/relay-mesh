# The relay-mesh on-disk protocol (normative)

This document is the contract. Code conforms to it, not the other way around. The filesystem under `RELAY_ROOT` is the **entire** state machine: no databases, no lockfiles, no in-memory state that matters. Any command, on any machine sharing the root, starts by deriving state from disk and may be killed at any moment without corruption.

Pair directories are byte-compatible with the `relay-to-sibling` skill convention: its `relay-close.sh` produces the same `closure.json` this tool does.

## Layout

```
$RELAY_ROOT/
├── mesh.json                    # {"protocol":1,"created":"<ISO-8601>","tool":"relay-mesh@<version>"}
├── project.json                 # optional; {"path":"<abs path>","host":"<user>@<host>","recorded":ISO}
│                                #   written by `plan --project`; advisory — the path may not resolve on
│                                #   another machine (execute degrades to per-ask blocks, or takes --project)
├── goal.md                      # the user's goal verbatim + attachment manifest; written once by `plan`
├── inputs/                      # copies of --attach files (immutable after plan)
├── usage.ndjson                 # one line per LLM call:
│                                #   {"ts":ISO,"round":"r001","profile":"exec-backend","model":"…",
│                                #    "in":1234,"out":5678}
└── rounds/
    └── r001/                    # zero-padded, append-only; r002+ are fix rounds
        ├── recon/
        │   ├── planner__recon-backend/    # backend.brief.md / backend.report.md / closure.json
        │   ├── planner__recon-frontend/   # frontend.*
        │   ├── planner__recon-business/   # business.*
        │   └── planner__recon-vision/     # vision.*
        ├── plan.md              # planner synthesis; MUST contain "## Domain brief: <area>" sections
        ├── plan.approval.json   # {"decision":"approved"|"rejected","by":"<user>@<host>","at":ISO,
        │                        #  "plan_sha256":"<hex>","notes":""}
        ├── exec/
        │   ├── planner__backend/          # backend.brief.md / backend.report.md / closure.json
        │   ├── planner__frontend/         # frontend.*
        │   └── planner__infra/            # infra.*
        ├── workspace/
        │   └── <area>/
        │       ├── files/…      # proposed artifacts, quarantined (never a live repo)
        │       └── raw.md       # verbatim salvage when executor output failed to parse
        ├── monitor/
        │   ├── events.ndjson    # append-only deterministic observations (no AI), e.g.
        │   │                    #   {"t":ISO,"event":"report_updated","pair":"planner__backend",
        │   │                    #    "bytes":8123,"status":"partial","steps_done":3,"steps_total":5}
        │   └── rollup.md        # the monitor profile's ONE roll-up, written at phase end
        ├── verify/
        │   ├── verdict.json     # {"satisfied":bool,"gaps":[{"area":"…","description":"…"}],"generated":ISO}
        │   └── verdict.md       # prose rationale
        └── .transcripts/        # raw per-call transcripts; dot-prefixed = protocol-invisible
```

## The report status block

Every `<area>.report.md` MUST open with this flat block (first line `---`, closed by `---`).
Values may carry trailing `  # comments`, which parsers strip. A report whose block does not
parse is **in-flight, not authoritative**.

```yaml
---
area: backend
status: complete        # complete | partial | blocked
steps_done: 5
steps_total: 5
plan_ref: rounds/r001/plan.md
---
```

`blocked` is a **first-class outcome**: work held for operator clearance, never a failure.
Tools must surface it distinctly (exit code 3), never restyle it as an error.

## closure.json

Deterministic roll-up of every `*.report.md` in a pair dir. No AI. Semantics identical to the
`relay-to-sibling` skill's `relay-close.sh`:

- per brief: `pct = floor(steps_done * 100 / steps_total)`; when `steps_total == 0`:
  `100` if `status == complete`, else `0`.
- `totals.pct = floor(Σ steps_done * 100 / Σ steps_total)` (`0` when `Σ steps_total == 0`).
- `totals.blocked` = list of areas whose `status` is `blocked`.
- empty pair dir → `{"pair":…,"generated":…,"briefs":[],"totals":{"pct":0,"blocked":[]}}`.

Shape:

```json
{
  "pair": "planner__backend",
  "generated": "2026-07-06T21:00:00Z",
  "briefs": [
    { "area": "backend", "status": "complete", "steps_done": 5, "steps_total": 5, "pct": 100, "plan_ref": "rounds/r001/plan.md" }
  ],
  "totals": { "pct": 100, "blocked": [] }
}
```

## The executor wire format

Executor LLM output is parsed by `relay/artifacts.ts`. It must consist of zero or more FILE
blocks followed by exactly one REPORT section:

```
=== FILE: src/routes/checkout.ts ===
…complete file contents…
=== END ===
=== REPORT ===
---
area: backend
status: complete
steps_done: 5
steps_total: 5
plan_ref: rounds/r001/plan.md
---
1. Ask #1 — done: …
```

- Each FILE block lands at `workspace/<area>/files/<relpath>`. Paths containing `..` or starting
  with `/` are rejected; writes are confined under the area dir.
- The REPORT section becomes the pair's `<area>.report.md`.
- Malformed output earns ONE corrective re-prompt; if still malformed, the verbatim output is
  preserved at `workspace/<area>/raw.md` and a synthesized `status: partial` report is written
  noting the parse failure. Tokens are never lost; parsing never crashes the phase.

## Concurrency & multi-machine rules

Designed so a relay root can later be shared across machines (syncthing/NFS):

1. **Single writer per file.** Briefs: the approving CLI. `<area>.report.md`: the one executor
   for that area. `closure.json`: the roll-up step. `events.ndjson`: the monitoring host.
   `plan.approval.json`: the approving human's CLI. `project.json`: the plan CLI.
   No file ever has two writers → no locks.
2. **Atomic publication.** Every write goes to `<name>.part` in the same directory, then
   `rename(2)`. A visible file is always complete.
3. **Readers ignore `*.part` and dot-prefixed entries.** (`watch` may display `.part` byte sizes
   as a liveness signal, but never their content.)
4. A report is authoritative **only** if its status block parses.
5. **Rounds are append-only.** Nothing in a terminal round is rewritten; fixes go in the next
   round. (`execute --force-area <a>` is the only sanctioned per-pair override, and it may only
   overwrite that pair's report + workspace within the current round.)
6. Every command begins with `deriveState(RELAY_ROOT)` — a pure function of the filesystem.

## The phase machine

Evaluated per round, in order; the first match wins:

| Condition (within latest round rNNN)                       | Phase              |
|------------------------------------------------------------|--------------------|
| no `goal.md` at root                                        | `idle`             |
| any recon pair missing a parseable report                   | `recon`            |
| recon done, no `plan.md`                                    | `synthesis`        |
| `plan.md` present, no approval file                         | `awaiting-approval`|
| approval `decision == rejected`                             | `replanning`       |
| approved & sha256 matches, any exec pair not terminal       | `executing`        |
| exec terminal, no `monitor/rollup.md`                       | `rollup`           |
| rollup present, no `verify/verdict.json`                    | `verifying`        |
| `verdict.satisfied == true`                                 | `done`             |
| `rounds/rNNN+1/` exists                                     | (recurse into it)  |
| otherwise                                                   | `fix-planning`     |

"Terminal" for an exec pair: a parseable report exists (any status). Resume is per-pair: a crashed
`execute` re-run only re-launches pairs without parseable reports.

## Approval integrity

`plan.approval.json` pins `sha256(plan.md)` at approval time. `execute` re-hashes `plan.md` and
refuses on mismatch (exit 1, "plan edited after approval — re-approve"). Domain briefs are
extracted **deterministically** from the approved `plan.md` (`## Domain brief: <area>` sections,
verbatim, with a fixed protocol preamble prepended). No LLM runs between approval and execution.

## Exit codes (all commands)

| Code | Meaning |
|---|---|
| 0 | success / terminal-good |
| 1 | error or misuse (including approval-hash mismatch) |
| 2 | awaiting a human (gate pending, or partial work remains) |
| 3 | blocked outcomes present — actionable, first-class, not a failure |
