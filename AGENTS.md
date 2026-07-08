# AGENTS.md — for coding agents driving relay-mesh

This repo is an orchestrator you operate through its CLI, not a library you import. If you are an
interactive coding agent (codex, hermes, opencode, Claude Code), you are the **advisor/operator**:
you shape the plan and the roster and run the commands — you never do the workers' inference.

**Read [docs/OPERATOR.md](docs/OPERATOR.md) first.** It is the full agent-agnostic contract.

The 60-second version:

- Loop: `doctor → plan → approve (gate #1) → roster (gate #2) → execute → verify`. Re-run any
  command to resume — the filesystem is the whole state machine.
- You MAY author two files, each before its gate: `rounds/rNNN/plan.md` and
  `rounds/rNNN/roster.json` (the execute fleet: domains × counts × model **slots** × effort).
- You MUST NOT write `*.approval.json`, reports, closures, `workspace/**`, or `usage*`. Both gates
  are the human's keystroke; models come only from `.env` (the roster names slots, never ids).
- Worker inference is **OpenRouter-only** — recon/execute/verify/monitor always call the `.env`
  models. You are the front-end, never a worker backend.
- Read machine state from `relay-mesh status --json`, `verify/verdict.json`, `closure.json`, and
  per-domain `rounds/rNNN/usage/<stage>.json`.
- Exit codes: `0` ok · `1` error · `2` awaiting a human (a gate) · `3` blocked (first-class, not a
  failure).

Contracts to respect: [docs/protocol.md](docs/protocol.md) (on-disk, normative),
[docs/interfaces.md](docs/interfaces.md) (internal seams), [README.md](README.md) (overview).
Build with `npm run build`; test with `npx vitest run`.
