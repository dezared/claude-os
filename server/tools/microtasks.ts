// A microtask is a template file: title, optional free-text input, prompt. The web side fills it in and sends it to a chosen session.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Microtask } from '../../shared/contract.ts';
import type { Ctx } from '../context.ts';
import { httpError, parseFrontmatter, safely } from '../memory/util.ts';

// Where each template runs. owner: the user opened it and reads the answer, in the root tab or a tab of its own, through
// MicrotaskDialog or the crash flow. service: automatic, nobody answers it, so it goes to the hidden service session.
export const MICROTASK_ROUTES: Record<string, 'owner' | 'service'> = {
  'admin-claude-md': 'owner',
  'admin-hooks': 'owner',
  'admin-mcp': 'owner',
  'admin-plugins': 'owner',
  'admin-settings': 'owner',
  'admin-skills': 'owner',
  'admin-usage': 'owner',
  'admin-vault': 'owner',
  'crash-fix': 'owner',
  'git-fix': 'owner',
  'ide-search': 'owner',
  'obsidian-install': 'owner',
  'panel-change': 'owner',
  'planner-decompose': 'service',
  'planner-file': 'service',
  'project-check': 'owner',
  'project-icons': 'owner',
  'project-kit': 'owner',
  'quick-start': 'service',
  'widget-change': 'owner',
  'widget-create': 'owner',
};

// Tools a service template gets on top of SERVICE_TASK_TOOLS. Keyed by template, so only that job has them.
export const MICROTASK_TOOLS: Record<string, readonly ('resume_session' | 'create_project')[]> = {
  'quick-start': ['resume_session', 'create_project'],
};

export function listMicrotasks(ctx: Ctx): Microtask[] {
  const dir = join(ctx.paths.root, 'microtasks');
  const out: Microtask[] = [];
  for (const name of safely(() => readdirSync(dir), [])) {
    if (!name.endsWith('.md')) continue;
    const { data, body } = parseFrontmatter(safely(() => readFileSync(join(dir, name), 'utf8'), ''));
    if (!data.title || !body.trim()) continue;
    out.push({ id: name.slice(0, -3), title: data.title, titleRu: data.title_ru || data.title, input: data.input || null, prompt: body.trim() });
  }
  return out;
}

// One pass: what a note says about {today} stays its own text.
export function servicePrompt(ctx: Ctx, id: string, vars: Record<string, string>): string {
  const template = MICROTASK_ROUTES[id] === 'service' ? listMicrotasks(ctx).find((m) => m.id === id) : undefined;
  if (!template) throw httpError(500, `no service template ${id}`);
  return template.prompt.replace(/\{(\w+)\}/g, (m, name: string) => vars[name] ?? m);
}
