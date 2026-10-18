# flowrun

Deterministic Playwright workflow runner for coding agents. Workflows are
YAML files executed without an LLM in the hot path.

```
npm install
npx playwright install chromium
npm run build
```

## Demo

<!-- TODO: Insert screen recording (~45s) showing:
     1. flowrun search
     2. flowrun run web/npm/search-packages --param query=playwright --headed
     3. flowrun run web/npm/view-package --param package=playwright --dry-run
     4. flowrun verify web/npm/search-packages
     Caption: "Train once, run anywhere — recording a workflow, running it
     headlessly, then verifying it across multiple runs." -->

## CLI

```text
flowrun search [query]                  list / filter available workflows
flowrun info <ref>                      show workflow metadata
flowrun validate [ref|path]             check workflow shape (all if no arg)
flowrun run <ref> [options]             execute a workflow
flowrun train <site_id> <workflow_id>   record a workflow from a browser session
flowrun improve <ref> [options]         debug a failed run, patch selectors
flowrun verify <ref> [options]          run N times, compare screenshots, stamp meta
flowrun promote <ref> [options]         local -> seed with version bump
flowrun vault init|unlock|set|get|list|delete|needs|status
flowrun root                            show library layout paths
```

Run options: `--param k=v` `--headed` `--dry-run` `--json`

Ref format: `web/<site_id>/<workflow_id>[@version]`

## How it works

**train** opens a headed browser. You perform the steps. Clicks, fills, and
navigations are recorded to `library/local/web/<site>/<workflow>/workflow.yaml`.
Password fields are detected and stored as vault slot references instead of
plaintext values.

```bash
flowrun train npm search-packages --url https://www.npmjs.com/search?q=playwright
```

**run** executes a workflow headlessly. Steps are navigate, click, fill, press,
wait, assert, and screenshot. Parameters interpolate into step values via `{{key}}`.
Vault values are injected at fill time and never logged.

```bash
flowrun run web/npm/search-packages --param query=playwright
```

**improve** replays a failed workflow in headed mode. The browser stays open on
failure so you can inspect the page. With `--apply`, it prompts for replacement
selectors and writes a patch with a version bump.

```bash
flowrun improve web/npm/search-packages --headed --apply
```

**verify** runs a workflow N times (default 3). With `--screenshot-compare`, it
compares screenshots between runs using pixelmatch and reports pixel deltas.
On success, it stamps `meta.verified` into the workflow file.

```bash
flowrun verify web/npm/search-packages --count 5 --screenshot-compare
```

**promote** moves a verified workflow from `library/local/` to `library/seed/`.
Pitfalls containing debug/wip/draft/temp/hack are stripped. A minor version bump
is applied. Git commands for committing the seed are printed.

```bash
flowrun promote web/npm/search-packages
```

## Workflow format

Workflows are YAML files. Minimal example:

```yaml
id: web/npm/search-packages
version: 1.0.0
title: Search npm packages
description: Open npmjs.com and search for a package.
site_id: npm
origins:
  - https://www.npmjs.com
params:
  query:
    type: string
    required: true
    description: Package name or search term (e.g. playwright)
steps:
  - navigate:
      url: "https://www.npmjs.com/search?q={{query}}"
  - wait:
      url_includes: "/search?q="
      timeout_ms: 20000
  - assert:
      url_includes: "npmjs.com/search"
```

Step types: `navigate`, `click`, `fill`, `press`, `wait`, `assert`, `screenshot`.

Locator fields: `role`, `name`, `testid`, `text`, `placeholder`, `css`.

Parameters are declared in `params` with `type`, `required`, `description`, and
`default`. Required params with no default must be passed on the CLI.

Secrets are referenced as `value_from: vault:<slot>`. The slot name follows the
convention `sites.<site>.<name>`. Vault never appears in the workflow YAML.

## Library layout

```
<root>/
  library/
    local/          # in-development workflows (gitignored)
    seed/           # reviewed, verified workflows (committed)
  sites/
    <site_id>.yaml  # site definitions with origins
  traces/           # failure screenshots (gitignored)
  .flowrun/
    vault.enc       # encrypted secret store (gitignored)
```

`FLOWRUN_ROOT` overrides root auto-detection. Auto-detect looks for
`library/` + `sites/` directories upward from cwd or the package itself.

## Vault

The vault encrypts secrets with scrypt + AES-256-GCM. The encrypted file lives
at `.flowrun/vault.enc` (mode 0600).

```
flowrun vault init
flowrun vault set sites.example.password
flowrun vault list
flowrun vault needs web/npm/search-packages    # check which slots a workflow requires
```

The passphrase comes from `FLOWRUN_VAULT_PASS`, interactive prompt, or OS
keychain (`vault unlock --store-keychain`). For dev/CI, `FLOWRUN_VAULT` can be
set to a plain YAML `{slot: value}` map as an escape hatch.

The runner resolves vault slots at fill time. The LLM never sees vault values,
only slot names from `requires_vault` lists. Train mode redacts password fields
to `value_from: vault:...` entries automatically.

## Environment

| Var | Purpose |
|-----|---------|
| `FLOWRUN_ROOT` | Library root (auto-detected) |
| `FLOWRUN_VAULT_PASS` | Vault passphrase |
| `FLOWRUN_VAULT_PATH` | Custom vault path |
| `FLOWRUN_VAULT` | Plain YAML slot map (dev/CI) |

## Programmatic API

```typescript
import { runWorkflow, resolveRefFlexible } from "flowrun";
import { resolveVault } from "flowrun/vault";

const wf = resolveRefFlexible(root, "web/npm/search-packages");
const result = await runWorkflow(wf, {
  params: { query: "playwright" },
  vault: resolveVault({ root }),
});
```

Exports from `flowrun`: `runWorkflow`, `execStep`, `resolveRefFlexible`,
`loadAllWorkflows`, `searchWorkflows`, `validateWorkflowShape`, `bumpVersion`,
`defaultRoot`, `libraryDirs`, and types (`Workflow`, `WorkflowStep`,
`RunResult`, etc.).

## Development

```bash
npm run build          # tsc
npm run typecheck      # tsc --noEmit
npm test               # vault unit + CLI smoke (tsx --test)
npm run flowrun -- ... # alias for node dist/cli.js
```