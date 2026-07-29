#!/usr/bin/env node
import fs from "node:fs";
import readline from "node:readline/promises";
import { parse as parseYaml } from "yaml";
import {
  loadAllWorkflows,
  resolveRefFlexible,
  searchWorkflows,
  validateWorkflowShape,
} from "./library.js";
import { defaultRoot, libraryDirs } from "./paths.js";
import { runWorkflow } from "./runner.js";
import { trainWorkflow } from "./train.js";
import { improveWorkflow } from "./improve.js";
import { verifyWorkflow, stampVerifiedMeta } from "./verify.js";
import { promoteWorkflow } from "./promote.js";
import * as vault from "./vault.js";
import type { Workflow } from "./types.js";

function printJson(data: unknown) {
  console.log(JSON.stringify(data, null, 2));
}

function usage(): never {
  console.log(`flowrun — deterministic web workflow runner

Usage:
  flowrun search [query]
  flowrun info <ref>
  flowrun validate [ref|path]
  flowrun run <ref> [--param k=v ...] [--headed] [--dry-run] [--json]
  flowrun train <site_id> <workflow_id> [--url <start-url>] [--headed]
  flowrun improve <ref> [--headed] [--apply] [--param k=v ...]
  flowrun verify <ref> [--count N] [--param k=v ...] [--headed] [--screenshot-compare] [--screenshot-threshold 0.05]
  flowrun promote <ref> [--to-version X.Y.Z] [--force]
  flowrun vault init|unlock|set|get|list|delete|needs|status
  flowrun root

Refs: web/<site_id>/<workflow_id>[@version]
Env:  FLOWRUN_ROOT       library root (auto-detect library/ + sites/)
      FLOWRUN_VAULT      plain YAML slot map (dev/CI override)
      FLOWRUN_VAULT_PASS passphrase for encrypted .flowrun/vault.enc
      FLOWRUN_VAULT_PATH custom path to vault.enc
`);
  process.exit(1);
}

async function promptHidden(label: string): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error(`${label}: non-TTY; pass value as arg or use FLOWRUN_VAULT_PASS`);
  }
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  try {
    return (await rl.question(`${label}: `)).trim();
  } finally {
    rl.close();
  }
}

async function readPassphrase(
  flags: Record<string, string | boolean | number>,
): Promise<string> {
  if (process.env.FLOWRUN_VAULT_PASS) return process.env.FLOWRUN_VAULT_PASS;
  if (flags["passphrase-stdin"]) {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString("utf8").trim();
  }
  return promptHidden("Vault passphrase");
}

/** Prefer env/keychain; prompt only if unlock fails. */
async function withVaultPass<T>(
  flags: Record<string, string | boolean | number>,
  fn: (passphrase?: string) => T,
): Promise<T> {
  try {
    return fn(process.env.FLOWRUN_VAULT_PASS);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!/passphrase|locked|required/i.test(msg)) throw e;
    const passphrase = await readPassphrase(flags);
    return fn(passphrase);
  }
}

function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  const cmd = args[0];
  const rest: string[] = [];
  const flags: Record<string, string | boolean | number> = {};
  const params: Record<string, string> = {};

  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === "--headed") flags.headed = true;
    else if (a === "--dry-run") flags.dryRun = true;
    else if (a === "--json") flags.json = true;
    else if (a === "--apply") flags.apply = true;
    else if (a === "--param" || a === "-p") {
      const kv = args[++i];
      if (!kv?.includes("=")) throw new Error(`--param needs k=v, got ${kv}`);
      const eq = kv.indexOf("=");
      params[kv.slice(0, eq)] = kv.slice(eq + 1);
    } else if (a.startsWith("--param=")) {
      const kv = a.slice("--param=".length);
      const eq = kv.indexOf("=");
      params[kv.slice(0, eq)] = kv.slice(eq + 1);
    } else if (a === "--url") {
      flags.url = args[++i];
    } else if (a.startsWith("--url=")) {
      flags.url = a.slice("--url=".length);
    } else if (a.startsWith("--count=")) {
      flags.count = Number(a.slice("--count=".length));
      if (isNaN(flags.count)) throw new Error(`Invalid --count value: ${a.slice("--count=".length)}`);
    } else if (a === "--count") {
      flags.count = Number(args[++i]);
      if (isNaN(flags.count)) throw new Error(`Invalid --count value: ${args[i]}`);
    } else if (a.startsWith("--screenshot-threshold=")) {
      flags.screenshotThreshold = Number(a.slice("--screenshot-threshold=".length));
      if (isNaN(flags.screenshotThreshold)) throw new Error(`Invalid --screenshot-threshold value`);
    } else if (a === "--screenshot-threshold") {
      flags.screenshotThreshold = Number(args[++i]);
      if (isNaN(flags.screenshotThreshold)) throw new Error(`Invalid --screenshot-threshold value`);
    } else if (a.startsWith("--to-version=")) {
      flags.toVersion = a.slice("--to-version=".length);
    } else if (a === "--to-version") {
      flags.toVersion = args[++i];
    } else if (a.startsWith("--")) {
      flags[a.slice(2)] = true;
    } else {
      rest.push(a);
    }
  }
  return { cmd, rest, flags, params };
}

async function main() {
  const { cmd, rest, flags, params } = parseArgs(process.argv);
  if (!cmd || cmd === "help" || cmd === "-h" || cmd === "--help") usage();

  const root = defaultRoot();

  if (cmd === "root") {
    printJson({ root, ...libraryDirs(root) });
    return;
  }

  if (cmd === "search") {
    const q = rest.join(" ");
    const hits = searchWorkflows(root, q);
    const out = hits.map((h) => ({
      id: h.workflow.id,
      version: h.workflow.version,
      title: h.workflow.title,
      site_id: h.workflow.site_id,
      layer: h.layer,
      tags: h.workflow.tags ?? [],
      path: h.path,
    }));
    printJson(out);
    return;
  }

  if (cmd === "info") {
    const ref = rest[0];
    if (!ref) usage();
    const rec = resolveRefFlexible(root, ref);
    if (!rec) {
      console.error(`Not found: ${ref}`);
      process.exit(2);
    }
    printJson({
      id: rec.workflow.id,
      version: rec.workflow.version,
      title: rec.workflow.title,
      description: rec.workflow.description,
      site_id: rec.workflow.site_id,
      origins: rec.workflow.origins,
      params: rec.workflow.params,
      requires_vault: rec.workflow.requires_vault,
      pitfalls: rec.workflow.pitfalls,
      steps: rec.workflow.steps.length,
      layer: rec.layer,
      path: rec.path,
    });
    return;
  }

  if (cmd === "validate") {
    const target = rest[0];
    if (!target) {
      const all = loadAllWorkflows(root);
      const report = all.map((r) => ({
        id: r.workflow.id,
        path: r.path,
        errors: validateWorkflowShape(r.workflow),
      }));
      printJson(report);
      if (report.some((r) => r.errors.length)) process.exit(2);
      return;
    }
    if (fs.existsSync(target)) {
      const wf = parseYaml(fs.readFileSync(target, "utf8")) as Workflow;
      const errors = validateWorkflowShape(wf);
      printJson({ path: target, id: wf.id, errors });
      if (errors.length) process.exit(2);
      return;
    }
    const rec = resolveRefFlexible(root, target);
    if (!rec) {
      console.error(`Not found: ${target}`);
      process.exit(2);
    }
    const errors = validateWorkflowShape(rec.workflow);
    printJson({ id: rec.workflow.id, path: rec.path, errors });
    if (errors.length) process.exit(2);
    return;
  }

  if (cmd === "run") {
    const ref = rest[0];
    if (!ref) usage();
    const rec = resolveRefFlexible(root, ref);
    if (!rec) {
      console.error(`Not found: ${ref}. Try: flowrun search`);
      process.exit(2);
    }
    const shapeErrs = validateWorkflowShape(rec.workflow);
    if (shapeErrs.length) {
      printJson({ ok: false, errors: shapeErrs });
      process.exit(2);
    }

    const result = await runWorkflow(rec, {
      params,
      headed: Boolean(flags.headed),
      dryRun: Boolean(flags.dryRun),
      vault: vault.resolveVault({ root }),
      tracesDir: libraryDirs(root).traces,
    });

    printJson(result);
    process.exit(result.ok ? 0 : 3);
  }

  if (cmd === "train") {
    const siteId = rest[0];
    const workflowId = rest[1];
    if (!siteId || !workflowId) {
      console.error(
        "Usage: flowrun train <site_id> <workflow_id> [--url <start-url>] [--headed]",
      );
      process.exit(1);
    }
    const url = (flags.url as string) || `https://${siteId}.com`;

    await trainWorkflow({
      siteId,
      workflowId,
      url,
      headed: flags.headed !== false,
      root,
    });
    return;
  }

  if (cmd === "improve") {
    const ref = rest[0];
    if (!ref) {
      console.error(
        "Usage: flowrun improve <ref> [--headed] [--apply] [--param k=v ...]",
      );
      process.exit(1);
    }
    const result = await improveWorkflow({
      ref,
      headed: flags.headed !== false,
      apply: Boolean(flags.apply),
      root,
      params,
    });
    if (!result.ok) process.exit(3);
    return;
  }

  if (cmd === "verify") {
    const ref = rest[0];
    if (!ref) usage();
    const rec = resolveRefFlexible(root, ref);
    if (!rec) {
      console.error(`Not found: ${ref}`);
      process.exit(2);
    }

    const result = await verifyWorkflow(rec, {
      count: (flags.count as number | undefined) || undefined,
      params,
      headed: Boolean(flags.headed),
      screenshotCompare: Boolean(flags.screenshotCompare),
      screenshotThreshold: (flags.screenshotThreshold as number | undefined) || undefined,
      root,
      vault: vault.resolveVault({ root }),
    });

    if (result.all_ok) {
      stampVerifiedMeta(rec, result);
    }

    printJson(result);
    process.exit(result.ok ? 0 : 3);
  }

  if (cmd === "promote") {
    const ref = rest[0];
    if (!ref) usage();

    const result = promoteWorkflow({
      ref,
      version: (flags.toVersion as string) || undefined,
      force: Boolean(flags.force),
      root,
    });

    printJson(result);
    if (result.ok) {
      for (const hint of result.git_hints) {
        console.error(`  git: ${hint}`);
      }
    }
    process.exit(result.ok ? 0 : 2);
  }

  if (cmd === "vault") {
    const sub = rest[0];
    const storeKeychain = Boolean(flags["store-keychain"]);

    if (sub === "status") {
      printJson(vault.vaultStatus(root));
      return;
    }

    if (sub === "init") {
      const passphrase = await readPassphrase(flags);
      const p = vault.initVault({ root, passphrase, storeKeychain });
      printJson({ ok: true, path: p });
      return;
    }

    if (sub === "unlock") {
      const passphrase = await readPassphrase(flags);
      const r = vault.unlockVault({ root, passphrase, storeKeychain });
      printJson({ ...r, path: vault.resolveVaultPath(root) });
      return;
    }

    if (sub === "set") {
      const slot = rest[1];
      let value = rest[2];
      if (!slot) {
        console.error("Usage: flowrun vault set <slot> [value]");
        process.exit(1);
      }
      if (value === undefined) value = await promptHidden(`Value for ${slot}`);
      await withVaultPass(flags, (passphrase) =>
        vault.setSlot({ root, passphrase, slot, value: value! }),
      );
      printJson({ ok: true, slot });
      return;
    }

    if (sub === "get") {
      const slot = rest[1];
      if (!slot) {
        console.error("Usage: flowrun vault get <slot>");
        process.exit(1);
      }
      const value = await withVaultPass(flags, (passphrase) =>
        vault.getSlot({ root, passphrase, slot }),
      );
      process.stdout.write(value + "\n");
      return;
    }

    if (sub === "list") {
      printJson(
        await withVaultPass(flags, (passphrase) =>
          vault.listSlots({ root, passphrase }),
        ),
      );
      return;
    }

    if (sub === "delete") {
      const slot = rest[1];
      if (!slot) {
        console.error("Usage: flowrun vault delete <slot>");
        process.exit(1);
      }
      await withVaultPass(flags, (passphrase) =>
        vault.deleteSlot({ root, passphrase, slot }),
      );
      printJson({ ok: true, deleted: slot });
      return;
    }

    if (sub === "needs") {
      const ref = rest[1];
      let required: string[] = [];
      if (ref) {
        const rec = resolveRefFlexible(root, ref);
        if (!rec) {
          console.error(`Not found: ${ref}`);
          process.exit(2);
        }
        required = rec.workflow.requires_vault ?? [];
      } else {
        required = [
          ...new Set(
            loadAllWorkflows(root).flatMap((r) => r.workflow.requires_vault ?? []),
          ),
        ];
      }
      let have: Record<string, string> = {};
      try {
        have = vault.resolveVault({ root });
      } catch {
        have = {};
      }
      const missing = vault.vaultNeeds(required, have);
      printJson({ required, missing, ok: missing.length === 0 });
      process.exit(missing.length ? 2 : 0);
    }

    console.error(
      "Usage: flowrun vault init|unlock|set|get|list|delete|needs|status [--store-keychain] [--passphrase-stdin]",
    );
    process.exit(1);
  }

  usage();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
