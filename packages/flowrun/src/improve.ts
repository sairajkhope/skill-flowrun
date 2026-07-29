import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stringify } from "yaml";
import { chromium } from "playwright";
import { resolveWorkflow, validateWorkflowShape, bumpVersion } from "./library.js";
import { libraryDirs } from "./paths.js";
import { execStep, stepName } from "./runner.js";
import { resolveVault } from "./vault.js";
import type { Workflow, WorkflowRecord, WorkflowStep } from "./types.js";

export type ImproveOptions = {
  ref: string;
  apply: boolean;
  headed?: boolean;
  root: string;
  params?: Record<string, string>;
};

export async function improveWorkflow(
  opts: ImproveOptions,
): Promise<{ ok: boolean; patched?: boolean; error?: string }> {
  let rec = resolveWorkflow(opts.root, opts.ref);
  if (!rec) {
    console.error(`Not found: ${opts.ref}`);
    return { ok: false, error: `Not found: ${opts.ref}` };
  }

  if (rec.layer === "seed") {
    console.log("Seed workflow cannot be patched in-place. Copying to local...");
    const dirs = libraryDirs(opts.root);
    const parts = rec.workflow.id.split("/");
    const targetDir = path.join(dirs.local, ...parts);
    const targetFile = path.join(targetDir, "workflow.yaml");
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(targetFile, stringify(rec.workflow), "utf8");
    console.log(`  Copied to: ${targetFile}`);
    rec = {
      workflow: structuredClone(rec.workflow) as Workflow,
      path: targetFile,
      layer: "local",
    };
  }

  const shapeErrs = validateWorkflowShape(rec.workflow);
  if (shapeErrs.length) {
    console.error(`Invalid workflow: ${shapeErrs.join("; ")}`);
    return { ok: false, error: shapeErrs.join("; ") };
  }

  console.log(
    `flowrun improve — running "${rec.workflow.id}@${rec.workflow.version}" in headed mode`,
  );
  console.log("Watch the browser. On failure, the page stays open for debugging.");
  console.log("");

  const vaultMap = resolveVault({ root: opts.root });
  const params = opts.params ?? {};
  const browser = await chromium.launch({ headless: opts.headed === false });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();

  const stepResults: Array<{
    index: number;
    step: string;
    ok: boolean;
    error?: string;
  }> = [];
  let fatal: string | undefined;

  try {
    for (let i = 0; i < rec.workflow.steps.length; i++) {
      const step = rec.workflow.steps[i];
      const name = stepName(step);
      try {
        await execStep(page, step, params, vaultMap, rec.workflow.origins, {});
        stepResults.push({ index: i, step: name, ok: true });
      } catch (e) {
        const msg = (e as Error).message;
        stepResults.push({ index: i, step: name, ok: false, error: msg });
        fatal = `step ${i} (${name}): ${msg}`;
        break;
      }
    }

    if (!fatal) {
      console.log("\nAll steps passed! Nothing to improve.");
      return { ok: true };
    }

    console.log(`\nFailed: ${fatal}`);
    console.log(`Current URL: ${page.url()}`);
    console.log("\nThe browser is still open for debugging.");
    console.log("Close it when you're done inspecting.\n");

    await new Promise<void>((resolve) => {
      const done = () => resolve();
      page.once("close", done);
      const onSig = () => {
        browser.close().catch(() => {});
        resolve();
      };
      process.once("SIGINT", onSig);
    });
  } finally {
    await browser.close().catch(() => {});
  }

  if (!opts.apply) {
    console.log("Use --apply to patch the workflow after fixing selectors.");
    return { ok: false, patched: false, error: fatal };
  }

  console.log("\nEnter improved selectors for failed steps.");
  console.log("Format: locator_type=value [locator_type=value ...]");
  console.log("Example: role=button name=Submit");
  console.log("Press Enter with no input to skip.\n");

  const updatedWorkflow = structuredClone(rec.workflow) as Workflow;
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    for (const s of stepResults) {
      if (s.ok) continue;
      const step = updatedWorkflow.steps[s.index] as WorkflowStep;
      const sn = stepName(step);
      const body = (step as Record<string, unknown>)[sn];
      if (
        sn === "navigate" ||
        sn === "wait" ||
        sn === "assert" ||
        sn === "press" ||
        sn === "screenshot"
      ) {
        console.log(
          `Step ${s.index} (${sn}) is not a locator step — edit YAML manually if needed.`,
        );
        continue;
      }

      const answer = await rl.question(
        `Step ${s.index} (${sn}) current: ${JSON.stringify(body)}\n  New selectors (or empty to skip): `,
      );
      if (!answer.trim()) continue;

      const newLoc: Record<string, string> = {};
      for (const p of answer.trim().split(/\s+/)) {
        const eq = p.indexOf("=");
        if (eq === -1) {
          console.log(`  Skipping malformed: ${p}`);
          continue;
        }
        newLoc[p.slice(0, eq)] = p.slice(eq + 1);
      }
      if (Object.keys(newLoc).length === 0) continue;

      const prev = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
      const kept: Record<string, unknown> = {};
      if ("value" in prev) kept.value = prev.value;
      if ("value_from" in prev) kept.value_from = prev.value_from;
      (step as Record<string, unknown>)[sn] = { ...kept, ...newLoc };
      console.log(`  Updated step ${s.index}`);
    }
  } finally {
    rl.close();
  }

  updatedWorkflow.version = bumpVersion(updatedWorkflow.version, "patch");
  updatedWorkflow.pitfalls = updatedWorkflow.pitfalls ?? [];
  const failCount = stepResults.filter((s) => !s.ok).length;
  updatedWorkflow.pitfalls.push(`improved: patched ${failCount} failing step(s)`);

  fs.writeFileSync(rec.path, stringify(updatedWorkflow), "utf8");
  console.log(`\nPatched: ${rec.path}`);
  console.log(`Version: ${rec.workflow.version} -> ${updatedWorkflow.version}`);
  console.log("Re-run: flowrun run " + updatedWorkflow.id);

  return { ok: true, patched: true };
}
