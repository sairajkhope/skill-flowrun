import fs from "node:fs";
import path from "node:path";
import { parse, stringify } from "yaml";
import { chromium } from "playwright";
import { libraryDirs } from "./paths.js";
import type { Workflow, WorkflowStep } from "./types.js";

type RecordedEvent = {
  type: "navigate" | "click" | "fill";
  url?: string;
  tag?: string;
  role?: string;
  testid?: string;
  text?: string;
  placeholder?: string;
  name?: string;
  inputType?: string;
  value?: string;
  timestamp: number;
};

export type TrainOptions = {
  siteId: string;
  workflowId: string;
  url: string;
  headed?: boolean;
  root: string;
};

/** Prefer role+name > role > testid > placeholder > text (stable a11y first). */
function inferLocator(e: RecordedEvent): Record<string, string> {
  if (e.role && e.name) return { role: e.role, name: e.name };
  if (e.role) return { role: e.role };
  if (e.testid) return { testid: e.testid };
  if (e.placeholder) return { placeholder: e.placeholder };
  if (e.name) return { role: "textbox", name: e.name };
  if (e.text && e.text.length < 80) return { text: e.text };
  if (e.tag === "a" && e.text) return { text: e.text };
  if (e.tag === "button" && e.text) return { text: e.text };
  return { text: e.text ?? "(needs-selector)" };
}

export async function trainWorkflow(opts: TrainOptions): Promise<void> {
  const events: RecordedEvent[] = [];
  const startUrl = opts.url;
  const headed = opts.headed !== false;

  const browser = await chromium.launch({
    headless: !headed,
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();

  await page.exposeFunction("__fr_record", (e: RecordedEvent) => {
    events.push({ ...e, timestamp: Date.now() });
  });

  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame() && frame.url() !== "about:blank") {
      events.push({ type: "navigate", url: frame.url(), timestamp: Date.now() });
    }
  });

  const injectScript = async () => {
    try {
      await page.evaluate(() => {
        const send = (type: string, el: Element) => {
          const tag = el.tagName?.toLowerCase();
          const role =
            el.getAttribute("role") ||
            (tag === "button"
              ? "button"
              : tag === "a"
                ? "link"
                : tag === "input" || tag === "textarea"
                  ? "textbox"
                  : undefined);
          const testid = el.getAttribute("data-testid") || undefined;
          const text =
            el.textContent?.trim()?.slice(0, 120) ||
            (el as HTMLElement).getAttribute("aria-label") ||
            undefined;
          const placeholder = el.getAttribute("placeholder") || undefined;
          const name =
            el.getAttribute("name") ||
            el.getAttribute("aria-label") ||
            undefined;
          const inputType =
            tag === "input" ? (el as HTMLInputElement).type : undefined;
          const value =
            type === "fill" && "value" in el
              ? String((el as HTMLInputElement).value ?? "").slice(0, 200)
              : undefined;
          (window as unknown as { __fr_record: (x: unknown) => void }).__fr_record({
            type,
            tag,
            role,
            testid,
            text,
            placeholder,
            name,
            inputType,
            value,
          });
        };

        document.addEventListener(
          "click",
          (e) => {
            const target = e.target as Element;
            const interactive = target.closest(
              "a, button, input, textarea, select, [role=button], [role=link], [role=textbox], [role=combobox], [role=option]",
            );
            if (interactive) send("click", interactive);
          },
          true,
        );

        document.addEventListener(
          "change",
          (e) => {
            const el = e.target as Element;
            if (["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)) {
              send("fill", el);
            }
          },
          true,
        );
      });
    } catch {
      /* frame may have navigated during injection */
    }
  };

  page.on("load", () => {
    injectScript().catch(() => {});
  });

  console.log(`flowrun train — recording browser session`);
  console.log(`  URL:   ${startUrl}`);
  console.log(`  Site:  ${opts.siteId}`);
  console.log(`  ID:    web/${opts.siteId}/${opts.workflowId}`);
  console.log("");
  console.log("  Perform your workflow in the browser.");
  console.log("  Close the browser or press Ctrl+C when done.");
  console.log("  Password fields are redacted (vault slots, no values).");
  console.log("");

  await page.goto(startUrl, { waitUntil: "domcontentloaded" });
  await injectScript();

  await new Promise<void>((resolve) => {
    const done = () => resolve();
    page.once("close", done);
    process.once("SIGINT", () => {
      console.log("\nRecording stopped by user.");
      browser.close().catch(() => {});
      resolve();
    });
  });

  await browser.close().catch(() => {});

  const steps: WorkflowStep[] = [];
  const params: Workflow["params"] = {};
  const requires_vault: string[] = [];
  let fillIdx = 0;
  const seenNav = new Set<string>();

  for (const e of events) {
    if (e.type === "navigate" && e.url) {
      if (seenNav.has(e.url)) continue;
      seenNav.add(e.url);
      steps.push({ navigate: { url: e.url } });
      continue;
    }
    if (e.type === "click") {
      steps.push({ click: inferLocator(e) });
      continue;
    }
    if (e.type === "fill") {
      const loc = inferLocator(e);
      if (/password|passwd|secret|token|api[_-]?key/.test(
        `${e.name ?? ""} ${e.placeholder ?? ""} ${e.testid ?? ""}`.toLowerCase()
      ) || (e.inputType ?? "").toLowerCase() === "password") {
        const slot = `sites.${opts.siteId}.password`;
        if (!requires_vault.includes(slot)) requires_vault.push(slot);
        steps.push({ fill: { ...loc, value_from: `vault:${slot}` } });
      } else {
        fillIdx += 1;
        const key = e.name && /^[a-zA-Z_][\w.-]*$/.test(e.name) ? e.name : `value_${fillIdx}`;
        params[key] = {
          type: "string",
          required: true,
          description: e.placeholder || e.name || `fill ${fillIdx}`,
        };
        steps.push({ fill: { ...loc, value: `{{${key}}}` } });
      }
    }
  }

  // Drop consecutive duplicate navigations
  const deduped: WorkflowStep[] = [];
  for (const s of steps) {
    const prev = deduped[deduped.length - 1];
    if (
      prev &&
      "navigate" in prev &&
      "navigate" in s &&
      prev.navigate.url === s.navigate.url
    ) {
      continue;
    }
    deduped.push(s);
  }

  const ref = `web/${opts.siteId}/${opts.workflowId}`;
  const dirs = libraryDirs(opts.root);
  const origins: string[] = [];
  const sitePath = path.join(dirs.sites, `${opts.siteId}.yaml`);
  if (fs.existsSync(sitePath)) {
    const siteData = parse(fs.readFileSync(sitePath, "utf8")) as {
      origins?: string[];
    };
    origins.push(...(siteData.origins ?? []));
  }
  const startOrigin = (() => { try { return new URL(startUrl).origin; } catch { return null; } })();
  if (startOrigin && !origins.includes(startOrigin)) origins.push(startOrigin);
  for (const s of deduped) {
    if ("navigate" in s) {
      const o = (() => { try { return new URL(s.navigate.url).origin; } catch { return null; } })();
      if (o && !origins.includes(o)) origins.push(o);
    }
  }

  const workflow: Workflow = {
    id: ref,
    version: "0.1.0",
    title: opts.workflowId.replace(/-/g, " "),
    description: `Recorded workflow for ${opts.siteId}`,
    site_id: opts.siteId,
    origins,
    tags: [opts.siteId],
    params,
    requires_vault,
    steps: deduped,
    pitfalls: [
      "Recorded workflow — verify selectors and assertions before production use.",
    ],
  };

  const targetDir = path.join(dirs.local, "web", opts.siteId, opts.workflowId);
  const targetFile = path.join(targetDir, "workflow.yaml");
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(targetFile, stringify(workflow), "utf8");

  console.log(`\nSaved: ${targetFile}`);
  console.log(`Steps: ${deduped.length} (from ${events.length} raw events)`);
  if (requires_vault.length) {
    console.log(`Vault slots: ${requires_vault.join(", ")}`);
  }
  console.log("Review and edit the workflow before running.");
}
