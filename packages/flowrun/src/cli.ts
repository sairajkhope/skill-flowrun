#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
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
  flowrun improve <ref> [--headed] [--apply]
  flowrun verify <ref> [--count N] [--param k=v ...] [--headed] [--screenshot-compare] [--screenshot-threshold 0.05]
  flowrun promote <ref> [--version 1.0.0] [--force]
  flowrun root

Refs: web/<site_id>/<workflow_id>[@version]
Env:  FLOWRUN_ROOT  library root (default: auto-detect workflow-skills/)
      FLOWRUN_VAULT path to YAML map of vault slots (local only; never commit)
`);
  process.exit(1);
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

function loadVault(): Record<string, string> {
  const p = process.env.FLOWRUN_VAULT;
  if (!p || !fs.existsSync(p)) return {};
  const data = parseYaml(fs.readFileSync(p, "utf8")) as Record<string, string>;
  return data ?? {};
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
      vault: loadVault(),
      tracesDir: libraryDirs(root).traces,
    });

    printJson(result);
    process.exit(result.ok ? 0 : 3);
  }

  if (cmd === "train") {
    const siteId = rest[0];
    const workflowId = rest[1];
    if (!siteId || !workflowId) {
      console.error("Usage: flowrun train <site_id> <workflow_id> [--url <start-url>] [--headed]");
      process.exit(1);
    }
    const url =
      (flags.url as string) ||
      `https://${siteId}.com`;

    await trainWorkflow({
      siteId,
      workflowId,
      url,
      headed: Boolean(flags.headed),
      root,
    });
    return;
  }

  if (cmd === "improve") {
    const ref = rest[0];
    if (!ref) {
      console.error("Usage: flowrun improve <ref> [--headed] [--apply]");
      process.exit(1);
    }
    const result = await improveWorkflow({
      ref,
      headed: Boolean(flags.headed),
      apply: Boolean(flags.apply),
      root,
    });
    if (!result.ok) {
      process.exit(3);
    }
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
      vault: loadVault(),
    });

    if (result.all_ok || !result.flaky) {
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
    console.error(`Command 'vault' is designed but not implemented. See wiki.md.`);
    process.exit(1);
  }

  usage();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
