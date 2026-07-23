import fs from "node:fs";
import path from "node:path";
import { parse, stringify } from "yaml";
import { chromium } from "playwright";
import { libraryDirs } from "./paths.js";
import type { Workflow, WorkflowRecord } from "./types.js";

type RecordedEvent = {
  type: "navigate" | "click" | "fill";
  url?: string;
  tag?: string;
  role?: string;
  testid?: string;
  text?: string;
  placeholder?: string;
  name?: string;
  timestamp: number;
};

export type TrainOptions = {
  siteId: string;
  workflowId: string;
  url: string;
  headed?: boolean;
  root: string;
};

function inferLocator(e: RecordedEvent): Record<string, string> {
  if (e.testid) return { testid: e.testid };
  if (e.role && e.name) return { role: e.role, name: e.name };
  if (e.role) return { role: e.role };
  if (e.placeholder) return { placeholder: e.placeholder };
  if (e.name) return { role: "textbox", name: e.name };
  if (e.text && e.text.length < 80) return { text: e.text };
  if (e.tag === "a" && e.text) return { text: e.text };
  if (e.tag === "button" && e.text) return { text: e.text };
  return { text: e.text ?? "(needs-selector)" };
}

export async function trainWorkflow(
  opts: TrainOptions,
): Promise<void> {
  const events: RecordedEvent[] = [];
  const startUrl = opts.url;

  const browser = await chromium.launch({
    headless: !opts.headed,
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
          const role = el.getAttribute("role");
          const testid = el.getAttribute("data-testid");
          const text =
            el.textContent?.trim()?.slice(0, 120) ||
            (el as HTMLElement).getAttribute("aria-label") ||
            undefined;
          const placeholder = el.getAttribute("placeholder");
          const name = el.getAttribute("name");
          (window as any).__fr_record({ type, tag, role, testid, text, placeholder, name });
        };

        document.addEventListener(
          "click",
          (e) => {
            const target = e.target as Element;
            const interactive =
              target.closest("a, button, input, textarea, select, [role=button], [role=link], [role=textbox], [role=combobox], [role=option]");
            if (interactive) send("click", interactive);
          },
          true,
        );

        document.addEventListener(
          "input",
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
  console.log("  Recorded events will be saved as a workflow.");
  console.log("");

  await page.goto(startUrl, { waitUntil: "domcontentloaded" });
  await injectScript();

  await new Promise<void>((resolve) => {
    page.on("close", () => resolve());
    process.on("SIGINT", () => {
      console.log("\nRecording stopped by user.");
      browser.close().catch(() => {});
      resolve();
    });
  });

  // Build workflow from recorded events
  const steps: any[] = [];
  let firstNav = true;

  for (const e of events) {
    if (e.type === "navigate" && e.url) {
      if (firstNav) {
        steps.push({ navigate: { url: e.url } });
        firstNav = false;
      } else {
        // Subsequent navigations — check if it's a same-origin path
        try {
          const orig = new URL(startUrl);
          const dest = new URL(e.url);
          if (orig.origin === dest.origin) {
            steps.push({ navigate: { url: dest.pathname + dest.search } });
          } else {
            steps.push({ navigate: { url: e.url } });
          }
        } catch {
          steps.push({ navigate: { url: e.url } });
        }
      }
    } else if (e.type === "click") {
      steps.push({ click: inferLocator(e) });
    } else if (e.type === "fill") {
      const loc = inferLocator(e);
      steps.push({ fill: { ...loc, value: "{{value}}" } });
    }
  }

  // Deduplicate consecutive navigations
  const deduped: typeof steps = [];
  for (const s of steps) {
    const prev = deduped[deduped.length - 1];
    if (prev && "navigate" in prev && "navigate" in s) continue;
    deduped.push(s);
  }

  const ref = `web/${opts.siteId}/${opts.workflowId}`;
  const workflow: Workflow = {
    id: ref,
    version: "0.1.0",
    title: `${opts.workflowId.replace(/-/g, " ")}`,
    description: `Recorded workflow for ${opts.siteId}`,
    site_id: opts.siteId,
    origins: [],
    tags: [opts.siteId],
    params: {},
    requires_vault: [],
    steps: deduped,
    pitfalls: ["Recorded workflow — verify selectors and assertions before production use."],
  };

  const dirs = libraryDirs(opts.root);
  const targetDir = path.join(dirs.local, "web", opts.siteId, opts.workflowId);
  const targetFile = path.join(targetDir, "workflow.yaml");

  const sitePath = path.join(dirs.sites, `${opts.siteId}.yaml`);
  if (fs.existsSync(sitePath)) {
    const siteData = parse(fs.readFileSync(sitePath, "utf8")) as any;
    workflow.origins = siteData.origins ?? [];
  }

  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(targetFile, stringify(workflow), "utf8");

  console.log(`\nSaved: ${targetFile}`);
  console.log(`Steps: ${deduped.length} (from ${events.length} raw events)`);
  console.log("Review and edit the workflow before running.");
}


