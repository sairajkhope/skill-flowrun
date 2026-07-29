import { readFileSync, readdirSync, statSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { parse as parseYaml } from 'yaml';

interface SiteDef {
  site_id: string
  name: string
  aliases?: string[]
  origins?: string[]
  notes?: string
}

interface WorkflowParam {
  type: string
  required?: boolean
  default?: unknown
  description?: string
}

interface WorkflowMetaVerified {
  verified_at: string
  runs: number
  all_passed: boolean
  avg_duration_ms?: number
  params_used?: Record<string, unknown>
  environment?: string
}

interface WorkflowMeta {
  verified?: WorkflowMetaVerified
  promoted?: {
    promoted_at: string
    promoted_from: string
    previous_version?: string
  }
}

interface WorkflowDef {
  id: string
  version: string
  title?: string
  description?: string
  site_id: string
  origins?: string[]
  tags?: string[]
  aliases?: string[]
  params?: Record<string, WorkflowParam>
  requires_vault?: string[]
  steps: Record<string, unknown>[]
  pitfalls?: string[]
  meta?: WorkflowMeta
}

interface WorkflowEntry {
  id: string
  version: string
  title: string
  description: string
  site_id: string
  tags: string[]
  aliases: string[]
  params: { name: string; type: string; required: boolean; default: unknown; description: string }[]
  step_count: number
  verified: boolean
  verified_info: WorkflowMetaVerified | null
  origins: string[]
  pitfalls: string[]
  steps: Record<string, unknown>[]
  updated_at: string
}

interface LibraryIndex {
  $schema: string
  version: number
  generated_at: string
  generator: string
  stats: {
    total_sites: number
    total_workflows: number
    verified: number
  }
  sites: Record<string, { title: string; count: number; verified: number }>
  tags: Record<string, { count: number }>
  workflows: WorkflowEntry[]
}

const ROOT = join(import.meta.dirname, '..', '..', '..');
const SITES_DIR = join(ROOT, 'sites');
const LIBRARY_DIR = join(ROOT, 'library', 'seed');
const DOCS_DIR = join(ROOT, 'docs');

function loadSites(): Map<string, SiteDef> {
  const sites = new Map<string, SiteDef>();
  if (!existsSync(SITES_DIR)) return sites;
  for (const f of readdirSync(SITES_DIR)) {
    if (!f.endsWith('.yaml')) continue;
    const raw = readFileSync(join(SITES_DIR, f), 'utf-8');
    const site = parseYaml(raw) as SiteDef;
    sites.set(site.site_id, site);
  }
  return sites;
}

function gatherWorkflows(sites: Map<string, SiteDef>): WorkflowEntry[] {
  const entries: WorkflowEntry[] = [];
  const webDir = join(LIBRARY_DIR, 'web');
  if (!existsSync(webDir)) return entries;

  for (const siteDir of readdirSync(webDir)) {
    const sitePath = join(webDir, siteDir);
    if (!statSync(sitePath).isDirectory()) continue;
    for (const wfDir of readdirSync(sitePath)) {
      const wfPath = join(sitePath, wfDir, 'workflow.yaml');
      if (!existsSync(wfPath)) continue;
      const raw = readFileSync(wfPath, 'utf-8');
      const wf = parseYaml(raw) as WorkflowDef;

      const id = wf.id || `web/${siteDir}/${wfDir}`;
      const paramsList: WorkflowEntry['params'] = [];
      if (wf.params) {
        for (const [name, p] of Object.entries(wf.params)) {
          paramsList.push({
            name,
            type: p.type,
            required: p.required ?? false,
            default: p.default ?? null,
            description: p.description ?? '',
          });
        }
      }

      const mtime = statSync(wfPath).mtime;
      const verified = !!(wf.meta?.verified?.all_passed && wf.meta.verified.verified_at);

      entries.push({
        id,
        version: wf.version || '0.0.0',
        title: wf.title || '',
        description: wf.description || '',
        site_id: wf.site_id || siteDir,
        tags: wf.tags || [],
        aliases: wf.aliases || [],
        params: paramsList,
        step_count: wf.steps?.length || 0,
        verified,
        verified_info: wf.meta?.verified || null,
        origins: wf.origins || [],
        pitfalls: wf.pitfalls || [],
        steps: wf.steps || [],
        updated_at: mtime.toISOString(),
      });
    }
  }
  return entries;
}

function buildIndex(sites: Map<string, SiteDef>, workflows: WorkflowEntry[]): LibraryIndex {
  const siteStats: Record<string, { title: string; count: number; verified: number }> = {};
  const tagStats: Record<string, { count: number }> = {};
  let verifiedCount = 0;

  for (const w of workflows) {
    const sid = w.site_id;
    if (!siteStats[sid]) {
      siteStats[sid] = {
        title: sites.get(sid)?.name || sid,
        count: 0,
        verified: 0,
      };
    }
    siteStats[sid].count++;
    if (w.verified) {
      verifiedCount++;
      siteStats[sid].verified++;
    }
    for (const t of w.tags) {
      if (!tagStats[t]) tagStats[t] = { count: 0 };
      tagStats[t].count++;
    }
  }

  return {
    $schema: 'https://flowrun.dev/schemas/library-index.schema.json',
    version: 1,
    generated_at: new Date().toISOString(),
    generator: 'flowrun generate-site',
    stats: {
      total_sites: Object.keys(siteStats).length,
      total_workflows: workflows.length,
      verified: verifiedCount,
    },
    sites: siteStats,
    tags: tagStats,
    workflows,
  };
}

function main() {
  const sites = loadSites();
  const workflows = gatherWorkflows(sites);
  const index = buildIndex(sites, workflows);

  if (!existsSync(DOCS_DIR)) {
    mkdirSync(DOCS_DIR, { recursive: true });
    // Also copy index.html if it doesn't exist yet
  }

  writeFileSync(join(DOCS_DIR, 'library-index.json'), JSON.stringify(index, null, 2) + '\n');

  console.log(`Generated library-index.json`);
  console.log(`  Sites: ${index.stats.total_sites}`);
  console.log(`  Workflows: ${index.stats.total_workflows} (${index.stats.verified} verified)`);
  console.log(`  Tags: ${Object.keys(index.tags).length}`);
}

main();