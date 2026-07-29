# flowrun vault — design (v0)

Status: **approved**  
Date: 2026-07-23  
Approach: thin vault module + CLI (encrypted file; keychain + passphrase)

## Goal

Local encrypted secret store so workflows can use `value_from: vault:slot.name` without putting secrets in YAML, git, logs, or LLM context.

## Non-goals (v0)

See wiki **Roadmap (beyond v0)** for deferred items:

- Multi-profile vaults
- Cloud sync
- PCI / payment cards
- Auto-rotate credentials
- Background unlock daemon

## Storage

```text
$FLOWRUN_ROOT/.flowrun/vault.enc
```

- Override path: `FLOWRUN_VAULT_PATH`
- Directory already gitignored via `.flowrun/`
- File mode `0600` on write

### Encrypted file format

```json
{
  "version": 1,
  "kdf": "scrypt",
  "salt": "<base64>",
  "iv": "<base64>",
  "ciphertext": "<base64>",
  "meta": {
    "created_at": "<iso>",
    "updated_at": "<iso>",
    "slot_count": 0
  }
}
```

- Payload (plaintext before encrypt): JSON object `Record<string, string>` of slot → value
- KDF: Node `scrypt` (sensible N/r/p defaults fixed in code)
- Cipher: AES-256-GCM
- `meta` never contains secret values

## Unlock backends

Resolution order when loading vault for a command:

1. **`FLOWRUN_VAULT`** — plain YAML map path (dev/CI escape hatch; no encrypt)
2. Else encrypted file at default/`FLOWRUN_VAULT_PATH`:
   1. **`FLOWRUN_VAULT_PASS`** env passphrase
   2. **OS keychain** item (service `flowrun`, account derived from vault path)
   3. **Interactive prompt** if TTY; else fail with clear error

Process-only: decrypted map lives in memory for the current CLI process; no unlocked session file on disk.

Optional: `vault unlock --store-keychain` / `vault init --store-keychain` saves passphrase to OS keychain after successful unlock (macOS Keychain via `security`; Linux `secret-tool` when present; Windows skipped/clear message in v0 if unavailable).

## CLI

```bash
flowrun vault init [--passphrase-stdin] [--store-keychain]
flowrun vault unlock [--store-keychain]   # verify credentials work
flowrun vault set <slot> [value]          # prompt if omitted; no echo
flowrun vault get <slot>                  # print value (humans; agents must not)
flowrun vault list                        # slot names only
flowrun vault needs [ref]                 # missing slots for ref or summary
flowrun vault delete <slot>
flowrun vault status                      # path, exists, backend hint, slot_count
```

Exit codes: `0` ok, `1` usage/error, `2` missing vault/slot as appropriate.

## Integration

- Shared `resolveVault(root): Promise<Record<string, string>>` used by `run`, `improve`, `verify`
- Existing `missing_vault` structured error unchanged
- Runner still injects only at fill time; never logs values
- Skill text: agents may use `list` / `needs` / `status` / `set` (user-provided values); **never** `vault get` or print values

## Slot naming

Convention (not enforced): dotted paths e.g. `sites.github.password`, `sites.npm.token`.

## Security rules

| Rule | Behavior |
|---|---|
| No secrets in git | `.flowrun/` gitignored |
| No secrets in workflow YAML | only `vault:` refs |
| No secrets in agent chat | skill forbids `get`; only missing *names* |
| File perms | `0600` on `vault.enc` |
| Wrong passphrase | hard fail; no partial decrypt |

## Tests (with implementation)

- Encrypt/decrypt roundtrip
- Wrong passphrase fails
- set → list → get → delete
- `needs` reports missing vs present for a workflow ref
- CLI smoke with temp `FLOWRUN_ROOT` + `FLOWRUN_VAULT_PASS`
- Plain `FLOWRUN_VAULT` YAML override still works

## Files to add/touch

- `packages/flowrun/src/vault.ts` — core
- `packages/flowrun/src/vault-keychain.ts` — OS helpers
- `packages/flowrun/src/cli.ts` — wire `vault` subcommands + `resolveVault`
- `packages/flowrun/src/improve.ts` — use shared resolve
- `packages/skill-flowrun/SKILL.md` — vault CLI docs
- `wiki.md` / root `README.md` — status
- tests under `packages/flowrun` (test runner as chosen in plan)
