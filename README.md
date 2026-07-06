# relay-mesh

A parallel-workstream orchestrator for open-weight models. You give it a goal (and optionally a whiteboard photo, a diagram, a video); it fans out four recon agents, synthesizes a plan, stops for your approval, then runs three domain executors in parallel while a junior monitor watches the relay directories. A verifier checks the outcome against your goal and, if it falls short, scaffolds a fix round — back through the same human gate. Every agent is an open-weight model called through OpenRouter. All state lives on disk under one directory: kill any command at any moment, re-run it, and it resumes.

```
  goal + attachments
        |
        v
      plan ----> recon x4  (backend | frontend | business | vision, parallel)
        |
        v
    synthesis -> rounds/rNNN/plan.md
        |
        v
 === HUMAN GATE ===  approve / reject (plan sha256-pinned)
        |
        v
    execute x3  (backend | frontend | infra, parallel)  ||  monitor (poller)
        |
        v
      rollup    (monitor/rollup.md)
        |
        v
      verify    (verify/verdict.json)
        |
   satisfied? --yes--> done
        |
        no
        |
        v
   fix round rNNN+1 ----> back to the HUMAN GATE
```

## Concepts

| Concept | Meaning |
|---|---|
| profile | One named agent configuration in `profiles.json`: role, domain, model env var, effort, prompt file. The fleet is data, not code. |
| relay pair | A directory named `<from>__<to>` (e.g. `planner__backend`) holding one brief/report exchange. |
| brief / report / status block | The brief is the pair's inbox: the planner writes it, the executor reads it first. The report is the executor's answer, and it must open with a flat YAML status block (`area`, `status`, `steps_done`, `steps_total`, `plan_ref`). A report whose block does not parse is in-flight, not authoritative. |
| closure | `closure.json` — a deterministic roll-up of every report in a pair dir. No AI involved; pure arithmetic. |
| round | `rounds/rNNN/` — one full pass of the loop. Append-only: nothing in a finished round is rewritten; fixes go in the next round. |
| blocked | A first-class outcome (exit code 3), not a failure. Work is held for operator clearance; the tool surfaces it distinctly and never restyles it as an error. |

## Quickstart (Fedora)

Identical on every machine — zero machine-specific configuration. Replicating to a new box is exactly these commands.

```bash
sudo dnf install -y nodejs git         # Node >= 22 required; check: node --version
git clone git@github.com:CodeStrux/relay-mesh.git
cd relay-mesh
npm ci
cp .env.example .env
```

Seed the API key from 1Password (the CLI integration is documented, not implemented — the tool only ever reads `.env`):

```bash
sed -i "s|^OPENROUTER_API_KEY=$|OPENROUTER_API_KEY=$(op read -n 'op://<vault>/<item>/api-key')|" .env
```

Then check the installation and run:

```bash
npx relay-mesh doctor
npx relay-mesh run "your goal" --attach board.png
```

## Command reference

Exit codes are uniform across commands: `0` success / terminal-good · `1` error or misuse (including approval-hash mismatch) · `2` awaiting a human (gate pending, or partial work remains) · `3` blocked outcomes present.

| Command | Arguments | Reads | Writes | Notes |
|---|---|---|---|---|
| `doctor` | `[--models]` | `.env`, `profiles.json`, `prompts/`, relay root | nothing | Env/key/prompt/root checks; `--models` validates model slugs live against OpenRouter `/models` with fuzzy suggestions. Run first, always. |
| `plan` | `"<goal>" [--attach file…] [--project path]` | goal, attachments, project files (read-only) | `goal.md`, `inputs/`, recon pair dirs, `rounds/rNNN/plan.md` | Deterministic recon briefs (no LLM before recon); 4-way parallel recon — the vision profile receives attachments as image/video parts; one planner synthesis call. |
| `approve` | `[--round rNNN] [--reject "notes"]` | `plan.md` | `plan.approval.json`, exec briefs | Interactive gate; requires typing `approve`. Pins `sha256(plan.md)`. Briefs are extracted deterministically from the approved plan. |
| `execute` | `[--area a…]` | approval, briefs, plan hash | `<area>.report.md`, `workspace/<area>/`, `monitor/events.ndjson`, `monitor/rollup.md`, `closure.json` | Refuses on plan-hash mismatch (exit 1). Parallel executors; deterministic monitor poller; one monitor roll-up LLM call at phase end. Idempotent per pair; `--area` is the multi-machine split seam. |
| `verify` | `[--round rNNN]` | goal, plan, reports, rollup | `verify/verdict.json`, `verify/verdict.md`; next round's fix plan if unsatisfied | Strict-JSON verdict with one repair re-prompt. Unsatisfied and below `MAX_FIX_ROUNDS` → scaffolds the next round → back to the gate. |
| `run` | `"<goal>" [--attach file…] [--project path]` | everything above | everything above | Chains all phases with gates. A bare re-run resumes from the on-disk state. |
| `status` | `[--json]` | relay root | nothing | Derived phase + per-pair table. Exit code mirrors the phase (2 awaiting human, 3 blocked). |
| `watch` | `[--interval ms]` | relay root | nothing | Read-only live fleet table; safe to run on any machine sharing the root. |
| `close` | `<pair-dir>` | `*.report.md` in the pair dir | `closure.json` | Standalone deterministic roll-up, byte-faithful to the relay-to-sibling skill's `relay-close.sh`. |
| `costs` | `[--by profile\|round\|model]` | `usage.ndjson` | nothing | Token/call aggregation. |

## The approval gate

Nothing executes without you. `approve` displays the plan and requires you to type `approve`; it then writes `plan.approval.json` containing `sha256(plan.md)`. `execute` re-hashes `plan.md` and refuses on any mismatch (exit 1: "plan edited after approval — re-approve"). The domain briefs handed to executors are extracted deterministically from the approved plan's `## Domain brief: <area>` sections, verbatim, with a fixed protocol preamble — no LLM runs between your approval and execution.

Want to change the plan? Edit `rounds/rNNN/plan.md` directly, then run `approve` again. The new hash is pinned; the old approval is void.

## Operator walkthrough

```
$ npx relay-mesh plan "Add magic-link login to the storefront" --project ../storefront
  recon: 4 profiles running (backend, frontend, business, vision)
  synthesis: plan written -> relay/rounds/r001/plan.md
  awaiting approval

$ less relay/rounds/r001/plan.md      # read it; edit it if you like
$ npx relay-mesh approve
  round r001 — type `approve` to proceed: approve
  approved. briefs extracted: backend, frontend, infra
```

In a second terminal, watch the fleet while it executes:

```
$ npx relay-mesh watch
  r001 executing
  planner__backend    partial   3/5
  planner__frontend   complete  4/4
  planner__infra      blocked   1/3
```

Back in the first terminal:

```
$ npx relay-mesh execute
  exec done. blocked areas: infra          (exit 3 — read the report, clear it, re-run)
$ npx relay-mesh verify
  satisfied: true                          (exit 0)
```

## Editing the fleet

The fleet is `profiles.json` — user-edited, zod-validated at load. One entry per agent:

```json
{ "name": "exec-backend", "role": "executor", "domain": "backend", "area": "backend",
  "modelEnv": "BACKEND_MODEL", "effort": "xhigh", "prompt": "prompts/executor-backend.md" }
```

Fields: `name`, `role` (`planner` | `recon` | `executor` | `monitor` | `verifier`), `domain`, optional `area`, `modelEnv` (the env var holding the model ID — model IDs live only in env), `effort` (`low` | `medium` | `high` | `xhigh`), `prompt` (path to the prompt file), optional `multimodal` and `maxOutputTokens`. Validation enforces unique names, exactly one planner/monitor/verifier, and unique executor areas.

The stock fleet is ten profiles: `planner` · `recon-backend` / `recon-frontend` / `recon-business` / `recon-vision` (multimodal) · `exec-backend` / `exec-frontend` / `exec-infra` · `monitor` · `verifier`. The model behind each comes from `.env`:

| Env var | Default | Used by |
|---|---|---|
| `PLANNER_MODEL` | `z-ai/glm-5.2` | planner, recon-business, verifier |
| `RECON_CODE_MODEL` | `deepseek/deepseek-v4-pro` | recon-backend, recon-frontend |
| `VISION_MODEL` | `google/gemma-4-26b-a4b-it` | recon-vision |
| `BACKEND_MODEL` | `z-ai/glm-5.2` | exec-backend |
| `FRONTEND_MODEL` | `moonshotai/kimi-k2.7-code` | exec-frontend |
| `INFRA_MODEL` | `z-ai/glm-5.2` | exec-infra |
| `MONITOR_MODEL` | `google/gemma-4-31b-it` | monitor |

Adding a domain (say, `mobile`) is three edits and zero code: a profile entry in `profiles.json`, a prompt file in `prompts/`, and a model env var in `.env`.

## Cost control

Every LLM call appends one line to `usage.ndjson` at the relay root — `{"ts":…,"round":"r001","profile":"exec-backend","model":"…","in":1234,"out":5678}`. Aggregate it any time:

```bash
npx relay-mesh costs --by profile     # or --by round, --by model
```

`MAX_FIX_ROUNDS` (default 3) bounds the verify/fix loop, so a stubborn goal cannot spend indefinitely. Each fix round still passes through the human gate.

## The relay protocol

The normative on-disk contract is [docs/protocol.md](docs/protocol.md) — code conforms to it, not the other way around. Condensed:

- Everything lives under `RELAY_ROOT`: `goal.md`, `inputs/`, `usage.ndjson`, and `rounds/rNNN/` containing recon pairs, `plan.md` + `plan.approval.json`, exec pairs, `workspace/`, `monitor/`, `verify/`, and dot-prefixed transcripts.
- Every report opens with a flat YAML status block; `status` is `complete`, `partial`, or `blocked`.
- `closure.json` is deterministic arithmetic over the reports: per-brief `pct = floor(steps_done * 100 / steps_total)`, totals from the sums, plus the list of blocked areas.
- The phase machine (`idle` → `recon` → `synthesis` → `awaiting-approval` → `executing` → `rollup` → `verifying` → `done` / `fix-planning`) is derived purely from the filesystem, so every command starts from truth.

Pair directories are byte-compatible with the `relay-to-sibling` Claude Code skill's convention: that skill's `relay-close.sh` produces the same `closure.json` this tool does, so mixed fleets (this orchestrator on one side, a Claude Code session on the other) roll up identically.

## Multi-machine roots

A relay root can be shared across machines (syncthing, NFS) because the protocol never needs locks:

| File | Sole writer |
|---|---|
| `goal.md`, `inputs/` | the `plan` command |
| `<area>.brief.md` | the approving CLI |
| `<area>.report.md` | the one executor for that area |
| `closure.json` | the roll-up step |
| `monitor/events.ndjson` | the monitoring host |
| `plan.approval.json` | the approving human's CLI |

Every write goes to `<name>.part` in the same directory, then an atomic rename — a visible file is always complete, and readers ignore `*.part` and dot-prefixed entries. To split execution across machines, run `execute --area backend` on one host and `execute --area frontend --area infra` on another; each pair has exactly one writer, so the split is safe by construction.

## What executors produce

Executors never touch a live repository. Each one emits complete proposed files in a fenced wire format, which land quarantined under `rounds/rNNN/workspace/<area>/files/` (path traversal is rejected; writes are confined to the area dir). You adopt the work deliberately:

```bash
git diff --no-index ../storefront/src relay/rounds/r001/workspace/backend/files/src
```

Malformed executor output gets one corrective re-prompt; if it is still malformed, the verbatim text is preserved at `workspace/<area>/raw.md` and a `status: partial` report is synthesized — tokens are never lost, and parsing never crashes a phase. An `apply` command that merges workspaces into a repo is explicitly v2.

## Troubleshooting

- **Start with `npx relay-mesh doctor`.** It checks the env, the key, the prompt files, and the relay root, and (with `--models`) validates every model slug live with suggestions for near-misses.
- **`blocked` is not a failure.** Exit code 3 means an agent held work for your clearance. Read the area's report, resolve the blocker, and re-run `execute` — only pairs without a parseable report re-launch.
- **Resume is just re-running.** There is no daemon and no hidden state; every command derives everything from disk. A killed `execute` re-run picks up exactly the pairs that never finished.
- **Errors are three lines**: what broke, what the tool believes, what to do next. Set `RELAY_DEBUG=1` for stack traces.
- **"plan edited after approval — re-approve"**: `plan.md` changed since its hash was pinned. Re-read it, run `approve` again.

## License

MIT — see [LICENSE](LICENSE).
