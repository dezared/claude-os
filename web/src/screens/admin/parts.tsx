import { CircleAlert, CircleCheck, CircleDashed, CircleOff, Globe, KeyRound, LoaderCircle, Puzzle, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { ClaudeMark } from '@/components/ClaudeMark';
import { ContextArea } from '@/components/ContextMenu';
import { ProjectIcon } from '@/components/ProjectIcon';
import { Button, Segmented } from '@/components/ui';
import type { MenuItem } from '@/home/ActionMenu';
import { spendNote } from '@/lib/account';
import { useApi } from '@/lib/api';
import { cn, fmtInt } from '@/lib/format';
import { t } from '@/lib/i18n';
import { runMicrotask } from '@/lib/microtask';
import { prettyModel } from '@/lib/model-name';
import { useProjectColors } from '@/lib/projectColors';
import { useApp } from '@/lib/store';
import type { AdminProjectDiff, McpConnection, PluginAdminRow, PluginsReport } from '@/lib/types';
import { openProjectItem, projectView } from './menus';

export type Scope = 'global' | 'projects';

/** Checked with the dataviz validator on the sheet colour. Every chip also carries its name. */
const MODEL_COLORS: Record<string, string> = { opus: '#d97757', sonnet: '#4f93d9', haiku: '#3faa78', fable: '#9a7fdc' };

export function modelColor(id: string): string {
  const family = /claude-([a-z]+)/.exec(id)?.[1] ?? id.toLowerCase();
  return MODEL_COLORS[family] ?? '#8b8b95';
}

export function ModelChip({ id }: { id: string }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 rounded-[5px] bg-white/[.06] px-1.5 py-px text-soft">
      <i className="block size-2 flex-none rounded-[2px]" style={{ background: modelColor(id) }} />
      <span className="truncate">{prettyModel(id)}</span>
    </span>
  );
}

export function Stat({ icon: Icon, label, value, hint, tone, hero }: { icon?: LucideIcon; label: string; value: string; hint?: ReactNode; tone?: 'ok' | 'warn' | 'bad' | 'accent'; hero?: boolean }) {
  const toneClass = tone === 'ok' ? 'text-ok' : tone === 'warn' ? 'text-warn' : tone === 'bad' ? 'text-bad' : tone === 'accent' ? 'text-accent' : 'text-dim';
  return (
    <div className="min-w-0 border-r border-b border-line2 px-5 py-3.5 last:border-r-0">
      <small className="flex items-center gap-1.5 text-[11.5px] text-muted">
        {Icon && <Icon size={12} className={cn('flex-none', toneClass)} />}
        <span className="truncate">{label}</span>
      </small>
      <b className={cn('mt-0.5 block tracking-[-.025em]', hero ? 'text-[28px] leading-tight font-semibold' : 'text-xl leading-snug font-medium')}>{value}</b>
      {hint && <small className="block text-[11px] leading-[1.35] text-dim">{hint}</small>}
    </div>
  );
}

export function StatStrip({ children, cols }: { children: ReactNode; cols: number }) {
  return <div className="grid grid-cols-2 app:[grid-template-columns:repeat(var(--cols),minmax(0,1fr))]" style={{ '--cols': cols } as React.CSSProperties}>{children}</div>;
}

export function Bar({ value, max, color = 'rgba(255,255,255,.45)', className }: { value: number; max: number; color?: string; className?: string }) {
  const width = max > 0 ? Math.max(value > 0 ? 2 : 0, (value / max) * 100) : 0;
  return (
    <span className={cn('block h-1 overflow-hidden rounded-[2px] bg-white/[.07]', className)}>
      <i className="block h-full rounded-[2px]" style={{ width: `${width}%`, background: color }} />
    </span>
  );
}

export function SectionHead({ icon: Icon, title, aside }: { icon?: LucideIcon; title: string; aside?: ReactNode }) {
  return (
    <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
      <h2 className="flex items-center gap-1.5 text-[12px] font-medium text-soft">
        {Icon && <Icon size={13} className="text-dim" />}
        {title}
      </h2>
      {aside}
    </div>
  );
}

export function AskClaude({ task, vars, project, label, size = 'md' }: { task: string; vars: Record<string, string>; project?: string | null; label?: string; size?: 'sm' | 'md' }) {
  return (
    <Button size={size} title={spendNote()} onClick={() => runMicrotask({ id: task, vars, project: project ?? undefined })}>
      <ClaudeMark size={12} />{label ?? t('adm.ask')}
    </Button>
  );
}

export function PanelBar({ scope, onScope, children }: { scope?: Scope; onScope?: (s: Scope) => void; children?: ReactNode }) {
  return (
    <div className="sheet-bar sticky top-0 z-10 flex min-h-11 flex-wrap items-center gap-2 border-b border-line2 px-5 py-2">
      {scope && onScope && (
        <Segmented ariaLabel={t('adm.scope')} value={scope} onChange={onScope} options={[{ value: 'global', label: t('adm.scopeGlobal') }, { value: 'projects', label: t('adm.scopeProjects') }]} />
      )}
      <span className="flex-1" />
      {children}
    </div>
  );
}

export function Tag({ children, tone, title }: { children: ReactNode; tone?: 'accent' | 'ok' | 'warn' | 'bad' | 'service'; title?: string }) {
  const toneClass = tone === 'accent' ? 'bg-accent-bg text-accent' : tone === 'ok' ? 'bg-ok/12 text-ok' : tone === 'warn' ? 'bg-warn/12 text-warn' : tone === 'bad' ? 'bg-bad/12 text-bad' : tone === 'service' ? 'bg-[#6fa8dc]/12 text-[#6fa8dc]' : 'bg-white/[.07] text-muted';
  return <span title={title} className={cn('inline-block max-w-full flex-none truncate rounded-[5px] px-1.5 text-[11px] leading-[18px]', toneClass)}>{children}</span>;
}

type SourceKind = 'global' | 'account' | 'plugin' | 'in-project' | 'project' | 'local';

function pluginPlace(rows: PluginAdminRow[] | undefined, name: string): string | null {
  const row = rows?.find((p) => p.name === name);
  if (!row) return null;
  if (row.enabled) return t('ent.scopeGlobalHint');
  return row.projects.length > 0 ? t('adm.srcPluginIn', { list: row.projects.map((p) => p.name).join(', ') }) : t('adm.srcPluginOff');
}

/** Where a skill, agent, hook or MCP server comes from: the tag names it, the tooltip adds where it works. Only what the reports hold. */
export function SourceTag({ kind, name, project }: { kind: SourceKind; name?: string | null; project?: string | null }) {
  const { color, keyOf, nameOf } = useProjectColors();
  const plugins = useApi<PluginsReport>(kind === 'plugin' ? '/api/admin/plugins' : null, ['skills', 'settings']);
  const inProject = kind === 'in-project' || kind === 'project' || kind === 'local';
  const key = inProject ? project ?? keyOf(name ?? '') : null;
  const shown = (inProject ? name ?? nameOf(key) : name) ?? t('adm.scopePlugin');
  const tip = kind === 'global' ? t('ent.scopeGlobalHint')
    : kind === 'account' ? t('adm.srcAccount')
    : kind === 'plugin' ? [t('ent.scopePluginHint', { name: shown }), pluginPlace(plugins.data?.rows, shown)].filter(Boolean).join('. ')
    : t(kind === 'local' ? 'ent.scopeLocalHint' : kind === 'project' ? 'ent.scopeSharedHint' : 'ent.scopeProjectHint', { name: shown });
  return (
    <span data-source={kind} title={tip} className="inline-flex max-w-full min-w-0 items-center gap-1 rounded-[5px] bg-white/[.07] px-1.5 text-[11px] leading-[18px] text-muted">
      {kind === 'global' && <Globe size={10} className="flex-none text-dim" />}
      {kind === 'plugin' && <Puzzle size={10} className="flex-none text-dim" />}
      {inProject && <ProjectIcon project={key} name={shown} color={color(key)} size={12} />}
      <span className="min-w-0 truncate">{kind === 'global' ? t('adm.scopeGlobal') : kind === 'account' ? t('adm.whereAccount') : shown}</span>
      {kind === 'local' && <span className="flex-none text-dim">· {t('adm.scopeLocal')}</span>}
    </span>
  );
}

/** A skill or an agent: the report gives a scope and one name, a project key or a plugin. */
export function ScopeSource({ scope, source }: { scope: 'user' | 'project' | 'plugin'; source: string | null }) {
  const { nameOf } = useProjectColors();
  if (scope === 'user') return <SourceTag kind="global" />;
  if (scope === 'plugin') return <SourceTag kind="plugin" name={source} />;
  return <SourceTag kind="in-project" project={source} name={nameOf(source)} />;
}

const STATUS: Record<McpConnection, { icon: LucideIcon; tone: string; label: 'adm.mcpConnected' | 'adm.mcpFailed' | 'adm.mcpNeedsAuth' | 'adm.mcpPending' | 'adm.mcpDisabled' | 'adm.mcpNotLoaded' | 'adm.mcpUnchecked' }> = {
  connected: { icon: CircleCheck, tone: 'text-ok', label: 'adm.mcpConnected' },
  failed: { icon: CircleAlert, tone: 'text-bad', label: 'adm.mcpFailed' },
  'needs-auth': { icon: KeyRound, tone: 'text-warn', label: 'adm.mcpNeedsAuth' },
  pending: { icon: LoaderCircle, tone: 'text-dim', label: 'adm.mcpPending' },
  disabled: { icon: CircleOff, tone: 'text-dim', label: 'adm.mcpDisabled' },
  'not-loaded': { icon: CircleOff, tone: 'text-dim', label: 'adm.mcpNotLoaded' },
  unchecked: { icon: CircleDashed, tone: 'text-dim', label: 'adm.mcpUnchecked' },
};

export const mcpStatusLabel = (s: McpConnection) => t(STATUS[s].label);

export function McpStatus({ status }: { status: McpConnection }) {
  const { icon: Icon, tone } = STATUS[status];
  return <span className={cn('inline-flex items-center gap-1.5 text-xs whitespace-nowrap', tone)}><Icon size={13} className="flex-none" />{t(STATUS[status].label)}</span>;
}

function GroupHead({ r, unit, menu }: { r: AdminProjectDiff; unit: string; menu?: (r: AdminProjectDiff) => MenuItem[] }) {
  const { color, keyOf } = useProjectColors();
  const go = useApp((s) => s.go);
  const key = r.project ?? keyOf(r.name);
  const { project } = r;
  return (
    <ContextArea items={() => [...(project ? [openProjectItem(project)] : []), ...(menu?.(r) ?? [])]}>
      <div className="flex flex-wrap items-center gap-2 border-b border-line2 bg-white/[.03] px-5 py-1.5">
        <ProjectIcon project={key} name={r.name} color={color(key)} size={16} />
        {project ? <button type="button" title={r.root} onClick={() => go(projectView(project))} className="press truncate rounded text-soft hover:text-accent">{r.name}</button> : <span className="truncate text-soft" title={r.root}>{r.name}</span>}
        {r.overrides.length > 0 && <Tag tone="accent" title={r.overrides.join(', ')}>{t('adm.differs', { n: fmtInt(r.overrides.length) })}</Tag>}
        <span className="text-[11px] text-dim">{t('adm.ownCount', { n: fmtInt(r.own.length), unit })}</span>
      </div>
    </ContextArea>
  );
}

/** The same rows as the main view of a pane, under one head per project. A project with nothing of its own simply inherits. */
export function ProjectGroups({ rows, unit, empty, menu, children }: { rows: AdminProjectDiff[]; unit: string; empty: string; menu?: (r: AdminProjectDiff) => MenuItem[]; children: (r: AdminProjectDiff) => ReactNode }) {
  if (rows.length === 0) return <p className="px-5 py-4 text-xs text-muted">{empty}</p>;
  return (
    <div>
      {rows.map((r) => (
        <section key={r.root} aria-label={r.name}>
          <GroupHead r={r} unit={unit} menu={menu} />
          {children(r)}
        </section>
      ))}
    </div>
  );
}

export function MiniBars({ values, labels, height = 44, accentLast }: { values: number[]; labels?: string[]; height?: number; accentLast?: boolean }) {
  const max = Math.max(1, ...values);
  return (
    <div className="flex items-end gap-[2px]" style={{ height }}>
      {values.map((v, i) => (
        <i
          key={i}
          title={labels?.[i]}
          className={cn('block min-w-0 flex-1 rounded-t-[2px]', accentLast && i === values.length - 1 ? 'bg-accent' : 'bg-white/30')}
          style={{ height: `${Math.max(v > 0 ? 3 : 1, (v / max) * 100)}%`, opacity: v > 0 ? 1 : 0.35 }}
        />
      ))}
    </div>
  );
}
