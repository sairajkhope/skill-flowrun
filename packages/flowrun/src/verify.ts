import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { stringify as stringifyYaml } from "yaml";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { runWorkflow } from "./runner.js";
import { resolveRefFlexible } from "./library.js";
import type {
  RunResult,
  VerifyResult,
  VerifyRunDetail,
  WorkflowRecord,
} from "./types.js";

export type VerifyOptions = {
  count?: number;
  params?: Record<string, string>;
  headed?: boolean;
  screenshotCompare?: boolean;
  screenshotThreshold?: number;
  root: string;
  vault?: Record<string, string>;
};

function sha256(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

export async function verifyWorkflow(
  record: WorkflowRecord,
  opts: VerifyOptions,
): Promise<VerifyResult> {
  const runs_detail: VerifyRunDetail[] = [];
  const screenshots: Buffer[] = [];
  let passed = 0;
  let failed = 0;

  const count = opts.count ?? 3;
  const threshold = opts.screenshotThreshold ?? 0.05;

  for (let i = 0; i < count; i++) {
    const tracesDir = path.join(opts.root, "traces");
    const result = await runWorkflow(record, {
      params: opts.params,
      headed: opts.headed,
      vault: opts.vault,
      tracesDir,
    });

    let screenshot_sha256: string | undefined;
    if (opts.screenshotCompare && result.ok) {
      const shotDir = path.join(tracesDir, "verify-screenshots");
      fs.mkdirSync(shotDir, { recursive: true });
      const shotPath = path.join(shotDir, `run-${i}-${Date.now()}.png`);
      try {
        const browser = await (
          await import("playwright")
        ).chromium.launch({ headless: !opts.headed });
        const page = await (await browser.newContext()).newPage();
        if (result.final_url) {
          await page.goto(result.final_url, { waitUntil: "domcontentloaded" });
          await page.screenshot({ path: shotPath, fullPage: true });
        }
        await browser.close();
      } catch {
      }
      if (fs.existsSync(shotPath)) {
        const buf = fs.readFileSync(shotPath);
        screenshot_sha256 = sha256(buf);
        screenshots.push(buf);
      }
    }

    runs_detail.push({
      index: i,
      ok: result.ok,
      duration_ms: result.duration_ms,
      error: result.error,
      screenshot_sha256,
    });

    if (result.ok) passed++;
    else failed++;
  }

  const all_ok = failed === 0;
  const flaky = passed > 0 && failed > 0;
  const avg_duration_ms = Math.round(
    runs_detail.reduce((s, r) => s + r.duration_ms, 0) / runs_detail.length,
  );

  const screenshot_deltas: VerifyResult["screenshot_deltas"] = [];
  if (opts.screenshotCompare && screenshots.length >= 2) {
    for (let i = 0; i < screenshots.length - 1; i++) {
      try {
        const img1 = PNG.sync.read(screenshots[i]);
        const img2 = PNG.sync.read(screenshots[i + 1]);
        const w = Math.min(img1.width, img2.width);
        const h = Math.min(img1.height, img2.height);
        const diff = new PNG({ width: w, height: h });
        const changed = pixelmatch(
          img1.data,
          img2.data,
          diff.data,
          w,
          h,
          { threshold },
        );
        const totalPixels = w * h;
        const pct = totalPixels > 0 ? (changed / totalPixels) * 100 : 0;
        const deltaBuf = PNG.sync.write(diff);
        screenshot_deltas.push({
          run_a: i,
          run_b: i + 1,
          changed_pixels_pct: Math.round(pct * 100) / 100,
          delta_png_bytes: deltaBuf.length,
        });
      } catch {
      }
    }
  }

  return {
    ok: all_ok || !flaky,
    ref: record.workflow.id,
    version: record.workflow.version,
    runs: count,
    passed,
    failed,
    all_ok,
    flaky,
    avg_duration_ms,
    runs_detail,
    screenshot_deltas: screenshot_deltas.length ? screenshot_deltas : undefined,
    params_used: opts.params ?? {},
  };
}

export function stampVerifiedMeta(
  record: WorkflowRecord,
  vr: VerifyResult,
): void {
  const wf = record.workflow;
  wf.meta ??= {};
  wf.meta.verified = {
    verified_at: new Date().toISOString(),
    runs: vr.runs,
    all_passed: vr.all_ok,
    avg_duration_ms: vr.avg_duration_ms,
    params_used: vr.params_used,
    environment: `flowrun verify count=${vr.runs}`,
  };

  const yaml = stringifyYaml(wf, { lineWidth: 120 });
  fs.writeFileSync(record.path, yaml, "utf8");
}
