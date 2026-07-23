import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml, stringify } from "yaml";
import { chromium } from "playwright";
import { resolveWorkflow, validateWorkflowShape } from "./library.js";
import type { Workflow, WorkflowRecord, RunResult } from "./types.js";
import { runWorkflow } from "./runner.js";

export type ImproveOptions = {
  ref: string;
  apply: boolean;
  headed?: boolean;
  root: string;
};

function bumpPatch(v: string): string {
  const parts = v.split(".").map(Number);
  if (parts.length !== 3) return `${v}-improved`;
  return `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
}

export async function improveWorkflow(
  opts: ImproveOptions,
): Promise<{ ok: boolean; result?: RunResult; patched?: boolean }> {
  const rec = resolveWorkflow(opts.root, opts.ref);
  if (!rec) {
    console.error(`Not found: ${opts.ref}`);
    return { ok: false };
  }

  if (rec.layer === "seed") {
    console.log("Seed workflow cannot be patched in-place. Copying to local...");
    const dirs = (await import("./paths.js")).libraryDirs(opts.root);
    const id = rec.workflow.id;
    const parts = id.split("/");
    const targetDir = path.join(dirs.local, ...parts.slice(0, -1), parts[parts.length - 1]);
    const targetFile = path.join(targetDir, "workflow.yaml");
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(targetFile, stringify(rec.workflow), "utf8");
    const localRec: WorkflowRecord = {
      workflow: JSON.parse(JSON.stringify(rec.workflow)) as Workflow,
      path: targetFile,
      layer: "local",
    };
    console.log(`  Copied to: ${targetFile}`);
    return improveWorkflow({ ...opts, ref: localRec.workflow.id });
  }

  const shapeErrs = validateWorkflowShape(rec.workflow);
  if (shapeErrs.length) {
    console.error(`Invalid workflow: ${shapeErrs.join("; ")}`);
    return { ok: false };
  }

  console.log(`flowrun improve — running "${rec.workflow.id}@${rec.workflow.version}" in headed mode`);
  console.log("Watch the browser. On failure, the page stays open for debugging.");
  console.log("");

  const start = Date.now();
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const vault: Record<string, string> = {};

  const vaultPath = process.env.FLOWRUN_VAULT;
  if (vaultPath && fs.existsSync(vaultPath)) {
    Object.assign(vault, parseYaml(fs.readFileSync(vaultPath, "utf8")));
  }

  let fatal: string | undefined;
  const steps: any[] = [];

  for (let i = 0; i < rec.workflow.steps.length; i++) {
    const step = rec.workflow.steps[i];
    const t0 = Date.now();
    const stepName = Object.keys(step)[0] ?? "unknown";
    try {
      await execImproveStep(page, step, rec.workflow.origins);
      steps.push({ index: i, step: stepName, ok: true, duration_ms: Date.now() - t0 });
    } catch (e) {
      const msg = (e as Error).message;
      steps.push({ index: i, step: stepName, ok: false, error: msg, duration_ms: Date.now() - t0 });
      fatal = `step ${i} (${stepName}): ${msg}`;
      break;
    }
  }

  if (!fatal) {
    console.log("\nAll steps passed! Nothing to improve.");
    await browser.close();
    return { ok: true };
  }

  console.log(`\nFailed: ${fatal}`);
  console.log(`Current URL: ${page.url()}`);
  console.log("\nThe browser is still open for debugging.");
  console.log("Close it when you're done inspecting.\n");

  await new Promise<void>((resolve) => {
    page.on("close", () => resolve());
    process.on("SIGINT", () => {
      browser.close().catch(() => {});
      resolve();
    });
  });

  if (!opts.apply) {
    console.log("Use --apply to patch the workflow after fixing selectors.");
    return { ok: false, patched: false };
  }

  // Interactive patch session
  console.log("\nEnter improved selectors for failed steps.");
  console.log("Format: step_index locator_type=value [locator_type=value ...]");
  console.log("Example: 2 role=button name=Submit");
  console.log("Press Enter with no input to skip.\n");

  const updatedWorkflow: Workflow = JSON.parse(JSON.stringify(rec.workflow)) as Workflow;

  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.ok) continue;
    const step = updatedWorkflow.steps[i];
    const stepName = Object.keys(step)[0] ?? "unknown";
    const current = JSON.stringify((step as any)[stepName]);

    const answer = await rl.question(
      `Step ${i} (${stepName}) current: ${current}\n  New selectors (or empty to skip): `,
    );

    if (!answer.trim()) continue;

    const parts = answer.trim().split(/\s+/);
    const newLoc: Record<string, string> = {};
    for (const p of parts) {
      const eq = p.indexOf("=");
      if (eq === -1) {
        console.log(`  Skipping malformed: ${p}`);
        continue;
      }
      newLoc[p.slice(0, eq)] = p.slice(eq + 1);
    }
    if (Object.keys(newLoc).length > 0) {
      (step as any)[stepName] = newLoc;
      console.log(`  Updated step ${i}`);
    }
  }

  rl.close();

  updatedWorkflow.version = bumpPatch(updatedWorkflow.version);
  updatedWorkflow.pitfalls = updatedWorkflow.pitfalls ?? [];
  updatedWorkflow.pitfalls.push(`improved: patched ${steps.filter((s: any) => !s.ok).length} failing steps`);

  const yaml = stringify(updatedWorkflow);
  fs.writeFileSync(rec.path, yaml, "utf8");

  console.log(`\nPatched: ${rec.path}`);
  console.log(`Version: ${rec.workflow.version} -> ${updatedWorkflow.version}`);

  return { ok: false, patched: true };
}

async function execImproveStep(
  page: any,
  step: any,
  origins: string[],
): Promise<void> {
  if ("navigate" in step) {
    await page.goto(step.navigate.url, { waitUntil: "domcontentloaded" });
    return;
  }
  if ("click" in step) {
    const loc = await locateImprove(page, step.click);
    await loc.first().click({ timeout: 15000 });
    return;
  }
  if ("fill" in step) {
    const loc = await locateImprove(page, step.fill);
    await loc.first().fill(step.fill.value ?? "", { timeout: 15000 });
    return;
  }
  if ("wait" in step) {
    if (step.wait.text) {
      await page.getByText(step.wait.text).first().waitFor({
        state: "visible",
        timeout: step.wait.timeout_ms ?? 15000,
      });
    }
    return;
  }
  if ("assert" in step) {
    if (step.assert.url_includes && !page.url().includes(step.assert.url_includes)) {
      throw new Error(`assert url_includes "${step.assert.url_includes}" failed; url=${page.url()}`);
    }
    if (step.assert.title_includes) {
      const title = await page.title();
      if (!title.includes(step.assert.title_includes)) {
        throw new Error(`assert title_includes "${step.assert.title_includes}" failed; title=${title}`);
      }
    }
    if (step.assert.text) {
      const count = await page.getByText(step.assert.text).count();
      if (!count) throw new Error(`assert text "${step.assert.text}" not found`);
    }
    return;
  }
  if ("screenshot" in step) {
    await page.screenshot({ path: step.screenshot.path ?? `/tmp/improve-shot-${Date.now()}.png` });
    return;
  }
  throw new Error(`Unknown step: ${JSON.stringify(step)}`);
}

async function locateImprove(page: any, loc: any) {
  if (loc.testid) return page.getByTestId(loc.testid);
  if (loc.role && loc.name) return page.getByRole(loc.role, { name: loc.name });
  if (loc.role) return page.getByRole(loc.role);
  if (loc.placeholder) return page.getByPlaceholder(loc.placeholder);
  if (loc.text) return page.getByText(loc.text);
  if (loc.css) return page.locator(loc.css);
  throw new Error("No valid locator in step");
}
