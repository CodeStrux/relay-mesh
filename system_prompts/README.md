# system_prompts — copy-paste personas for OpenRouter

Self-contained, copy-pasteable versions of every relay-mesh profile agent, one file per role,
lightly tuned toward the model that runs it. Use these to drive a single agent by hand in the
[OpenRouter](https://openrouter.ai) playground — pick the model, paste the prompt, feed it one
agent's inputs, and read what comes back.

These are **flattened mirrors** of the wired prompts in [`../prompts/`](../prompts): the shared
partials (`_relay-protocol.md`, `_codestrux-rules.md`, `_design-language.md`) are inlined and the
`{{> include}}` / `{{VAR}}` template machinery the mesh expands at call time is spelled out, because
the OpenRouter playground does not expand any of it. The machine contract each agent must obey
(status block, wire format, report paths, output headings, verdict schema) is preserved byte for
byte; only the surrounding framing is tuned per model class.

## How to use one in OpenRouter

1. Open the file for the role you want to drive (e.g. `planner.md`).
2. In OpenRouter, select that role's model — the slot default is listed below and in the file header.
3. Copy everything **below the divider line** into the system-prompt box.
4. Replace the `{{TOKENS}}` using the legend at the top of the file (`{{GOAL}}`, `{{ROUND}}`,
   and where present `{{AREA}}` / `{{REPORT_PATH}}` — the last two have fixed values per role).
5. Put that agent's actual inputs in the **user** message — the goal plus whatever it consumes
   (recon reports for the planner, the domain brief + source files for an executor, the reports +
   verdict for the verifier, and so on). For `recon-vision`, attach the images/video to the message.

Pasting the whole file works too: the header sits in an HTML comment and is harmless.

## Model → role map

Defaults from [`../.env.example`](../.env.example); roles, areas, and effort from
[`../profiles.json`](../profiles.json). Model IDs live only in env — swap them freely; the personas
are model-agnostic, and these copies are merely tuned toward each default's strengths.

| Env slot | Default model | Class | Role → file (effort) |
|---|---|---|---|
| `PLANNER_MODEL` | `z-ai/glm-5.2` | Opus 4.8-class — deep synthesis & verdict | planner → [`planner.md`](planner.md) (xhigh) · recon-business → [`recon-business.md`](recon-business.md) (high) · verifier → [`verifier.md`](verifier.md) (xhigh) |
| `RECON_CODE_MODEL` | `deepseek/deepseek-v4-pro` | Sonnet 5-class — fast code recon | recon-backend → [`recon-backend.md`](recon-backend.md) (high) · recon-frontend → [`recon-frontend.md`](recon-frontend.md) (high) |
| `VISION_MODEL` | `google/gemma-4-26b-a4b-it` | multimodal — reads your attachments | recon-vision → [`recon-vision.md`](recon-vision.md) (medium) |
| `BACKEND_MODEL` | `z-ai/glm-5.2` | Sonnet 5-class — balanced coder | exec-backend → [`exec-backend.md`](exec-backend.md) (xhigh) |
| `FRONTEND_MODEL` | `moonshotai/kimi-k2.7-code` | Sonnet 5-class — balanced coder | exec-frontend → [`exec-frontend.md`](exec-frontend.md) (medium) |
| `INFRA_MODEL` | `z-ai/glm-5.2` | Sonnet 5-class — balanced coder | exec-infra → [`exec-infra.md`](exec-infra.md) (high) |
| `MONITOR_MODEL` | `google/gemma-4-31b-it` | Haiku 4.5-class — cheap, fast polling | monitor → [`monitor.md`](monitor.md) (low) |

`PLANNER_MODEL` powers three different roles: a model wearing several hats needs a **different file
per role**, not one prompt. Effort is the profile's configured reasoning level (in the wired client
`xhigh` maps to OpenRouter's `reasoning: high`).

## Keeping these in sync

[`../prompts/`](../prompts) is what the running mesh actually sends — treat it as canonical. These
files are a derived, human- and OpenRouter-facing mirror. When a persona changes, **edit
`../prompts/` first**, then re-flatten the change here so the two never drift.
