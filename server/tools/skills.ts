import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { Skill } from '../../shared/contract.ts';
import type { Ctx } from '../context.ts';
import { backupFile, httpError, parseFrontmatter, safely, sha256, unifiedDiff } from '../memory/util.ts';
import { installedPlugins, knownProjects, readClaudeJson, readJson } from './shared.ts';

const NAME = /^[A-Za-z0-9][\w.-]*$/;

function entries(dir: string): string[] {
  return safely(() => readdirSync(dir), []).filter((n) => !n.startsWith('.'));
}

function isSkillDir(dir: string): boolean {
  return existsSync(join(dir, 'SKILL.md'));
}

export function createSkills(ctx: Ctx) {
  const userDir = join(ctx.paths.claudeDir, 'skills');
  const disabledDir = join(ctx.paths.claudeDir, 'skills-disabled');

  let usageMap: NonNullable<ReturnType<typeof readClaudeJson>['skillUsage']> = {};

  function make(scope: Skill['scope'], id: string, dir: string, name: string, source: string | null, disabled: boolean, readOnly: boolean, usageKey: string): Skill {
    const skillFile = join(dir, 'SKILL.md');
    const { data } = parseFrontmatter(safely(() => readFileSync(skillFile, 'utf8'), ''));
    const usage = usageMap[usageKey] ?? usageMap[name];
    const isSymlink = safely(() => lstatSync(dir).isSymbolicLink() || lstatSync(skillFile).isSymbolicLink(), false);
    return { id, name, scope, source, description: data.description ?? null, path: dir, readOnly, disabled, isSymlink, usageCount: usage?.usageCount ?? 0, lastUsedAt: usage?.lastUsedAt ?? null };
  }

  function list(): Skill[] {
    const out = new Map<string, Skill>();
    usageMap = readClaudeJson(ctx).skillUsage ?? {};
    for (const name of entries(userDir)) {
      const dir = join(userDir, name);
      if (isSkillDir(dir)) out.set(`user:${name}`, make('user', `user:${name}`, dir, name, null, false, false, name));
    }
    for (const name of entries(disabledDir)) {
      const dir = join(disabledDir, name);
      if (isSkillDir(dir) && !out.has(`user:${name}`)) out.set(`user:${name}`, make('user', `user:${name}`, dir, name, null, true, false, name));
    }

    for (const { key, root } of knownProjects(ctx)) {
      const source = key ?? basename(root);
      for (const [base, disabled] of [[join(root, '.claude/skills'), false], [join(root, '.claude/skills-disabled'), true]] as const) {
        for (const name of entries(base)) {
          const dir = join(base, name);
          if (!isSkillDir(dir)) continue;
          let id = `project:${source}:${name}`;
          if (out.has(id) && out.get(id)!.path !== dir) id += `~${sha256(root).slice(0, 4)}`;
          if (!out.has(id)) out.set(id, make('project', id, dir, name, source, disabled, false, name));
        }
      }
    }

    // Claude Code loads the same plugin version once, however many projects installed it.
    const seenPaths = new Set<string>();
    for (const plugin of installedPlugins(ctx)) {
      if (seenPaths.has(plugin.installPath)) continue;
      seenPaths.add(plugin.installPath);
      for (const dir of pluginSkillDirs(plugin.installPath)) {
        const { data } = parseFrontmatter(safely(() => readFileSync(join(dir, 'SKILL.md'), 'utf8'), ''));
        const name = data.name || basename(dir);
        const id = `plugin:${plugin.name}:${name}`;
        if (!out.has(id)) out.set(id, make('plugin', id, dir, name, plugin.name, false, true, `${plugin.name}:${name}`));
      }
    }

    // Skills synced from claude.ai: managed elsewhere, so read only. Buckets repeat skills, the first copy wins.
    const synced = join(userDir, 'synced');
    for (const bucket of entries(synced)) {
      for (const name of entries(join(synced, bucket))) {
        const dir = join(synced, bucket, name);
        const id = `plugin:anthropic-skills:${name}`;
        if (isSkillDir(dir) && !out.has(id)) out.set(id, make('plugin', id, dir, name, 'anthropic-skills', false, true, `anthropic-skills:${name}`));
      }
    }
    return [...out.values()];
  }

  function find(id: string): Skill {
    const skill = list().find((s) => s.id === id);
    if (!skill) throw httpError(404, 'skill not found');
    return skill;
  }

  function read(id: string): { skill: Skill; content: string } {
    const skill = find(id);
    return { skill, content: readFileSync(join(skill.path, 'SKILL.md'), 'utf8') };
  }

  function preview(body: { id?: string; name?: string; content?: unknown }): { diff: string } {
    if (typeof body.content !== 'string') throw httpError(400, 'content is required');
    const before = body.id ? read(body.id).content : '';
    return { diff: unifiedDiff(before, body.content, `${body.id ?? body.name ?? 'new'}/SKILL.md`) };
  }

  function create(name: unknown, content: unknown): Skill {
    if (typeof name !== 'string' || !NAME.test(name)) throw httpError(400, 'bad skill name');
    const dir = join(userDir, name);
    if (existsSync(dir) || existsSync(join(disabledDir, name))) throw httpError(409, 'skill already exists');
    const text = typeof content === 'string' && content ? content : template(name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), text);
    ctx.audit('skill.create', join(dir, 'SKILL.md'), unifiedDiff('', text, `${name}/SKILL.md`));
    ctx.invalidate('skills', 'overview');
    return find(`user:${name}`);
  }

  // writeFileSync on the real path: the link stays a link, the shared target gets the change.
  function update(id: string, content: unknown): Skill {
    if (typeof content !== 'string') throw httpError(400, 'content is required');
    const skill = find(id);
    if (skill.readOnly) throw httpError(403, 'read only skill');
    const file = realpathSync(join(skill.path, 'SKILL.md'));
    const before = readFileSync(file, 'utf8');
    if (before === content) return skill;
    backupFile(ctx.paths.data, file);
    writeFileSync(file, content);
    ctx.audit('skill.update', file, unifiedDiff(before, content, `${skill.name}/SKILL.md`));
    ctx.invalidate('skills');
    return find(id);
  }

  // rename moves the link itself. A relative target keeps working: both dirs sit at the same depth.
  function toggle(id: string): Skill {
    const skill = find(id);
    if (skill.readOnly) throw httpError(403, 'read only skill');
    const parent = dirname(skill.path);
    const siblingName = skill.disabled ? 'skills' : 'skills-disabled';
    const target = join(resolve(parent, '..'), siblingName, skill.name);
    if (lstatExists(target)) throw httpError(409, `${target} already exists`);
    mkdirSync(dirname(target), { recursive: true });
    renameSync(skill.path, target);
    ctx.audit(skill.disabled ? 'skill.enable' : 'skill.disable', target, null);
    ctx.invalidate('skills', 'overview');
    return find(id);
  }

  // A linked skill loses only the link: the target is shared. A real folder goes to data/backups first.
  function remove(id: string, confirmed: unknown): { ok: true; backup: string | null } {
    if (confirmed !== true) throw httpError(400, 'confirmed: true is required');
    const skill = find(id);
    if (skill.readOnly) throw httpError(403, 'read only skill');
    let backup: string | null = null;
    if (lstatSync(skill.path).isSymbolicLink()) unlinkSync(skill.path);
    else {
      backup = join(ctx.paths.data, 'backups', new Date().toISOString().replace(/[:.]/g, '-'), skill.path);
      mkdirSync(dirname(backup), { recursive: true });
      cpSync(skill.path, backup, { recursive: true, verbatimSymlinks: true });
      rmSync(skill.path, { recursive: true });
    }
    ctx.audit('skill.delete', skill.path, null);
    ctx.invalidate('skills', 'overview');
    return { ok: true, backup };
  }

  return { list, read, preview, create, update, toggle, remove };
}

function lstatExists(path: string): boolean {
  return safely(() => (lstatSync(path), true), false);
}

// Default `skills/`, a root SKILL.md, and whatever the manifest lists: a dir that is a skill or a dir of skills.
function pluginSkillDirs(installPath: string): string[] {
  const manifest = readJson<{ skills?: string | string[] }>(join(installPath, '.claude-plugin', 'plugin.json'));
  const declared = manifest?.skills ? [manifest.skills].flat() : [];
  const dirs = new Set<string>();
  for (const rel of ['skills', ...declared]) {
    const dir = resolve(installPath, rel);
    if (!dir.startsWith(installPath)) continue;
    if (isSkillDir(dir)) {
      dirs.add(dir);
      continue;
    }
    for (const name of entries(dir)) {
      const sub = join(dir, name);
      if (safely(() => statSync(sub).isDirectory(), false) && isSkillDir(sub)) dirs.add(sub);
    }
  }
  if (isSkillDir(installPath)) dirs.add(resolve(installPath));
  return [...dirs];
}

function template(name: string): string {
  return `---\nname: ${name}\ndescription: \n---\n\n# ${name}\n`;
}
