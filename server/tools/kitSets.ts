// The kits screen: every plugin folder that carries a project kit, what each writes into a project, which projects
// have which kit, and the history of applies. Only reads: the kits change through their plugins and the kit flow.
import { readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { KitContents, KitHistoryEntry, KitProjectRow, KitSetsReport } from '../../shared/projectKit.ts';
import type { Ctx } from '../context.ts';
import { safely } from '../memory/util.ts';
import { validateManifest, type KitTemplate } from './osPluginManifest.ts';
import { readLock } from './kitPlan.ts';
import { defaultKit, lockKit, type KitPlugin } from './projectKit.ts';

type Folder = { id: string; dir: string };
const HISTORY_LIMIT = 100;
const ACTIONS = new Set(['install', 'update', 'remove']);

// `claude/skills/spec/SKILL.md` -> `spec`, `claude/kit/hooks/stop-gate.mjs` -> `stop-gate`.
const stem = (path: string, depth: number) => path.split('/')[depth].replace(/\.[^.]+$/, '');

/** Template paths sorted by what they become in a project; the shipped index names them under `claude/` and `docs/`. */
export function kitContents(index: KitTemplate[]): KitContents {
  const out: KitContents = { claudeMd: false, rules: [], agents: [], skills: [], checks: [], hooks: [], docs: [] };
  for (const { path } of index) {
    if (path === 'CLAUDE.md.tpl') out.claudeMd = true;
    else if (path.startsWith('claude/rules/')) out.rules.push(stem(path, 2));
    else if (path.startsWith('claude/agents/')) out.agents.push(stem(path, 2));
    else if (path.startsWith('claude/skills/')) out.skills.push(stem(path, 2));
    else if (path.startsWith('claude/kit/hooks/')) out.hooks.push(stem(path, 3));
    else if (path.startsWith('claude/kit/')) out.checks.push(stem(path, 2));
    else out.docs.push(path);
  }
  return out;
}

function readIndex(kitDir: string): KitTemplate[] {
  return safely(() => JSON.parse(readFileSync(join(kitDir, 'files.json'), 'utf8')) as KitTemplate[], []);
}

/** The audit rows `project.kit` (one per apply, newest first) as history entries; a row that does not parse is left out. */
export function kitHistory(rows: { at: number; target: string; diff: string | null }[]): KitHistoryEntry[] {
  return rows.flatMap(({ at, target, diff }) => {
    const d = safely(() => JSON.parse(diff ?? '') as Partial<KitHistoryEntry>, null);
    if (!d || typeof d.kit !== 'string' || typeof d.version !== 'string' || !ACTIONS.has(String(d.action))) return [];
    return [{ at, project: target, kit: d.kit, version: d.version, action: d.action as KitHistoryEntry['action'], files: Number(d.files) || 0 }];
  });
}

function auditRows(ctx: Ctx): { at: number; target: string; diff: string | null }[] {
  return safely(() => ctx.db.prepare('SELECT at, target, diff FROM audit_log WHERE action = ? ORDER BY id DESC LIMIT ?').all('project.kit', HISTORY_LIMIT) as unknown as { at: number; target: string; diff: string | null }[], []);
}

// The Claude OS checkout gets no kit (the engine refuses it), so it is not offered; the misc bucket has no folder of its own.
function projectRows(ctx: Ctx): KitProjectRow[] {
  const repo = resolve(ctx.paths.repo);
  return ctx.journal.listProjects(true)
    .filter((p) => !p.misc && resolve(p.root) !== repo && !resolve(p.root).startsWith(`${repo}${sep}`))
    .map((p) => {
      const lock = readLock(p.root);
      return { key: p.key, name: p.name, root: p.root, kit: lockKit(lock), installedAt: lock?.installedAt ?? null };
    });
}

export function kitSetsReport(ctx: Ctx, folders: Folder[], active: KitPlugin[]): KitSetsReport {
  const kits = folders.flatMap(({ id, dir }) => {
    const kit = validateManifest(id, dir).manifest?.kit;
    return kit ? [{ id, contents: kitContents(readIndex(join(dir, kit))) }] : [];
  });
  return { default: defaultKit(active)?.id ?? null, kits, projects: projectRows(ctx), history: kitHistory(auditRows(ctx)) };
}

/** GET /api/project-kit/kits, refreshed on `projectKit` (an apply) and `osPlugins` (a kit plugin enabled, changed or added). */
export function registerKitSets(ctx: Ctx, folders: () => Folder[], active: () => KitPlugin[]): void {
  ctx.app.get('/api/project-kit/kits', async () => kitSetsReport(ctx, folders(), active()));
}
