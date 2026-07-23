# flowrun — living wiki

Status: **design locked (v0 scope)** — not implemented yet  
Codename: Flow / Flower (brand ok) · **CLI binary: `flowrun`**  
Home (for now): `reatlas/workflow-skills/` → extract to own GitHub repo before public push  

---

## 1. Idea

Coding agents (Hermes, Claude Code, Codex, Cursor, etc.) burn tokens on repetitive browser UI via Playwright/MCP/CUA.

**flowrun** is a stepping stone:

1. **Deterministic workflows** (YAML) executed without an LLM in the hot path  
2. **Agent Skill** that teaches any agent to search → run → train → improve  
3. **Local library** of site workflows that grows via human train + failure repair  
4. Same refs later load inside the reatlas browser (Phase A shell → agent skills)

Not a full CUA. Not a cloud registry on day one. A **runner + format + skill + local library** with a Hermes-style closed learning loop.

---

## 2. Locked design choices

| Decision | Choice | Why |
|---|---|---|
| v0 ship | Base skill + local runner + seed workflows | Fast; extractable; no registry yet |
| Backend v0 | Playwright web only | Matches existing agent tooling |
| Desktop | Later (`backend: xa11y`) | Same YAML shape |
| Language | TypeScript / Node | `npx`-friendly, Playwright-native |
| CLI name | **`flowrun`** | `flow` = Facebook Flow; `flower` = Celery Flower |
| Package layout | Subdir under reatlas now | Move out before GitHub |
| Docs | This `wiki.md` | Idea, choices, plan, devlog |
| Community library | After format proven | Same YAML, separate repo later |

### Addressing (agent + CLI — same string)

```text
web/<site_id>/<workflow_id>
web/<site_id>/<workflow_id>@1.2.0
```

Examples:

```text
web/makemytrip/book-ticket
web/github/create-pr
web/amazon/buy-cart-items
```

- **`site_id`**: stable product key (`makemytrip`, `github`) — not raw domain as primary  
- **`origins[]`**: allowed hosts (required for open + security checks)  
- **`workflow_id`**: kebab-case task (`book-ticket`, `buy-cart-items`)  
- **Local shadows seed** on same id (Hermes-style)

Human titles/aliases are search sugar only. Agents always pass the **ref** to the CLI.

### Modes (closed loop)

```text
        train (human shows once)
              │
              ▼
         library YAML  <── improve (fail → repair → patch + verify)
              │
           run (no LLM)
              │
           success
```

| Mode | Driver | LLM? | Writes |
|---|---|---|---|
| `run` | runner | no | stats only |
| `train` | human (headed browser) | optional naming | new YAML under `library/local/` |
| `improve` | agent after fail | yes for repair | patch YAML + pitfalls + version bump |
| `verify` | runner | no | must pass after improve |
| `promote` | human | no | local → seed |

Self-improve mirrors **Hermes `skill_manage`**: prefer surgical **patch** after a verified repair; append pitfalls; never “fix only in chat.”

### Vault (local secrets / autofill)

- Workflows reference **slots**, never secret values: `value_from: vault:sites.github.password`  
- Vault is **device-local**, encrypted (OS keychain preferred; passphrase file fallback)  
- **LLM never sees vault values** — only slot names / missing-slot lists  
- Runner injects into the browser at fill time only  
- v0 vault: identity + credentials + custom notes — **not** full payment PCI surface  
- Train/improve traces redact password fields  

### Security (v0)

- Refuse run if page origin ∉ workflow `origins`  
- No cookies/passwords in YAML or git  
- `library/local/`, vault, `traces/` gitignored  
- Optional `--apply` confirm on improve writes  

---

## 3. Layout (target)

```text
workflow-skills/
  wiki.md                          # this file
  README.md
  packages/
    flowrun/                       # CLI + runner (TS)
    skill-flowrun/                 # Agent Skill (SKILL.md)
  schemas/
    workflow.schema.json
    site.schema.json
  library/
    seed/web/<site_id>/<workflow_id>/workflow.yaml
    local/…                        # agent/human writable (gitignored content ok)
  sites/
    <site_id>.yaml                 # site_id, name, origins, aliases
  traces/                          # gitignored
```

---

## 4. Workflow YAML (sketch)

```yaml
id: web/github/create-pr
version: 1.0.0
title: Create GitHub pull request
site_id: github
origins:
  - https://github.com
  - https://www.github.com
tags: [github, git]
params:
  title: { type: string, required: true }
  body: { type: string, required: false }
requires_vault:
  - sites.github.password   # or session already logged in
steps:
  - navigate: { url: "https://github.com/{{owner}}/{{repo}}/compare" }
  - fill:
      role: textbox
      name: "Title"
      value: "{{title}}"
  - click:
      role: button
      name: "Create pull request"
  - wait:
      url_includes: "/pull/"
      timeout_ms: 15000
pitfalls:
  - "Compare page 404 if branch missing — verify branch exists first"
```

Site file `sites/github.yaml`:

```yaml
site_id: github
name: GitHub
aliases: [gh]
origins:
  - https://github.com
  - https://www.github.com
```

---

## 5. CLI surface (v0)

```bash
npx flowrun search "github pr"
npx flowrun info web/github/create-pr
npx flowrun run web/github/create-pr --param title="Fix n+1"
npx flowrun train "create a PR on github" --site github
npx flowrun improve web/github/create-pr --from-trace traces/....json
npx flowrun verify web/github/create-pr
npx flowrun promote web/github/create-pr

npx flowrun vault init | unlock | set | needs
```

Agent skill instructs: always use **ref** with `flowrun run`; on failure follow improve loop; on new repetitive task offer train.

---

## 6. Execution plan

### Phase 0 — docs + skeleton (now)
- [x] Design locked in this wiki  
- [x] README + package stubs  
- [x] JSON schemas  
- [x] One seed workflow (dry / mockable)  
- [x] skill-flowrun `SKILL.md` draft  

### Phase 1 — runner MVP
- [x] `flowrun run` Playwright executor  
- [x] Param interpolation  
- [x] Origin guard  
- [x] Structured JSON result (pass/fail/step/error)  
- [x] `search` / `info` / `validate` / `--dry-run`  

### Phase 2 — library UX
- [x] `search` / `info`  
- [x] local vs seed resolution  
- [x] version pin `@x.y.z` (resolve path ready)  

### Phase 3 — train
- [ ] Headed record → YAML proposal  
- [ ] Locator preference: role/name > testid > text > css  
- [ ] Password field redaction  

### Phase 4 — improve (Hermes loop)
- [ ] Failure trace format  
- [ ] Patch apply + verify gate  
- [ ] Pitfalls append + semver bump  
- [ ] Skill text: mandatory improve-after-repair  

### Phase 5 — vault
- [ ] Encrypted local store + session unlock  
- [ ] `value_from: vault:…` injection (no LLM exfil path)  
- [ ] `requires_vault` / `vault needs`  

### Phase 6 — extract + share
- [ ] Move to standalone repo  
- [ ] Publish skill to skills.sh / Hermes hub path  
- [ ] Seed 5–10 real workflows  
- [ ] Later: community index (browse/download)  

### Phase 7 — reatlas browser
- [ ] Same refs inside browser agent runtime  
- [ ] Spaces ship default skills  

---

## 7. Non-goals (v0)

- Screenshot CUA as primary driver  
- Cloud sync of vault  
- Payment card vault / PCI  
- Desktop/xa11y execution  
- Public ratings marketplace  
- Replacing Playwright MCP for exploratory tasks  

---

## 8. Open questions (parked)

1. Exact npm scope name (`@reatlas/flowrun` vs unscoped) — decide at extract  
2. Train: pure Playwright codegen hooks vs custom listener  
3. Improve: always require human `--apply` vs auto in trusted local profile  
4. Multi-account vault profiles (`work` / `personal`) — needed before browser spaces  

---

## 9. Devlog

### 2026-07-23
- Context restored from reatlas RE + Phase A browser scaffold work  
- Explored CUAs (OpenAI/Anthropic) vs structured/a11y + compiled workflows  
- Decided stepping-stone: agent skill + runner usable by Hermes/CC/Codex now  
- v0 = Playwright web, TypeScript, subdir under reatlas, living wiki  
- Self-improve loop inspired by Hermes `skill_manage` (create/patch after verified repair)  
- Train mode: human-observed event record → YAML  
- Addressing: `web/<site_id>/<workflow_id>` + origins metadata (not domain-as-primary-id)  
- Vault: local encrypted slots; schema refs only; LLM never sees secrets  
- CLI name: **`flowrun`** (rejected bare `flow`, declined `flower` as primary binary)  
- **Scaffolded + Phase 1 MVP shipped under `workflow-skills/`**  
  - `packages/flowrun` — search/info/validate/run (Playwright)  
  - `packages/skill-flowrun/SKILL.md` — agent instructions  
  - seed: `web/example/open-homepage` (live run OK ~700ms)  
  - schemas + sites/example.yaml  
### 2026-07-23 (later)
- **Phase 2 complete: train + improve + more seeds + wrapper**
  - `bin/flowrun` wrapper script for direct invocation (no `node` prefix)
  - `sites/github.yaml`, `sites/npm.yaml` — new site definitions
  - `web/github/search-repos` — GitHub repo search workflow (dry-run OK)
  - `web/npm/search-packages` — npm package search workflow (dry-run OK)
  - `web/example/full-page-check` — enhanced example with `screenshot` + `assert`
  - `src/train.ts` — headed recorder: injects listener script, captures click/fill/navigate, deduplicates, outputs YAML to `library/local/`
  - `src/improve.ts` — headed debug runner: stops on failure, allows inspection, `--apply` flag for interactive selector patching
  - `src/cli.ts` — `train` and `improve` subcommands wired
  - `SKILL.md` updated with train/improve docs
### 2026-07-23 (phase 3)
- **Phase 3 complete: verify + promote**
  - `meta` field on Workflow, `WorkflowMeta`, `VerifyResult`, `PromoteOptions` types
  - `pixelmatch@^7.2.0` + `pngjs@^7.0.0` added
  - `src/verify.ts` — `verifyWorkflow()` runs N times (default 3), optional screenshot comparison via pixelmatch, stamps `meta.verified`
  - `src/promote.ts` — `promoteWorkflow()` copies local→seed, bumps minor, strips debug pitfalls, prints git hints
  - `src/cli.ts` — `verify` and `promote` subcommands wired with `--count`, `--headed`, `--screenshot-compare`, `--screenshot-threshold`, `--to-version`, `--force`
  - `SKILL.md` updated with verify/promote docs
  - Builds clean; all commands tested
- Next: real vault encrypt, more seed workflows, UI dashboard

---

## 10. References

- Hermes skills / skill_manage: https://hermes-agent.nousresearch.com/docs/user-guide/features/skills  
- Agent Skills standard: https://agentskills.io  
- Playwright: https://playwright.dev  
- xa11y (later desktop): https://xa11y.dev  
- reatlas strategy: `../memory/2026-07-22-office-hours-open-browser-strategy.md`  
