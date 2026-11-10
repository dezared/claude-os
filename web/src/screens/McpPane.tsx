import { ChevronRight, CircleAlert, CircleCheck, FilePlus2, KeyRound, Plug, Plus, RefreshCw, Repeat, ShieldAlert, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ClaudeMark } from '@/components/ClaudeMark';
import { ContextArea } from '@/components/ContextMenu';
import { ProjectSelect } from '@/components/ProjectSelect';
import { Boundary, Empty, ErrorState, Skeleton, Spinner } from '@/components/states';
import { Button, Checkbox, Dialog, Field, IconButton, Input, Segmented, Select, Textarea } from '@/components/ui';
import { spendNote } from '@/lib/account';
import { api, invalidateTopics, setCached, useApi } from '@/lib/api';
import { cn, fmtAgo, fmtInt } from '@/lib/format';
import { toast, toastError, useApp } from '@/lib/store';
import type { McpAdminRow, McpReport, McpServer, McpServerDetails, McpToolInfo, Project } from '@/lib/types';
import { t } from '@/lib/i18n';
import { useProjectColors } from '@/lib/projectColors';
import { addMcpViaClaude, analyzeItem, mcpMenu } from './admin/menus';
import { Bar, McpStatus, PanelBar, ProjectGroups, SectionHead, SourceTag, Stat, StatStrip, Tag, type Scope } from './admin/parts';
import { confirmRemoveMcp } from './admin/RemoveDialogs';

const scopeLabel = { user: 'adm.scopeGlobal', project: 'adm.scopeShared', local: 'adm.scopeLocal', plugin: 'adm.scopePlugin' } as const;

function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return env;
}

function buildJson(transport: string, command: string, url: string, envText: string): string {
  const env = parseEnv(envText);
  const hasEnv = Object.keys(env).length > 0;
  if (transport === 'stdio') {
    const [cmd, ...args] = command.trim().split(/\s+/);
    return JSON.stringify({ type: 'stdio', command: cmd, args, ...(hasEnv ? { env } : {}) });
  }
  return JSON.stringify({ type: transport, url: url.trim() });
}

function AddServer({ onClose }: { onClose: () => void }) {
  const [mode, setMode] = useState<'form' | 'json'>('form');
  const [name, setName] = useState('');
  const [scope, setScope] = useState<string | null>('user');
  const [transport, setTransport] = useState<string | null>('stdio');
  const [command, setCommand] = useState('');
  const [url, setUrl] = useState('');
  const [env, setEnv] = useState('');
  const [json, setJson] = useState('{\n  "type": "stdio",\n  "command": "",\n  "args": []\n}');
  const [project, setProject] = useState<string | null>(null);
  const projects = useApi<Project[]>('/api/projects', ['projects']);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const needsProject = scope === 'project' || scope === 'local';
  const payload = mode === 'json' ? json : buildJson(transport ?? 'stdio', command, url, env);
  let jsonOk = true;
  try {
    JSON.parse(payload);
  } catch {
    jsonOk = false;
  }
  const filled = mode === 'json' ? jsonOk : transport === 'stdio' ? !!command.trim() : !!url.trim();
  const valid = !!name.trim() && filled && confirmed && (!needsProject || !!project);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={t('mcp.addTitle')} description={t('mcp.addDesc')} width={560}>
      <form
        className="flex flex-col gap-3"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!valid) return;
          setBusy(true);
          setError(null);
          try {
            await api('/api/mcp', { method: 'POST', body: { name: name.trim(), scope, json: payload, confirmed: true, project: needsProject ? project : undefined } });
            invalidateTopics(['mcp']);
            toast(t('mcp.added', { name: name.trim() }));
            onClose();
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {error && <ErrorState message={error} />}
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('mcp.name')}>
            <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} className="font-mono text-xs" spellCheck={false} />
          </Field>
          <Field label={t('mcp.scope')}>
            <Select
              className="w-full"
              ariaLabel={t('mcp.scope')}
              value={scope}
              onChange={setScope}
              options={[
                { value: 'user', label: t('mcp.user') },
                { value: 'project', label: t('mcp.project') },
                { value: 'local', label: t('mcp.local') },
              ]}
            />
          </Field>
        </div>
        {needsProject && (
          <Field label={t('mcp.projectField')}>
            <ProjectSelect
              className="w-full"
              ariaLabel={t('mcp.projectAria')}
              value={project}
              onChange={setProject}
              projects={projects.data ?? []}
              extra={[{ value: null, label: t('mcp.pickProject') }]}
            />
          </Field>
        )}
        <Segmented
          ariaLabel={t('mcp.inputAria')}
          value={mode}
          onChange={setMode}
          options={[
            { value: 'form', label: t('mcp.form') },
            { value: 'json', label: 'JSON' },
          ]}
        />
        {mode === 'form' ? (
          <>
            <Field label={t('mcp.transport')}>
              <Select
                className="w-full"
                ariaLabel={t('mcp.transport')}
                value={transport}
                onChange={setTransport}
                options={[
                  { value: 'stdio', label: t('mcp.stdio') },
                  { value: 'http', label: 'http' },
                  { value: 'sse', label: 'sse' },
                ]}
              />
            </Field>
            {transport === 'stdio' ? (
              <>
                <Field label={t('mcp.command')}>
                  <Input value={command} onChange={(e) => setCommand(e.target.value)} className="font-mono text-xs" spellCheck={false} />
                </Field>
                <Field label={t('mcp.env')} hint={t('mcp.envHint')}>
                  <Textarea rows={2} value={env} onChange={(e) => setEnv(e.target.value)} className="font-mono text-xs" spellCheck={false} />
                </Field>
              </>
            ) : (
              <Field label="URL">
                <Input value={url} onChange={(e) => setUrl(e.target.value)} className="font-mono text-xs" spellCheck={false} />
              </Field>
            )}
          </>
        ) : (
          <Field label={t('mcp.jsonLabel')} hint={jsonOk ? undefined : t('mcp.jsonBad')}>
            <Textarea rows={7} value={json} onChange={(e) => setJson(e.target.value)} className="font-mono text-xs" spellCheck={false} />
          </Field>
        )}
        <div className="rounded-md border border-accent-deep bg-accent-bg p-3">
          <div className="mb-2 flex items-center gap-2 text-xs text-soft">
            <ShieldAlert size={13} className="text-accent" />
            {t('mcp.warning')}
          </div>
          <Checkbox checked={confirmed} onChange={setConfirmed}>
            {t('mcp.trust')}
          </Checkbox>
        </div>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" variant="primary" disabled={!valid || busy}>
            {t('mcp.add')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

const errorText = (e: string | null) => (e === 'folder_gone' ? t('adm.mcpFolderGone') : e);

function placeOf(row: McpAdminRow): string {
  const place = row.statusBy.find((x) => x.status === 'connected') ?? row.statusBy[0];
  return place?.place ?? 'global';
}

function Definition({ s }: { s: McpServer }) {
  const { nameOf } = useProjectColors();
  return (
    <div className="flex items-center gap-3 border-t border-line2 py-1.5">
      <span className="w-20 flex-none text-[11px] text-dim">{t(scopeLabel[s.scope])}</span>
      <div className="min-w-0 flex-1">
        <div className="selectable truncate font-mono text-[11px] text-muted" title={s.summary}>{s.summary}</div>
        {s.envKeys.length > 0 && <div className="truncate text-[11px] text-dim">{t('mcp.vars', { list: s.envKeys.join(', ') })}</div>}
      </div>
      {s.scope !== 'plugin' && <IconButton label={t('mcp.remove', { name: s.name })} className="size-6" onClick={() => confirmRemoveMcp(s.name, [s], nameOf)}><Trash2 size={12} /></IconButton>}
    </div>
  );
}

function ToolList({ tools }: { tools: McpToolInfo[] }) {
  return (
    <div className="grid gap-x-6 gap-y-1 app:grid-cols-2">
      {tools.map((tool) => (
        <div key={tool.name} className="min-w-0 text-xs">
          <span className="flex items-center gap-1.5">
            <code className="selectable truncate font-mono text-[11.5px] text-soft">{tool.name}</code>
            {tool.readOnly && <Tag tone="ok">{t('adm.readOnly')}</Tag>}
            {tool.destructive && <Tag tone="bad">{t('adm.destructive')}</Tag>}
          </span>
          {tool.description && <p className="selectable line-clamp-2 text-[11px] leading-[1.4] text-dim" title={tool.description}>{tool.description}</p>}
        </div>
      ))}
    </div>
  );
}

export function Details({ row, className = 'enter-fade flex flex-col gap-3 pt-1 pb-3 pl-[150px]' }: { row: McpAdminRow; className?: string }) {
  const q = useApi<McpServerDetails>(row.where.account ? null : `/api/admin/mcp/details?name=${encodeURIComponent(row.name)}&place=${encodeURIComponent(placeOf(row))}`);
  const d = q.data;
  const tools = d?.tools.length ? d.tools : row.tools;
  const describes = d?.instructions ?? row.description;
  const loading = q.loading && !row.where.account;
  return (
    <div className={className}>
      <div>
        <SectionHead title={t('adm.mcpWhat')} />
        {describes ? <p className="selectable max-w-4xl text-xs leading-[1.55] whitespace-pre-wrap text-muted">{describes}</p> : loading ? <Skeleton lines={2} /> : (
          <p className="text-xs text-dim">{d?.reason === 'needs_login' ? t('adm.mcpNoDescLogin') : d?.reason === 'not_connected' ? t('adm.mcpNoDescOffline') : t('adm.mcpNoDesc')}</p>
        )}
      </div>
      {tools.length > 0 && (
        <div>
          <SectionHead title={t('adm.mcpTools', { n: fmtInt(tools.length) })} />
          <ToolList tools={tools} />
        </div>
      )}
      {row.statusBy.length > 1 && (
        <div>
          <SectionHead title={t('adm.mcpByPlace')} />
          {row.statusBy.map((x) => (
            <div key={x.place} className="flex items-center gap-3 py-0.5 text-xs">
              <span className="w-44 truncate text-muted">{x.place === 'global' ? t('adm.scopeGlobal') : x.place.split('/').at(-1)}</span>
              <McpStatus status={x.status} />
              {x.error && <span className="truncate text-[11px] text-dim" title={errorText(x.error) ?? undefined}>{errorText(x.error)}</span>}
            </div>
          ))}
        </div>
      )}
      {row.error && row.statusBy.length <= 1 && <p className="selectable text-xs text-bad">{errorText(row.error)}</p>}
      {row.definitions.length > 0 && (
        <div>
          <SectionHead title={t('adm.mcpConfig')} />
          {row.definitions.map((s) => <Definition key={`${s.scope}:${s.project ?? ''}`} s={s} />)}
        </div>
      )}
    </div>
  );
}

async function login(row: McpAdminRow) {
  try {
    const place = placeOf(row);
    const r = await api<{ command: string }>(`/api/mcp/${encodeURIComponent(row.name)}/login`, { method: 'POST', body: { project: place === 'global' ? undefined : place } });
    toast(t('adm.mcpLoginStarted', { command: r.command }));
  } catch (e) {
    toastError(e);
  }
}

function Where({ row }: { row: McpAdminRow }) {
  const { global, plugin, account, projects } = row.where;
  // The report says local or shared per definition, not per place: unknown stays the plain "only in this project".
  const kindIn = (key: string | null) => {
    const scope = row.definitions.find((d) => key !== null && d.project === key)?.scope;
    return scope === 'local' || scope === 'project' ? scope : 'in-project';
  };
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1">
      {global && <SourceTag kind="global" />}
      {account && <SourceTag kind="account" />}
      {plugin && <SourceTag kind="plugin" name={plugin} />}
      {projects.slice(0, 3).map((p) => <SourceTag key={p.key ?? p.name} kind={kindIn(p.key)} project={p.key} name={p.name} />)}
      {projects.length > 3 && <span className="text-[11px] text-dim" title={projects.map((p) => p.name).join(', ')}>{t('adm.more', { n: projects.length - 3 })}</span>}
      {row.note && <Tag tone="warn" title={row.note}>{row.note}</Tag>}
    </span>
  );
}

export function ServerRow({ row, maxCalls, onProjects }: { row: McpAdminRow; maxCalls: number; onProjects?: () => void }) {
  const [open, setOpen] = useState(false);
  const { nameOf } = useProjectColors();
  const shownName = row.name.replace(/^plugin:[^:]+:/, '').replace(/^claude\.ai /, '');
  return (
    <ContextArea items={() => mcpMenu(row, { onProjects, nameOf })} className="block border-b border-line2 px-5">
      <div className="grid grid-cols-[130px_minmax(0,1fr)_minmax(0,1.2fr)_70px_100px_auto] items-center gap-3 py-2">
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} aria-label={t('adm.mcpExpand', { name: row.name })} className="press flex min-w-0 items-center gap-1.5 rounded text-left">
          <ChevronRight size={12} className={cn('flex-none text-dim transition-transform duration-150', open && 'rotate-90')} />
          <McpStatus status={row.status} />
        </button>
        <button type="button" onClick={() => useApp.getState().go({ kind: 'entity', type: 'mcp', id: row.name })} className="press min-w-0 rounded text-left" title={errorText(row.error) ?? row.name}>
          <span className="block truncate font-mono text-xs text-soft">{shownName}</span>
          <span className="block truncate text-[11px] text-dim">{row.serverInfo ? `${row.serverInfo.name} ${row.serverInfo.version}` : errorText(row.error) ?? row.definitions[0]?.transport ?? ''}</span>
        </button>
        <Where row={row} />
        <span className="text-right text-xs text-muted" title={t('adm.mcpToolsHint')}>{row.tools.length > 0 ? t('adm.toolsShort', { n: fmtInt(row.tools.length) }) : ''}</span>
        <span className="text-right text-xs" title={row.lastCall ? t('adm.lastCall', { at: fmtAgo(row.lastCall) }) : t('adm.noCalls')}>
          <span className={row.calls > 0 ? 'text-soft' : 'text-dim'}>{fmtInt(row.calls)}</span>
          <Bar className="mt-0.5" value={row.calls} max={maxCalls} color="var(--color-accent)" />
        </span>
        <span className="flex w-28 justify-end">
          {row.status === 'needs-auth' && <Button size="sm" onClick={() => login(row)}><KeyRound size={11} className="text-warn" />{t('adm.mcpLogin')}</Button>}
        </span>
      </div>
      {open && <Details row={row} />}
    </ContextArea>
  );
}

const STALE_MS = 5 * 60_000;
const FOCUS_RECHECK_MS = 20_000;

export function McpPane() {
  const report = useApi<McpReport>('/api/admin/mcp', ['mcp']);
  const [adding, setAdding] = useState(false);
  const [scope, setScope] = useState<Scope>('global');
  const [busy, setBusy] = useState(false);
  const lastFocus = useRef(0);

  const probe = useCallback(async (project?: string) => {
    setBusy(true);
    try {
      const next = await api<McpReport>('/api/admin/mcp/status', { method: 'POST', body: { project } });
      setCached<McpReport>('/api/admin/mcp', () => next);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  }, []);

  const at = report.data?.probes.global?.at ?? null;
  const loaded = report.data !== undefined;
  useEffect(() => {
    if (loaded && (!at || Date.now() - at > STALE_MS)) void probe('*');
    // Once per visit to the panel: the probe starts the configured servers, place by place; the rows fill in as they answer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  // Back from a login in the terminal: only the places still waiting for one are asked again.
  const authPlaces = [...new Set((report.data?.rows ?? []).flatMap((r) => r.statusBy.filter((x) => x.status === 'needs-auth').map((x) => x.place)))].join('|');
  useEffect(() => {
    if (!authPlaces) return;
    const onFocus = () => {
      if (Date.now() - lastFocus.current < FOCUS_RECHECK_MS) return;
      lastFocus.current = Date.now();
      for (const place of authPlaces.split('|')) void probe(place === 'global' ? undefined : place);
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [authPlaces, probe]);

  const items = () => {
    const rows = report.data?.rows ?? [];
    const context = rows.map((x) => `- ${x.name}: ${x.status}; ${x.where.global ? 'global' : ''}${x.where.plugin ? ` plugin ${x.where.plugin}` : ''}${x.where.projects.length ? ` projects: ${x.where.projects.map((p) => p.name).join(', ')}` : ''}; ${x.calls} calls in ${report.data?.windowDays ?? 30} days`).join('\n');
    return [
      { id: 'mcp.addClaude', label: t('ent.addMcp'), icon: Plus, onSelect: addMcpViaClaude },
      { id: 'mcp.addForm', label: t('ent.addMcpForm'), icon: FilePlus2, onSelect: () => setAdding(true) },
      analyzeItem(t('ent.analyzeMcp'), 'MCP server list', 'MCP servers', context, [t('ent.presetMcpsIdle'), t('ent.presetMcpsBroken'), t('ent.presetMcpsScopes')]),
    ];
  };

  return (
    <ContextArea items={items} className="min-h-0 flex-1 overflow-auto">
      <Boundary query={report} skeleton={<Skeleton className="p-5" lines={8} />}>
        {(r) => {
          const count = (s: McpReport['rows'][number]['status']) => r.rows.filter((x) => x.status === s).length;
          const auth = r.rows.filter((x) => x.status === 'needs-auth');
          const calls = r.rows.reduce((a, x) => a + x.calls, 0);
          const maxCalls = Math.max(1, ...r.rows.map((x) => x.calls));
          const probeAt = r.probes.global?.at;
          return (
            <>
              <PanelBar scope={scope} onScope={setScope}>
                <span className="mr-1 text-[11px] text-dim">{busy || r.probing ? t('adm.mcpChecking') : probeAt ? t('adm.mcpCheckedAt', { at: fmtAgo(probeAt) }) : ''}</span>
                <Button disabled={busy || r.probing} onClick={() => probe('*')}>
                  {busy || r.probing ? <Spinner size={11} /> : <RefreshCw size={11} />}{t('adm.mcpCheck')}
                </Button>
                <Button onClick={addMcpViaClaude} title={spendNote()}><ClaudeMark size={12} />{t('ent.addMcp')}</Button>
              </PanelBar>
              {r.probes.global?.error && <ErrorState className="m-5 mb-0" message={r.probes.global.error} />}
              {auth.length > 0 && (
                <div role="status" className="flex flex-wrap items-center gap-3 border-b border-line2 bg-warn/[.07] px-5 py-2 text-xs">
                  <KeyRound size={13} className="flex-none text-warn" />
                  <span className="text-soft">{t('adm.mcpAuthBanner', { n: fmtInt(auth.length) })}</span>
                  <span className="flex flex-wrap gap-2">
                    {auth.map((a) => <Button key={a.name} size="sm" onClick={() => login(a)}>{t('adm.mcpLoginTo', { name: a.name.replace(/^plugin:[^:]+:/, '') })}</Button>)}
                  </span>
                </div>
              )}
              {scope === 'projects' ? (
                <ProjectGroups rows={r.projects} unit={t('adm.unitServers')} empty={t('adm.noProjectMcp')}>
                  {(p) => r.rows.filter((row) => row.definitions.some((d) => d.project === p.project || d.project === p.root)).map((row) => <ServerRow key={row.name} row={row} maxCalls={maxCalls} />)}
                </ProjectGroups>
              ) : r.rows.length === 0 ? <Empty className="m-5" icon={Plug}>{t('mcp.none')}</Empty> : (
                <>
                  <StatStrip cols={5}>
                    <Stat hero icon={Plug} tone="accent" label={t('adm.mcpTotal')} value={fmtInt(r.rows.length)} />
                    <Stat icon={CircleCheck} tone="ok" label={t('adm.mcpConnected')} value={fmtInt(count('connected'))} />
                    <Stat icon={KeyRound} tone={auth.length ? 'warn' : undefined} label={t('adm.mcpNeedsAuth')} value={fmtInt(auth.length)} />
                    <Stat icon={CircleAlert} tone={count('failed') ? 'bad' : undefined} label={t('adm.mcpFailed')} value={fmtInt(count('failed'))} hint={t('adm.mcpOther', { n: fmtInt(count('not-loaded') + count('disabled') + count('unchecked') + count('pending')) })} />
                    <Stat icon={Repeat} label={t('adm.callsIn', { n: r.windowDays })} value={fmtInt(calls)} hint={t('adm.fromJournals')} />
                  </StatStrip>
                  <div className="sheet-bar sticky top-11 z-[5] grid grid-cols-[130px_minmax(0,1fr)_minmax(0,1.2fr)_70px_100px_112px] gap-3 border-b border-line2 px-5 py-1.5 text-[11px] text-dim">
                    <span>{t('adm.colStatus')}</span>
                    <span>{t('adm.colServer')}</span>
                    <span>{t('adm.colWhere')}</span>
                    <span className="text-right">{t('adm.colTools')}</span>
                    <span className="text-right">{t('adm.colCalls', { n: r.windowDays })}</span>
                    <span />
                  </div>
                  {r.rows.map((row) => <ServerRow key={row.name} row={row} maxCalls={maxCalls} onProjects={() => setScope('projects')} />)}
                  {r.gone.length > 0 && (
                    <p className="px-5 py-3 text-[11px] leading-[1.5] text-dim">{t('adm.mcpGone', { list: r.gone.map((g) => `${g.name} (${g.calls})`).join(', ') })}</p>
                  )}
                </>
              )}
            </>
          );
        }}
      </Boundary>
      {adding && <AddServer onClose={() => setAdding(false)} />}
    </ContextArea>
  );
}
