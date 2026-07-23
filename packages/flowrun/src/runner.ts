import fs from "node:fs";
import path from "node:path";
import { chromium, type Locator, type Page } from "playwright";
import { interpolate } from "./interpolate.js";
import { libraryDirs } from "./paths.js";
import type {
  LocatorFields,
  RunResult,
  StepResult,
  Workflow,
  WorkflowRecord,
  WorkflowStep,
} from "./types.js";

export type RunOptions = {
  params?: Record<string, string>;
  headed?: boolean;
  dryRun?: boolean;
  vault?: Record<string, string>;
  tracesDir?: string;
};

function originAllowed(url: string, origins: string[]): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return origins.some((o) => {
    try {
      const allowed = new URL(o);
      return u.origin === allowed.origin;
    } catch {
      return false;
    }
  });
}

function stepName(step: WorkflowStep): string {
  return Object.keys(step)[0] ?? "unknown";
}

async function locate(page: Page, loc: LocatorFields): Promise<Locator> {
  if (loc.testid) return page.getByTestId(loc.testid);
  if (loc.role && loc.name) {
    return page.getByRole(loc.role as Parameters<Page["getByRole"]>[0], {
      name: loc.name,
    });
  }
  if (loc.role) {
    return page.getByRole(loc.role as Parameters<Page["getByRole"]>[0]);
  }
  if (loc.placeholder) return page.getByPlaceholder(loc.placeholder);
  if (loc.text) return page.getByText(loc.text);
  if (loc.css) return page.locator(loc.css);
  throw new Error(
    "Locator needs one of: testid, role(+name), placeholder, text, css",
  );
}

function resolveValue(
  fill: { value?: string; value_from?: string },
  params: Record<string, string>,
  vault: Record<string, string>,
): string {
  if (fill.value_from) {
    if (!fill.value_from.startsWith("vault:")) {
      throw new Error(`value_from must start with vault:, got ${fill.value_from}`);
    }
    const slot = fill.value_from.slice("vault:".length);
    if (!(slot in vault)) {
      throw new Error(`Missing vault slot: ${slot}`);
    }
    // Injected into browser only — callers must not log this
    return vault[slot];
  }
  if (fill.value === undefined) {
    throw new Error("fill requires value or value_from");
  }
  return interpolate(fill.value, params);
}

function missingParams(wf: Workflow, params: Record<string, string>): string[] {
  const missing: string[] = [];
  for (const [name, spec] of Object.entries(wf.params ?? {})) {
    if (spec.required && !(name in params) && spec.default === undefined) {
      missing.push(name);
    }
  }
  return missing;
}

function applyDefaults(
  wf: Workflow,
  params: Record<string, string>,
): Record<string, string> {
  const out = { ...params };
  for (const [name, spec] of Object.entries(wf.params ?? {})) {
    if (!(name in out) && spec.default !== undefined) {
      out[name] = String(spec.default);
    }
  }
  return out;
}

export async function runWorkflow(
  record: WorkflowRecord,
  opts: RunOptions = {},
): Promise<RunResult> {
  const wf = record.workflow;
  const started = Date.now();
  const started_at = new Date(started).toISOString();
  const params = applyDefaults(wf, opts.params ?? {});
  const vault = opts.vault ?? {};
  const steps: StepResult[] = [];

  const missP = missingParams(wf, params);
  const missV = (wf.requires_vault ?? []).filter((s) => !(s in vault));

  if (missP.length || missV.length) {
    return {
      ok: false,
      ref: wf.id,
      version: wf.version,
      layer: record.layer,
      started_at,
      finished_at: new Date().toISOString(),
      duration_ms: Date.now() - started,
      steps,
      error: "Missing required params or vault slots",
      missing_params: missP.length ? missP : undefined,
      missing_vault: missV.length ? missV : undefined,
    };
  }

  if (opts.dryRun) {
    for (let i = 0; i < wf.steps.length; i++) {
      steps.push({
        index: i,
        step: stepName(wf.steps[i]),
        ok: true,
        duration_ms: 0,
      });
    }
    return {
      ok: true,
      ref: wf.id,
      version: wf.version,
      layer: record.layer,
      started_at,
      finished_at: new Date().toISOString(),
      duration_ms: Date.now() - started,
      steps,
    };
  }

  const browser = await chromium.launch({ headless: !opts.headed });
  const context = await browser.newContext();
  const page = await context.newPage();

  let final_url: string | undefined;
  let fatal: string | undefined;

  try {
    for (let i = 0; i < wf.steps.length; i++) {
      const step = wf.steps[i];
      const t0 = Date.now();
      try {
        await execStep(page, step, params, vault, wf.origins, opts);
        steps.push({
          index: i,
          step: stepName(step),
          ok: true,
          duration_ms: Date.now() - t0,
        });
      } catch (e) {
        const msg = (e as Error).message;
        steps.push({
          index: i,
          step: stepName(step),
          ok: false,
          error: msg,
          duration_ms: Date.now() - t0,
        });
        fatal = `step ${i} (${stepName(step)}): ${msg}`;
        if (opts.tracesDir) {
          fs.mkdirSync(opts.tracesDir, { recursive: true });
          const shot = path.join(
            opts.tracesDir,
            `${wf.id.replaceAll("/", "_")}-${Date.now()}.png`,
          );
          try {
            await page.screenshot({ path: shot, fullPage: true });
          } catch {
            /* ignore */
          }
        }
        break;
      }
    }
    final_url = page.url();
  } finally {
    await browser.close();
  }

  return {
    ok: !fatal,
    ref: wf.id,
    version: wf.version,
    layer: record.layer,
    started_at,
    finished_at: new Date().toISOString(),
    duration_ms: Date.now() - started,
    final_url,
    steps,
    error: fatal,
  };
}

async function execStep(
  page: Page,
  step: WorkflowStep,
  params: Record<string, string>,
  vault: Record<string, string>,
  origins: string[],
  opts: RunOptions,
): Promise<void> {
  if ("navigate" in step) {
    const url = interpolate(step.navigate.url, params);
    if (!originAllowed(url, origins)) {
      throw new Error(
        `Origin not allowed for navigate: ${url} (allowed: ${origins.join(", ")})`,
      );
    }
    await page.goto(url, { waitUntil: "domcontentloaded" });
    return;
  }

  // After any navigation-like action, guard current URL when asserting/clicking
  if (page.url() && page.url() !== "about:blank" && !originAllowed(page.url(), origins)) {
    throw new Error(`Current page origin not allowed: ${page.url()}`);
  }

  if ("click" in step) {
    const loc = await locate(page, step.click);
    await loc.first().click({ timeout: 15000 });
    return;
  }

  if ("fill" in step) {
    const value = resolveValue(step.fill, params, vault);
    const loc = await locate(page, step.fill);
    await loc.first().fill(value, { timeout: 15000 });
    return;
  }

  if ("press" in step) {
    await page.keyboard.press(step.press.key);
    return;
  }

  if ("wait" in step) {
    const timeout = step.wait.timeout_ms ?? 15000;
    if (step.wait.url_includes) {
      const part = interpolate(step.wait.url_includes, params);
      await page.waitForURL((u) => u.toString().includes(part), { timeout });
    }
    if (step.wait.text) {
      const text = interpolate(step.wait.text, params);
      await page.getByText(text).first().waitFor({ state: "visible", timeout });
    }
    return;
  }

  if ("assert" in step) {
    if (step.assert.url_includes) {
      const part = interpolate(step.assert.url_includes, params);
      if (!page.url().includes(part)) {
        throw new Error(`assert url_includes "${part}" failed; url=${page.url()}`);
      }
    }
    if (step.assert.title_includes) {
      const part = interpolate(step.assert.title_includes, params);
      const title = await page.title();
      if (!title.includes(part)) {
        throw new Error(`assert title_includes "${part}" failed; title=${title}`);
      }
    }
    if (step.assert.text) {
      const text = interpolate(step.assert.text, params);
      const count = await page.getByText(text).count();
      if (!count) throw new Error(`assert text "${text}" not found`);
    }
    return;
  }

  if ("screenshot" in step) {
    const dir = opts.tracesDir ?? libraryDirs(process.cwd()).traces;
    fs.mkdirSync(dir, { recursive: true });
    const dest =
      step.screenshot.path ??
      path.join(dir, `shot-${Date.now()}.png`);
    await page.screenshot({
      path: dest,
      fullPage: step.screenshot.full_page ?? false,
    });
    return;
  }

  throw new Error(`Unknown step: ${JSON.stringify(step)}`);
}
