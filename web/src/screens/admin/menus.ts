// What a right click on a tool offers, wherever the tool is shown. Prompts' kind and context stay in English.
import { ArrowRightLeft, FileText, FolderTree, Package, Trash2, type LucideIcon } from 'lucide-react';
import { claudeItems } from '@/components/ContextMenu';
import type { MenuItem } from '@/home/ActionMenu';
import { t } from '@/lib/i18n';
import { askClaude } from '@/lib/microtask';
import { useApp, type View } from '@/lib/store';
import type { HookAdminRow, McpAdminRow, PluginAdminRow, Skill } from '@/lib/types';
import { confirmRemoveMcp, confirmRemoveSkill } from './RemoveDialogs';

const goItem = (id: string, label: string, icon: LucideIcon, view: View): MenuItem => ({ id, label, icon, onSelect: () => useApp.getState().go(view) });
const openItem = (view: View) => goItem('entity.open', t('ent.open'), FileText, view);

export const projectView = (key: string): View => ({ kind: 'entity', type: 'project', id: key });
export const openProjectItem = (key: string) => openItem(projectView(key));

// ---------- Skills ----------

export const skillView = (s: Pick<Skill, 'id' | 'scope' | 'source'>): View => ({ kind: 'entity', type: 'skill', id: s.id, ...(s.scope === 'project' && s.source ? { project: s.source } : {}) });

export function skillContext(s: Skill): string {
  const scope = s.scope === 'user' ? 'global, available in every project' : s.scope === 'project' ? `only in project ${s.source}` : `from plugin ${s.source}, read only`;
  return [`Scope: ${scope}.`, `Folder: ${s.path}`, s.description && `Description: ${s.description}`, s.disabled && 'Currently disabled.'].filter(Boolean).join('\n');
}

export function skillMenu(s: Skill, { page }: { page?: boolean } = {}): MenuItem[] {
  const [change, ask] = claudeItems(
    { kind: 'skill', name: s.name, context: skillContext(s), project: s.scope === 'project' ? s.source : null },
    { changePresets: [t('ent.presetSharpen'), t('ent.presetToGlobal'), t('ent.presetToProject')], askPresets: [t('ask.presetWhat'), t('ent.presetDuplicates'), t('ask.presetProblems')] },
  );
  return [
    ...(page ? [] : [openItem(skillView(s))]),
    ...(s.readOnly ? (s.source ? [goItem('skill.plugin', t('ent.openPlugin', { name: s.source }), Package, { kind: 'entity', type: 'plugin', id: s.source })] : []) : [{ ...change, label: t('ent.update') }]),
    ask,
    ...(s.readOnly ? [] : [{ id: 'skill.delete', label: t('ent.delete'), icon: Trash2, danger: true, onSelect: () => confirmRemoveSkill(s) }]),
  ];
}

/** Where only the name is known, like a line of the usage log. */
export function skillNameMenu(name: string): MenuItem[] {
  const [, ask] = claudeItems({ kind: 'skill', name });
  return [openItem({ kind: 'entity', type: 'skill', id: name }), ask];
}

export function writeSkill(project?: { key: string | null; name: string; root: string }) {
  const context = project
    ? `Write a new skill for this project only, in ${project.root}/.claude/skills.`
    : 'Write a new global skill in ~/.claude/skills, unless the request clearly belongs to one project; then use that project\'s .claude/skills and say so.';
  askClaude({ subject: { kind: 'skill set', name: project?.name ?? 'global', context, project: project?.key }, intent: 'change', title: t('ent.writeSkill'), presets: [t('ent.presetSkillFromWork'), t('ent.presetSkillIdeas')], placeholder: t('skills.whatFor') });
}

// ---------- MCP ----------

const editable = (row: McpAdminRow) => row.definitions.filter((d) => d.scope !== 'plugin');

export function mcpContext(row: McpAdminRow): string {
  const lines = row.definitions.map((d) => `- ${d.scope}${d.project ? ` in project ${d.project}` : ''}, ${d.file ?? 'file unknown'}: ${d.summary}${d.envKeys.length ? ` (env: ${d.envKeys.join(', ')})` : ''}`);
  return [`Status: ${row.status}.`, row.where.account && 'A claude.ai connector, managed in the account.', row.where.plugin && `Comes from plugin ${row.where.plugin}.`, lines.length > 0 && `Defined in:\n${lines.join('\n')}`].filter(Boolean).join('\n');
}

const KNOWLEDGE = 'Keep what a future session must know about this server (for example that it needs a VPN) where such sessions will read it.';

export function mcpMenu(row: McpAdminRow, { page, onProjects, nameOf }: { page?: boolean; onProjects?: () => void; nameOf?: (key: string) => string } = {}): MenuItem[] {
  const subject = { kind: 'MCP server', name: row.name, context: mcpContext(row), project: row.where.global ? null : row.definitions.find((d) => d.project)?.project ?? null };
  const [change, ask] = claudeItems(
    { ...subject, context: `${subject.context}\n${KNOWLEDGE}` },
    { changePresets: [t('ent.presetVpn'), t('ent.presetMcpUpdate'), t('ent.presetMcpFix')], askPresets: [t('ask.presetWhat'), t('ent.presetMcpWhy'), t('ask.presetProblems')] },
  );
  const writable = editable(row);
  const moves = [...(row.where.global ? [t('ent.presetMoveToProject')] : []), ...(row.where.projects.length > 0 ? [t('ent.presetMoveToGlobal'), t('ent.presetMoveShared')] : [])];
  return [
    ...(page ? [] : [openItem({ kind: 'entity', type: 'mcp', id: row.name }), { id: 'mcp.projects', label: t('ent.mcpByProject'), icon: FolderTree, onSelect: onProjects ?? (() => useApp.getState().go({ kind: 'entity', type: 'mcp', id: row.name })) }]),
    { ...change, label: t('ent.updateOrChange') },
    ...(writable.length > 0 ? [{
      id: 'mcp.move',
      label: t('ent.mcpMove'),
      icon: ArrowRightLeft,
      onSelect: () => askClaude({ subject, intent: 'change' as const, title: t('ent.mcpMoveTitle', { name: row.name }), presets: moves, placeholder: t('ent.mcpMovePlaceholder') }),
    }] : []),
    ask,
    ...(writable.length > 0 ? [{ id: 'mcp.delete', label: t('ent.delete'), icon: Trash2, danger: true, onSelect: () => confirmRemoveMcp(row.name, writable, nameOf) }] : []),
  ];
}

export function addMcpViaClaude() {
  askClaude({
    subject: { kind: 'MCP server list', name: 'MCP servers', context: `Add the server through \`claude mcp add-json\`, in the scope the request asks for; global if it does not say. A server that does not exist yet can be written and kept inside this Claude OS installation. ${KNOWLEDGE}` },
    intent: 'change',
    title: t('ent.addMcp'),
    presets: [t('ent.presetMcpConnect'), t('ent.presetMcpWrite')],
    placeholder: t('ent.addMcpPlaceholder'),
  });
}

// ---------- Hooks ----------

export const hookId = (h: HookAdminRow) => [h.file, h.event, h.matcher ?? '', h.summary].join('\n');
export const hookTitle = (h: HookAdminRow) => (h.matcher ? `${h.event} · ${h.matcher}` : h.event);

export function hookContext(h: HookAdminRow): string {
  const scope = h.scope === 'plugin' ? `from plugin ${h.plugin}` : h.scope === 'user' ? 'global, runs in every project' : `only in project ${h.project}`;
  return [`Scope: ${scope}.`, `Settings file: ${h.file}`, `Event: ${h.event}${h.matcher ? `, matcher ${h.matcher}` : ''}.`, `${h.type}: ${h.summary}`].join('\n');
}

export function hookMenu(h: HookAdminRow, { page }: { page?: boolean } = {}): MenuItem[] {
  const view: View = { kind: 'entity', type: 'hook', id: hookId(h), ...(h.project ? { project: h.project } : {}) };
  const [change, ask] = claudeItems({ kind: 'hook', name: hookTitle(h), context: hookContext(h), project: h.project }, { changePresets: [t('ent.presetHookRemove'), t('ent.presetHookNarrow')], askPresets: [t('ask.presetWhat'), t('ask.presetProblems')] });
  return [...(page ? [] : [openItem(view)]), ...(h.scope === 'plugin' ? [] : [change]), ask];
}

export function writeHook() {
  askClaude({ subject: { kind: 'hook set', name: 'Claude Code hooks', context: 'Write a new hook in the settings file of the scope the request asks for; global if it does not say.' }, intent: 'change', title: t('ent.writeHook'), placeholder: t('ask.changePlaceholder') });
}

// ---------- Plugins ----------

export function pluginContext(p: PluginAdminRow): string {
  const place = p.enabled ? 'enabled globally' : p.projects.length > 0 ? `installed in projects: ${p.projects.map((x) => x.name).join(', ')}` : 'not enabled';
  return [`Id: ${p.id}, version ${p.version ?? 'unknown'}, ${place}.`, p.description && `Description: ${p.description}`, p.update === true && `An update to ${p.latest ?? 'a newer version'} is available.`].filter(Boolean).join('\n');
}

export function pluginMenu(p: PluginAdminRow, { page }: { page?: boolean } = {}): MenuItem[] {
  const [change, ask] = claudeItems({ kind: 'plugin', name: p.name, context: pluginContext(p) }, { changePresets: [t('ent.presetPluginUpdate'), t('ent.presetPluginOff'), t('ent.presetPluginRemove')], askPresets: [t('ask.presetWhat'), t('ent.presetPluginNeeded')] });
  return [...(page ? [] : [openItem({ kind: 'entity', type: 'plugin', id: p.id })]), { ...change, label: t('ent.update') }, ask];
}

/** The whole list as the subject: analysis asks about it from any row or empty place of the pane. */
export function analyzeItem(label: string, kind: string, name: string, context: string, presets: string[]): MenuItem {
  const [, ask] = claudeItems({ kind, name, context }, { askPresets: presets });
  return { ...ask, id: 'tools.analyze', label };
}
