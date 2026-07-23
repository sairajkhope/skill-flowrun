---
name: flowrun
description: >
  Run, search, and maintain deterministic browser workflows with the flowrun CLI
  (Playwright, no LLM in the hot path). Use when the user wants repetitive web UI
  automation, a saved click-path, train/improve workflows, or to avoid burning
  tokens on Playwright MCP for known tasks.
---

# flowrun

Deterministic web workflows for coding agents. Prefer **flowrun** over exploratory Playwright when a library workflow exists.

## Canonical refs (always use these)

```text
web/<site_id>/<workflow_id>
web/<site_id>/<workflow_id>@1.2.0
```

Examples: `web/example/open-homepage`, `web/github/create-pr`

- Never invent paths from titles alone.
- `flowrun search` returns `id` — pass that to `run`.
- Local library shadows seed on the same id.

## Setup

From the `workflow-skills` repo (or set `FLOWRUN_ROOT`):

```bash
cd packages/flowrun && npm install && npx playwright install chromium && npm run build
export PATH="$PWD/node_modules/.bin:$PATH"   # or: node dist/cli.js
# optional: FLOWRUN_ROOT=/path/to/workflow-skills
```

## Commands

```bash
flowrun search [query]                 # JSON list of workflows
flowrun info <ref>                     # metadata, params, vault needs
flowrun validate [ref|path]            # shape check
flowrun run <ref> [--param k=v] [--headed] [--dry-run]
flowrun train <site_id> <workflow_id> [--url <start>] [--headed]
flowrun improve <ref> [--headed] [--apply]
flowrun verify <ref> [--count N] [--headed] [--screenshot-compare] [--screenshot-threshold N]
flowrun promote <ref> [--to-version X.Y.Z] [--force]
flowrun root                           # resolved library paths
```

### Run rules

1. `flowrun search "<task>"` → pick best `id`
2. `flowrun info <id>` → check `params` and `requires_vault`
3. `flowrun run <id> --param ...`
4. Exit codes: `0` ok, `2` not found/invalid, `3` run failed
5. On failure, read JSON `steps[]` + `error`. Screenshot may be under `traces/`.

### Params

```bash
flowrun run web/example/open-homepage --dry-run
flowrun run web/example/open-homepage --headed
```

Placeholders in YAML: `{{param_name}}`.

### Vault (secrets)

- Workflows use `value_from: vault:slot.name` — **never** put secrets in YAML.
- v0.1: set `FLOWRUN_VAULT=/path/to/vault.yaml` (local map of slot → value).
- **Do not** print vault values into chat or logs. Only mention missing slot *names*.
- If `missing_vault` is in the run result, ask the user to fill the vault; do not request that they paste passwords into the model context if avoidable.

## Closed loop (Hermes-style)

```text
train (human) → library YAML → run (no LLM)
                      ↑ fail
                 improve (repair via Playwright MCP → patch YAML → re-run)
```

### When a run fails

1. Do **not** only fix once in the browser chat and move on.
2. Use Playwright MCP (or headed debug) to find the working selector/path.
3. Patch `library/local/.../workflow.yaml` (prefer local overlay).
4. Append a line under `pitfalls:`.
5. Bump patch version (`1.0.0` → `1.0.1`).
6. `flowrun run <ref>` until green.
7. Summarize the patch to the user.

Use `flowrun improve` to debug failures in headed mode. Use `--apply` for interactive selector patching.

### Verify

Run a workflow N times (default 3) to check stability:

```bash
flowrun verify web/example/open-homepage
flowrun verify web/example/open-homepage --count 5 --headed
flowrun verify web/example/open-homepage --screenshot-compare
```

- Returns `all_ok`, `flaky`, per-run `duration_ms`, and per-step detail.
- With `--screenshot-compare`, takes a screenshot each run and reports pixel-diff deltas between consecutive runs (`pixelmatch` + `pngjs`).
- `--screenshot-threshold` sets max allowed changed pixels (default 50).
- On success (all passed or not flaky), stamps `meta.verified` into the workflow YAML.

### Promote

Graduate a local workflow to seed after verification:

```bash
flowrun promote web/example/my-flow               # requires meta.verified
flowrun promote web/example/my-flow --force        # skip verification gate
flowrun promote web/example/my-flow --to-version 2.0.0
```

- Copies `library/local/...` → `library/seed/...`
- Bumps minor version by default (`0.2.1` → `0.3.0`)
- Strips debug-flagged pitfalls (lines containing "debug", "wip", "draft", "temp", "hack")
- Prints git commands (add seed, rm local, commit)
- Only promotes from local layer (not seed → seed)
- Error with hint if workflow hasn't been verified (unless `--force`)

### When the user teaches a new flow

1. `flowrun train <site_id> <workflow_id> --url <start-url> --headed`
2. Or record steps manually into `library/local/web/<site_id>/<workflow_id>/workflow.yaml`
3. Add/update `sites/<site_id>.yaml` with `origins`.
4. `flowrun validate` + `flowrun run`.

## Writing workflows

Required fields: `id`, `version`, `site_id`, `origins`, `steps`.

Locator preference: `testid` > `role`+`name` > `placeholder` > `text` > `css`.

Origin guard: navigate URL and current page must match `origins`.

## When NOT to use flowrun

- One-off exploration / unknown UI → Playwright MCP or browser tools
- Non-web desktop → out of scope until xa11y backend
- Tasks that are pure API/MCP already → call the API

## Library layout

```text
library/seed/web/<site_id>/<workflow_id>/workflow.yaml
library/local/web/<site_id>/<workflow_id>/workflow.yaml
sites/<site_id>.yaml
```

See `wiki.md` in the flowrun project root for full design.
