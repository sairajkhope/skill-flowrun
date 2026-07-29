import fs from "node:fs";
import path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { resolveRefFlexible, bumpVersion } from "./library.js";
import { libraryDirs } from "./paths.js";
import type { Workflow, PromoteOptions } from "./types.js";

export type PromoteResult = {
  ok: boolean;
  ref: string;
  from_version: string;
  to_version: string;
  from_path: string;
  to_path: string;
  pitfalls_removed: string[];
  error?: string;
  git_hints: string[];
};

export function promoteWorkflow(opts: PromoteOptions): PromoteResult {
  const { ref, version, force, root } = opts;

  const record = resolveRefFlexible(root, ref);
  if (!record) {
    return {
      ok: false,
      ref,
      from_version: "",
      to_version: "",
      from_path: "",
      to_path: "",
      pitfalls_removed: [],
      error: `Not found: ${ref}`,
      git_hints: [],
    };
  }

  if (record.layer !== "local") {
    return {
      ok: false,
      ref,
      from_version: record.workflow.version,
      to_version: "",
      from_path: record.path,
      to_path: "",
      pitfalls_removed: [],
      error: `Can only promote from local layer (this workflow is in ${record.layer})`,
      git_hints: [],
    };
  }

  if (!force && !record.workflow.meta?.verified) {
    return {
      ok: false,
      ref,
      from_version: record.workflow.version,
      to_version: "",
      from_path: record.path,
      to_path: "",
      pitfalls_removed: [],
      error: "Workflow has not been verified. Run 'flowrun verify' first, or use --force.",
      git_hints: [],
    };
  }

  const dirs = libraryDirs(root);
  const wf = record.workflow;
  const idParts = wf.id.split("/");
  const siteId = idParts[1];
  const workflowId = idParts[2];
  const relativeDir = path.join("web", siteId, workflowId);
  const targetDir = path.join(dirs.seed, relativeDir);
  const targetPath = path.join(targetDir, "workflow.yaml");

  const fromVersion = wf.version;
  const toVersion = version ?? bumpVersion(fromVersion, "minor");

  const pitfalls_removed: string[] = [];
  if (wf.pitfalls) {
    const kept: string[] = [];
    for (const p of wf.pitfalls) {
      const lower = p.toLowerCase();
      if (
        lower.includes("debug") ||
        lower.includes("wip") ||
        lower.includes("draft") ||
        lower.includes("temp") ||
        lower.includes("hack")
      ) {
        pitfalls_removed.push(p);
      } else {
        kept.push(p);
      }
    }
    wf.pitfalls = kept.length ? kept : undefined;
  }

  wf.version = toVersion;
  wf.meta ??= {};
  wf.meta.promoted = {
    promoted_at: new Date().toISOString(),
    promoted_from: fromVersion,
  };

  fs.mkdirSync(targetDir, { recursive: true });
  const yaml = stringifyYaml(wf, { lineWidth: 120 });
  fs.writeFileSync(targetPath, yaml, "utf8");

  const git_hints = [
    `cd ${root}`,
    `git add ${path.relative(root, targetDir)}`,
    `git rm -r ${path.relative(root, record.path.replace("/workflow.yaml", ""))}`,
    `git commit -m "promote ${wf.id}: ${fromVersion} → ${toVersion}"`,
  ];

  return {
    ok: true,
    ref,
    from_version: fromVersion,
    to_version: toVersion,
    from_path: record.path,
    to_path: targetPath,
    pitfalls_removed,
    git_hints,
  };
}
