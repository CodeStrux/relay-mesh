# Reference Cheatsheet

Back to [[Relay Mesh Reference]].

Dense lookup tables. For the narrative, see [[The Command Loop]], [[The Two Gates]], and [[Steering Models Across Phases]].

## Exit codes

| Code | Meaning | Move |
|---|---|---|
| 0 | success or terminal-good | proceed |
| 1 | error or misuse, including an approval hash mismatch or a roster lint block | read the three-line error |
| 2 | awaiting a human, gate pending or partial | surface it, do not force |
| 3 | blocked outcomes present | first-class, not a failure. Clear the report, re-run `execute`. |

## Model slots (.env)

Model ids live only in `.env`, referenced by slot name. Defaults below are the stock open-weight examples. See [[Steering Models Across Phases]] for how to point these at Claude models.

| Env var | Default | Used by |
|---|---|---|
| `PLANNER_MODEL` | `z-ai/glm-5.2` | planner, recon-business, verifier |
| `RECON_CODE_MODEL` | `deepseek/deepseek-v4-pro` | recon-backend, recon-frontend |
| `VISION_MODEL` | `google/gemma-4-26b-a4b-it` | recon-vision |
| `BACKEND_MODEL` | `z-ai/glm-5.2` | exec-backend |
| `FRONTEND_MODEL` | `moonshotai/kimi-k2.7-code` | exec-frontend |
| `INFRA_MODEL` | `z-ai/glm-5.2` | exec-infra |
| `MONITOR_MODEL` | `google/gemma-4-31b-it` | monitor |

Other tuning keys in `.env`: `RELAY_ROOT` (default `./relay`), `MONITOR_POLL_MS` (default 15000), `MAX_FIX_ROUNDS` (default 3), `RELAY_EXEC_FILE_BYTES` (default 65536), `RELAY_EXEC_BUNDLE_BYTES` (default 196608), `RELAY_DEBUG=1` for stack traces. The OpenRouter key is `OPENROUTER_API_KEY`, seeded from 1Password, never committed and never in argv.

## Stock profiles (profiles.json)

The stock fleet is ten profiles. Recon domains are fixed here before `plan`. The roster decides the execute fleet later. See [[Core Concepts]].

| name | role | domain | modelEnv | effort |
|---|---|---|---|---|
| `planner` | planner | orchestration and synthesis | `PLANNER_MODEL` | xhigh |
| `recon-backend` | recon | backend + infra recon | `RECON_CODE_MODEL` | high |
| `recon-frontend` | recon | frontend + UI recon | `RECON_CODE_MODEL` | high |
| `recon-business` | recon | business model mapping | `PLANNER_MODEL` | high |
| `recon-vision` | recon | diagrams, boards, screenshots, video | `VISION_MODEL` | medium |
| `exec-backend` | executor | backend | `BACKEND_MODEL` | xhigh |
| `exec-frontend` | executor | frontend | `FRONTEND_MODEL` | medium |
| `exec-infra` | executor | infra | `INFRA_MODEL` | high |
| `monitor` | monitor | relay observation and roll-up | `MONITOR_MODEL` | low |
| `verifier` | verifier | goal vs outcome verification | `PLANNER_MODEL` | xhigh |

Effort is one of `low`, `medium`, `high`, `xhigh`. Adding a domain is three edits and zero code: a profile entry in `profiles.json`, a prompt file in `prompts/`, and a model env var in `.env`.

## Roster schema and the seven lint hard-blocks

The roster names slots, never ids. A minimal `roster.json`:

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

`roster` hard-blocks on any of these:

1. unknown template (not a profile)
2. missing brief for a domain
3. reserved domain name (matches `w<digits>`, the shard suffix)
4. duplicate domain
5. inline model id (`modelEnv` contains a slash, a slug not a slot)
6. unknown slot (`modelEnv` not in the allowlist)
7. unresolvable slot (a known slot that resolves to nothing in `.env`)

A `count` above 1 shards the domain into one pair per worker (`planner__<area>__w<i>`).

## Cost analysis

Every LLM call appends one line to `usage.ndjson` at the relay root. Aggregate any time:

```bash
npx relay-mesh costs --by domain      # or profile, round, model, stage
npx relay-mesh costs --by domain --round r001
```

`--by domain` folds shards and minted workers into their domain. `--by model` catches a slot pointed at a pricey slug.

## Multi-machine single-writer table

A relay root can be shared with no locks because each file has exactly one writer.

| File | Sole writer |
|---|---|
| `goal.md`, `inputs/` | the `plan` command |
| `<area>.brief.md` | the roster-approving CLI (gate 2) |
| `<area>.report.md` | the one executor for that pair |
| `closure.json` | the roll-up step |
| `monitor/events.ndjson` | the monitoring host |
| `plan.approval.json`, `roster.approval.json` | the approving human's CLI |
| `usage/<stage>.json` | the host that completes that stage |
| `project.json` | the `plan` command |

To split execution: `execute --area backend` on one host, `execute --area frontend --area infra` on another.

## Remote runner notes

A run deploys to any box as `git clone + npm ci + npm run build + .env`, conventionally at `~/relay-mesh`. Two things bite:

- nvm is interactive-only. A non-interactive ssh session needs `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"` before any `node` or `npm`.
- Long phases like `execute` should run detached on the remote (`nohup ... &` or tmux), then poll with `relay-mesh status` or `watch` from a second connection.
