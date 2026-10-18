import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { libraryDirs } from "./paths.js";
import type { Workflow, WorkflowRecord } from "./types.js";

const WORKFLOW_FILE = "workflow.yaml";

function walkWorkflowFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  return fs.globSync(`**/${WORKFLOW_FILE}`, { cwd: root }).map((f) => path.join(root, f));
}

function loadWorkflowFile(filePath: string, layer: "local" | "seed"): WorkflowRecord {
  const raw = fs.readFileSync(filePath, "utf8");
  const workflow = parseYaml(raw) as Workflow;
  if (!workflow?.id || !workflow?.steps) {
    throw new Error(`Invalid workflow at ${filePath}: missing id or steps`);
  }
  return { workflow, path: filePath, layer };
}

export function loadAllWorkflows(root: string): WorkflowRecord[] {
  const { local, seed } = libraryDirs(root);
  const records: WorkflowRecord[] = [];
  for (const f of walkWorkflowFiles(seed)) {
    try {
      records.push(loadWorkflowFile(f, "seed"));
    } catch (e) {
      console.error(`skip ${f}: ${(e as Error).message}`);
    }
  }
  for (const f of walkWorkflowFiles(local)) {
    try {
      records.push(loadWorkflowFile(f, "local"));
    } catch (e) {
      console.error(`skip ${f}: ${(e as Error).message}`);
    }
  }
  return records;
}

/** local shadows seed on same id */
export function resolveWorkflow(root: string, ref: string): WorkflowRecord | null {
  const { id, version } = parseRef(ref);
  const all = loadAllWorkflows(root).filter((r) => r.workflow.id === id);
  if (!all.length) return null;

  const local = all.filter((r) => r.layer === "local");
  const seed = all.filter((r) => r.layer === "seed");
  const pool = local.length ? local : seed;

  if (version) {
    const hit = pool.find((r) => r.workflow.version === version);
    return hit ?? null;
  }
  return pool.reduce((a, b) =>
    a.workflow.version.localeCompare(b.workflow.version, undefined, { numeric: true }) > 0 ? a : b,
  );
}

export function parseRef(ref: string): { id: string; version?: string } {
  const [base, version] = ref.split("@");
  // alias or short form later
  if (base.startsWith("web/")) {
    return { id: base, version };
  }
  // unique suffix: workflow_id only
  return { id: base, version };
}

export function resolveRefFlexible(root: string, ref: string): WorkflowRecord | null {
  const direct = resolveWorkflow(root, ref);
  if (direct) return direct;

  const { id, version } = parseRef(ref);
  // if not full id, try unique match on workflow_id suffix or alias
  const all = loadAllWorkflows(root);
  const matches = all.filter((r) => {
    const wf = r.workflow;
    const suffix = wf.id.split("/").pop();
    if (wf.id === id) return true;
    if (suffix === id) return true;
    if (wf.aliases?.includes(id)) return true;
    return false;
  });

  // prefer local
  const locals = matches.filter((m) => m.layer === "local");
  const pool = locals.length ? locals : matches;
  const uniqIds = new Set(pool.map((m) => m.workflow.id));
  if (uniqIds.size !== 1) return null;
  const idOnly = [...uniqIds][0];
  return resolveWorkflow(root, version ? `${idOnly}@${version}` : idOnly);
}

export function searchWorkflows(root: string, query: string): WorkflowRecord[] {
  const q = query.toLowerCase().trim();
  const all = loadAllWorkflows(root);
  // dedupe by id preferring local
  const byId = new Map<string, WorkflowRecord>();
  for (const r of all) {
    const prev = byId.get(r.workflow.id);
    if (!prev || (prev.layer === "seed" && r.layer === "local")) {
      byId.set(r.workflow.id, r);
    }
  }
  const list = [...byId.values()];
  if (!q) return list;

  return list
    .map((r) => {
      const hay = [
        r.workflow.id,
        r.workflow.title,
        r.workflow.description,
        r.workflow.site_id,
        ...(r.workflow.tags ?? []),
        ...(r.workflow.aliases ?? []),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      let score = 0;
      if (r.workflow.id === q) score += 100;
      if (r.workflow.id.includes(q)) score += 50;
      if (hay.includes(q)) score += 20;
      for (const part of q.split(/\s+/)) {
        if (hay.includes(part)) score += 5;
      }
      return { r, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.r);
}

export function bumpVersion(v: string, kind: "patch" | "minor"): string {
  const parts = v.split(".").map(Number);
  if (kind === "patch") parts[2]++; else { parts[1]++; parts[2] = 0; }
  return parts.join(".");
}

export function validateWorkflowShape(wf: Workflow): string[] {
  const errors: string[] = [];
  if (!/^web\/[a-z0-9-]+\/[a-z0-9-]+$/.test(wf.id)) {
    errors.push(`id must match web/<site_id>/<workflow_id>, got ${wf.id}`);
  }
  if (!/^\d+\.\d+\.\d+$/.test(wf.version)) {
    errors.push(`version must be semver x.y.z, got ${wf.version}`);
  }
  if (!wf.site_id) errors.push("site_id required");
  if (!wf.origins?.length) errors.push("origins required");
  if (!wf.steps?.length) errors.push("steps required");
  const idSite = wf.id.split("/")[1];
  if (wf.site_id && idSite && wf.site_id !== idSite) {
    errors.push(`site_id ${wf.site_id} does not match id segment ${idSite}`);
  }
  return errors;
}
