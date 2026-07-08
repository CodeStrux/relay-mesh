# Operating relay-mesh (agent-agnostic)

relay-mesh is driven entirely through its CLI and the on-disk protocol
([docs/protocol.md](protocol.md)). Any interactive coding agent — Claude Code, codex, hermes,
opencode — can play **advisor/operator**: talk to the human, shape the plan and the roster, and
run the commands. The mesh also runs with **no advisor**: a built-in fallback authors both the
plan and a default roster, and a human runs the gates directly. This document is the one contract
every advisor obeys.

## Two roles, one hard line

- **Advisor / operator** (you, the interactive agent) — reasons about the goal, *proposes* the
  plan and the roster, runs the CLI, and reports. It never performs worker inference.
- **Workers** (recon, executors, monitor, verifier, fallback planner) — always
  **OpenRouter-only**, using the model slots in the operator's `.env`. This is mandatory and
  non-negotiable: the advisor front-end is never a worker inference backend.

The advisor **proposes**; the human **disposes**. Both gates are the human's keystroke.

## The loop

```
doctor → plan → approve (GATE #1) → roster (GATE #2) → execute → verify → (gaps) → back to approve
```

Every command derives its state from the filesystem, so the loop is **resume-by-re-run**: a
killed command, re-run, picks up exactly where it stopped. `run` chains the whole loop and stops
at each gate.

| Step | Command | What it does | Stops at |
|---|---|---|---|
| 0 | `relay-mesh doctor [--models]` | env / key / profiles / prompts / root / live model-slug check | — |
| 1 | `relay-mesh plan "<goal>" [--attach f]… [--project p]` | recon (ungated) → `plan.md` | exit 2 (gate #1) |
| 2 | `relay-mesh approve` | **gate #1**: pins `sha256(plan.md)` | typed `approve` |
| 3 | `relay-mesh roster` | **gate #2**: lints + pins `sha256(roster.json)`, writes briefs | typed `approve` |
| 4 | `relay-mesh execute [--area a]… [--project p]` | OpenRouter worker fan-out + monitor | exit 3 if blocked |
| 5 | `relay-mesh verify` | verdict vs goal; scaffolds a fix round on gaps | exit 2/3 |

## What the advisor MAY write, and MUST NOT

The advisor may author exactly two files, both **before** their gate:

- `rounds/rNNN/plan.md` — the plan (re-arms gate #1 on every edit).
- `rounds/rNNN/roster.json` — the execute fleet (re-arms gate #2 on every edit).

The advisor **must never** write any of:

- `plan.approval.json`, `roster.approval.json` — the gates are the human's. Running
  `approve`/`roster` without a human keystroke (i.e. passing `--yes`) is a human decision to
  delegate, not the advisor's to make.
- `*.report.md`, `closure.json`, `workspace/**`, `monitor/**`, `usage.ndjson`,
  `usage/<stage>.json` — these are worker/engine outputs. Forging them corrupts the state machine.

Models are **never** the advisor's to set. The roster names model **slots** (`modelEnv`), resolved
only through the operator's `.env`. An inline model id, or a slot the operator has not declared, is
a hard lint failure at gate #2.

## roster.json — the execute fleet

```json
{
  "version": 1,
  "execute": [
    { "domain": "backend",  "template": "exec-backend",  "count": 3, "modelEnv": "BACKEND_MODEL",  "effort": "xhigh" },
    { "domain": "frontend", "template": "exec-frontend", "count": 1, "modelEnv": "FRONTEND_MODEL", "effort": "high"  },
    { "domain": "docs",     "template": "exec-frontend", "count": 1, "modelEnv": "FRONTEND_MODEL", "effort": "medium" }
  ]
}
```

Per domain: a `template` (an executor profile supplying the persona), a worker `count` (`1`–`16`;
`>1` shards the domain into `planner__<domain>__w<i>` pairs, each with its own workspace), a model
`modelEnv` **slot**, and an `effort`. A `domain` may be **new** (minted from a template) as long as
`plan.md` carries a matching `## Domain brief: <domain>` section — gate #2 hard-blocks a rostered
domain with no brief, so a minted domain can never silently produce zero work. Governs the
**execute** stage only; recon runs inside `plan`, before either gate.

If the advisor writes no roster, `roster` authors a **default** one: a single count-1 worker per
`## Domain brief:` heading, personas matched by area (fallback template otherwise) — byte-identical
to the pre-roster behavior.

## Machine reads (what the advisor consumes)

All read-only, all pure functions of the filesystem:

- `relay-mesh status --json` — the full derived state: `phase`, `round`, `approval`,
  `rosterApproval`, `planSha256`, `rosterSha256`, per-pair `recon[]`/`exec[]`, `verdict`, and rolled-up `usage`.
- `rounds/rNNN/roster.json` — the current fleet (read it back to confirm what will spawn).
- `rounds/rNNN/verify/verdict.json` — `{satisfied, gaps[]}`.
- `rounds/rNNN/exec/<pair>/closure.json` — deterministic per-pair progress + blocked areas.
- `usage.ndjson` (append-only ledger) and `rounds/rNNN/usage/<stage>.json` — per-domain token
  reports at each stage boundary (`recon` | `execute` | `verify`). Or `relay-mesh costs --by
  domain --round rNNN`.

## Exit codes (uniform across commands)

| Code | Meaning | Advisor action |
|---|---|---|
| 0 | success / terminal-good | proceed to the next step |
| 1 | error or misuse (incl. either hash mismatch, lint hard-block) | read the 3-line error, fix, re-run |
| 2 | awaiting a human (a gate is pending, or partial work remains) | surface the gate to the human |
| 3 | blocked outcomes present — first-class, **not** a failure | read the blocked report(s), get them cleared, re-run |

## Iron rules

1. **Worker inference is OpenRouter-only.** The advisor never substitutes itself for a worker.
2. **Both gates are the human's.** The advisor proposes `plan.md` and `roster.json`; it never
   writes an `*.approval.json`.
3. **Models come only from `.env`.** The roster names slots; the advisor cannot pick an id.
4. **The filesystem is the state machine.** Re-run to resume; never hand-edit engine outputs.
5. **`blocked` (exit 3) is a held outcome, not an error.** Never restyle it as a failure.
