# flowrun (workflow-skills)

Deterministic web workflows for coding agents — **train / run / improve** (Hermes-style loop).

| Piece | Path |
|---|---|
| Design wiki | [`wiki.md`](./wiki.md) |
| CLI | [`packages/flowrun`](./packages/flowrun) |
| Agent skill | [`packages/skill-flowrun`](./packages/skill-flowrun) |
| Seed library | [`library/seed`](./library/seed) |
| Schemas | [`schemas`](./schemas) |

## Quick start

```bash
cd packages/flowrun
npm install
npx playwright install chromium
npm run build

# from packages/flowrun — auto-detects library root
node dist/cli.js search
node dist/cli.js info web/example/open-homepage
node dist/cli.js run web/example/open-homepage --dry-run
node dist/cli.js run web/example/open-homepage
```

Refs look like: `web/<site_id>/<workflow_id>`  
Example: `web/example/open-homepage`

## Agent install (later)

Copy or symlink `packages/skill-flowrun` into your agent skills dir, or publish after extract to a standalone repo.

## Status

- v0.1: `search`, `info`, `validate`, `run` (+ dry-run, headed)
- Planned: `train`, `improve`, `vault`, `promote`
