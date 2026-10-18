# flowrun (skill-flowrun)

Deterministic web workflows for coding agents — **train / run / improve / verify / promote**.

| Piece | Path |
|---|---|
| Design wiki | [`wiki.md`](./wiki.md) |
| CLI | [`packages/flowrun`](./packages/flowrun) |
| Agent skill | [`packages/skill-flowrun`](./packages/skill-flowrun) |
| Seed library | [`library/seed`](./library/seed) |
| Schemas | [`schemas`](./schemas) |

Born under reatlas; this is the standalone repo.

## Quick start

```bash
cd packages/flowrun
npm install
npx playwright install chromium
npm run build

# auto-detects library root (repo with library/ + sites/)
node dist/cli.js search
node dist/cli.js info web/example/open-homepage
node dist/cli.js run web/example/open-homepage --dry-run
node dist/cli.js run web/example/open-homepage
```

Or: `./bin/flowrun …` after build.

Refs: `web/<site_id>/<workflow_id>` — e.g. `web/example/open-homepage`

## Commands

```bash
flowrun search [query]
flowrun info <ref>
flowrun validate [ref|path]
flowrun run <ref> [--param k=v] [--headed] [--dry-run]
flowrun train <site_id> <workflow_id> [--url <start>] [--headed]
flowrun improve <ref> [--apply] [--param k=v]
flowrun verify <ref> [--count N] [--screenshot-compare]
flowrun promote <ref> [--to-version X.Y.Z] [--force]
flowrun root
```

Secrets:

```bash
export FLOWRUN_VAULT_PASS='…'   # or: flowrun vault unlock --store-keychain
flowrun vault init
flowrun vault set sites.example.password '…'
```

Dev/CI override: `FLOWRUN_VAULT=./plain-vault.yaml` (never commit).

## Agent install

Copy or symlink `packages/skill-flowrun` into your agent skills dir. Public publish after tests + vault.

## Status

| Area | State |
|---|---|
| run / search / info / validate | done |
| train / improve / verify / promote | done |
| vault encrypt + CLI | done |
| automated tests (vault) | done; broader suite later |
| more seeds (5–10) | later |
| skills.sh / Hermes hub | later |

See [`wiki.md`](./wiki.md) for the full plan.
