// Project setup panel. Secret values stay on the server: the browser edits a masked text, a masked value left alone keeps the original.
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { ProjectSetup, PromotePreview, PromoteRequest, SetupFile, SetupHook } from '../../shared/contract.ts';
import type { Ctx } from '../context.ts';
import { backupFile, httpError, safely, unifiedDiff } from '../memory/util.ts';
import type { createMcp } from './mcp.ts';
import { maskArg, SECRET_KEY } from './mcp.ts';
import type { createSkills } from './skills.ts';
import { readClaudeJson } from './shared.ts';

const MASK = '***';
const FILES = { project: '.claude/settings.json', local: '.claude/settings.local.json' } as const;
const NO_GLOBAL_KEYS = new Set(['autoMemoryDirectory']); // a project's own path: wrong for every other project
type Scope = keyof typeof FILES;
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

export function maskValue(value: unknown, key = '', secret = false): unknown {
  if (typeof value === 'string') {
    if (secret || SECRET_KEY.test(key)) return MASK;
    return value.split(/(\s+)/).map((p) => (/\s/.test(p) || !p ? p : maskArg(p))).join('');
  }
  if (Array.isArray(value)) return value.map((v) => maskValue(v, key, secret));
  if (isObj(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskValue(v, k, secret || k === 'env' || k === 'headers')]));
  return value;
}

// A leaf that still equals the masked form of the original was not edited.
export function restoreMasked(edited: unknown, original: unknown, key = '', secret = false): unknown {
  if (typeof edited === 'string') return edited === maskValue(original, key, secret) ? original : edited;
  if (Array.isArray(edited)) return edited.map((v, i) => restoreMasked(v, Array.isArray(original) ? original[i] : undefined, key, secret));
  if (isObj(edited)) {
    const from = isObj(original) ? original : {};
    return Object.fromEntries(Object.entries(edited).map(([k, v]) => [k, restoreMasked(v, from[k], k, secret || k === 'env' || k === 'headers')]));
  }
  return edited;
}

const pretty = (v: unknown) => JSON.stringify(v, null, 2) + '\n';

export function readObject(path: string): { value: Obj; text: string; invalid: boolean; exists: boolean } {
  const text = safely(() => readFileSync(path, 'utf8'), null);
  if (text === null) return { value: {}, text: '', invalid: false, exists: false };
  if (!text.trim()) return { value: {}, text, invalid: false, exists: true };
  const parsed = safely(() => JSON.parse(text) as unknown, undefined);
  return isObj(parsed) ? { value: parsed, text, invalid: false, exists: true } : { value: {}, text, invalid: true, exists: true };
}

export function createSetup(ctx: Ctx, skills: ReturnType<typeof createSkills>, mcp: ReturnType<typeof createMcp>) {
  const globalSettings = join(ctx.paths.claudeDir, 'settings.json');

  function rootOf(key: string): string {
    const root = safely(() => ctx.journal.listProjects(true), []).find((p) => p.key === key)?.root;
    if (!root) throw httpError(404, 'unknown project');
    return root;
  }
  const scopeOf = (s: unknown): Scope => {
    if (s !== 'project' && s !== 'local') throw httpError(400, 'scope must be project or local');
    return s;
  };

  function view(key: string): ProjectSetup {
    const root = rootOf(key);
    const settings: SetupFile[] = [];
    const hooks: SetupHook[] = [];
    for (const scope of ['project', 'local'] as const) {
      const path = join(root, FILES[scope]);
      const r = readObject(path);
      const masked = maskValue(r.value) as Obj;
      settings.push({ scope, path, exists: r.exists, text: r.invalid ? '' : r.exists ? pretty(masked) : '{\n}\n', keys: Object.keys(r.value), invalid: r.invalid });
      for (const [event, list] of Object.entries(isObj(r.value.hooks) ? r.value.hooks : {})) {
        if (!Array.isArray(list)) continue;
        list.forEach((h: unknown, index) => {
          if (!isObj(h)) return;
          const commands = Array.isArray(h.hooks) ? h.hooks.filter(isObj).map((c) => String(maskValue(c.command ?? c.type ?? '', 'command'))) : [];
          hooks.push({ scope, event, matcher: typeof h.matcher === 'string' ? h.matcher : null, index, summary: commands.join('; ') });
        });
      }
    }
    return {
      key, root, settings, hooks,
      mcp: mcp.list().filter((s) => (s.scope === 'project' || s.scope === 'local') && (s.project === key || s.project === root)),
      skills: skills.list().filter((s) => s.scope === 'project' && s.source === key),
    };
  }

  function parseEdited(text: unknown): Obj {
    if (typeof text !== 'string') throw httpError(400, 'text is required');
    const parsed = safely(() => JSON.parse(text) as unknown, undefined);
    if (!isObj(parsed)) throw httpError(400, 'not a JSON object');
    return parsed;
  }

  function preview(key: string, scope: unknown, text: unknown): { diff: string } {
    const file = FILES[scopeOf(scope)];
    const r = readObject(join(rootOf(key), file));
    if (r.invalid) throw httpError(409, `${file} is not valid JSON: fix it by hand first`);
    return { diff: unifiedDiff(r.exists ? pretty(maskValue(r.value)) : '', pretty(maskValue(restoreMasked(parseEdited(text), r.value))), file) };
  }

  function save(key: string, scope: unknown, text: unknown): ProjectSetup {
    const s = scopeOf(scope);
    const path = join(rootOf(key), FILES[s]);
    const r = readObject(path);
    if (r.invalid) throw httpError(409, `${FILES[s]} is not valid JSON: fix it by hand first`);
    const next = restoreMasked(parseEdited(text), r.value);
    const diff = unifiedDiff(r.exists ? pretty(maskValue(r.value)) : '', pretty(maskValue(next)), FILES[s]);
    if (diff) {
      backupFile(ctx.paths.data, path);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, pretty(next));
      ctx.audit('project.settings', path, diff);
      ctx.invalidate('skills', 'mcp', 'overview', 'projects');
    }
    return view(key);
  }

  function moveKeyPlan(req: Extract<PromoteRequest, { kind: 'key' | 'hook' }>, root: string) {
    const path = join(root, FILES[scopeOf(req.scope)]);
    const src = readObject(path);
    const dst = readObject(globalSettings);
    if (src.invalid) throw httpError(409, `${path} is not valid JSON`);
    if (dst.invalid) throw httpError(409, `${globalSettings} is not valid JSON`);
    let conflict: string | null = null;
    const nextSrc: Obj = structuredClone(src.value);
    const nextDst: Obj = structuredClone(dst.value);
    if (req.kind === 'key') {
      if (req.key === 'hooks') throw httpError(400, 'hooks move one at a time');
      if (NO_GLOBAL_KEYS.has(req.key)) conflict = `${req.key} belongs to the project`;
      if (!(req.key in src.value)) throw httpError(404, 'no such key');
      if (req.key in dst.value && JSON.stringify(dst.value[req.key]) !== JSON.stringify(src.value[req.key])) conflict = `${req.key} is already set globally to another value`;
      nextDst[req.key] = src.value[req.key];
      delete nextSrc[req.key];
    } else {
      const list = isObj(src.value.hooks) ? src.value.hooks[req.event] : null;
      const hook = Array.isArray(list) ? list[req.index] : undefined;
      if (!isObj(hook)) throw httpError(404, 'no such hook');
      const srcHooks = nextSrc.hooks as Obj;
      const left = (srcHooks[req.event] as unknown[]).filter((_, i) => i !== req.index);
      if (left.length) srcHooks[req.event] = left;
      else delete srcHooks[req.event];
      if (Object.keys(srcHooks).length === 0) delete nextSrc.hooks;
      const dstHooks = isObj(nextDst.hooks) ? nextDst.hooks : (nextDst.hooks = {});
      const target = Array.isArray(dstHooks[req.event]) ? dstHooks[req.event] as unknown[] : [];
      if (target.some((h) => JSON.stringify(h) === JSON.stringify(hook))) conflict = 'the same hook is already global';
      dstHooks[req.event] = [...target, hook];
    }
    return { path, src, dst, nextSrc, nextDst, conflict };
  }

  async function promotePreview(key: string, req: PromoteRequest): Promise<PromotePreview> {
    const root = rootOf(key);
    if (req.kind === 'skill') {
      const skill = view(key).skills.find((s) => s.name === req.name);
      if (!skill) throw httpError(404, 'no such project skill');
      const to = join(ctx.paths.claudeDir, 'skills', req.name);
      const taken = [to, join(ctx.paths.claudeDir, 'skills-disabled', req.name)].some((p) => safely(() => (lstatSync(p), true), false));
      return { title: req.name, files: [{ path: to, diff: `- ${skill.path}\n+ ${to}${skill.isSymlink ? '\n(symlink stays a symlink)' : ''}` }], conflict: taken ? `~/.claude/skills/${req.name} already exists` : null };
    }
    if (req.kind === 'mcp') {
      const server = view(key).mcp.find((s) => s.name === req.name && s.scope === req.scope);
      if (!server) throw httpError(404, 'no such server');
      const exists = req.name in (readClaudeJson(ctx).mcpServers ?? {});
      return {
        title: req.name,
        files: [{ path: 'claude mcp', diff: `- claude mcp remove --scope ${req.scope} ${req.name}\n+ claude mcp add-json --scope user ${req.name} {${server.summary}${server.envKeys.length ? `; env: ${server.envKeys.join(', ')}` : ''}}` }],
        conflict: exists ? `a user-scope server ${req.name} already exists` : null,
      };
    }
    const plan = moveKeyPlan(req, root);
    return {
      title: req.kind === 'key' ? req.key : `${req.event}[${req.index}]`,
      files: [
        { path: plan.path, diff: unifiedDiff(pretty(maskValue(plan.src.value)), pretty(maskValue(plan.nextSrc)), FILES[req.scope]) },
        { path: globalSettings, diff: unifiedDiff(plan.dst.exists ? pretty(maskValue(plan.dst.value)) : '', pretty(maskValue(plan.nextDst)), 'settings.json') },
      ],
      conflict: plan.conflict,
    };
  }

  function moveSkill(from: string, to: string): void {
    const st = lstatSync(from);
    mkdirSync(dirname(to), { recursive: true });
    if (st.isSymbolicLink()) {
      const link = readlinkSync(from);
      // A relative target would break at the new depth.
      symlinkSync(isAbsolute(link) ? link : resolve(dirname(from), link), to);
      unlinkSync(from);
      return;
    }
    try {
      renameSync(from, to);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
      cpSync(from, to, { recursive: true, verbatimSymlinks: true });
      if (!existsSync(join(to, 'SKILL.md'))) throw new Error('copy verification failed');
      rmSync(from, { recursive: true });
    }
  }

  async function promote(key: string, req: PromoteRequest & { confirmed?: unknown }): Promise<ProjectSetup> {
    if (req.confirmed !== true) throw httpError(400, 'confirmed: true is required');
    const root = rootOf(key);
    const pre = await promotePreview(key, req);
    if (pre.conflict) throw httpError(409, pre.conflict);
    if (req.kind === 'skill') {
      const skill = view(key).skills.find((s) => s.name === req.name)!;
      const to = join(ctx.paths.claudeDir, 'skills', req.name);
      moveSkill(skill.path, to);
      ctx.audit('project.promote.skill', to, pre.files[0].diff);
      ctx.invalidate('skills', 'overview');
    } else if (req.kind === 'mcp') {
      const raw = req.scope === 'project'
        ? (readObject(join(root, '.mcp.json')).value.mcpServers as Obj | undefined)?.[req.name]
        : readClaudeJson(ctx).projects?.[root]?.mcpServers?.[req.name];
      if (!isObj(raw)) throw httpError(404, 'server definition not found');
      await mcp.add({ name: req.name, scope: 'user', json: raw, confirmed: true });
      await mcp.remove(req.name, req.scope, key);
      ctx.audit('project.promote.mcp', req.name, pre.files[0].diff);
    } else {
      const plan = moveKeyPlan(req, root);
      backupFile(ctx.paths.data, plan.path);
      backupFile(ctx.paths.data, globalSettings);
      mkdirSync(dirname(globalSettings), { recursive: true });
      writeFileSync(globalSettings, pretty(plan.nextDst));
      writeFileSync(plan.path, pretty(plan.nextSrc));
      ctx.audit(`project.promote.${req.kind}`, plan.path, pre.files.map((f) => f.diff).join('\n'));
      ctx.invalidate('overview');
    }
    return view(key);
  }

  return { view, preview, save, promotePreview, promote };
}
