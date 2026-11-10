import { BookOpen, Check, CircleUser, LayoutGrid, Mic, FolderCog, Info, Languages, Settings, ShieldAlert, SlidersHorizontal, SquareTerminal, Stethoscope, UserRound, type LucideIcon } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Breadcrumbs } from '@/components/Breadcrumbs';
import { ClaudeMark } from '@/components/ClaudeMark';
import { desktop, setDesktopPrefs, useDesktopPrefs, type CloseChoice } from '@/components/desktop';
import { OBSIDIAN_DOWNLOAD } from '@/components/ObsidianNotice';
import { ProgramIcon } from '@/components/ProgramIcon';
import { askForIcons, ProjectIcon } from '@/components/ProjectIcon';
import { ProjectSelect } from '@/components/ProjectSelect';
import { Empty, ErrorState, Skeleton, Spinner } from '@/components/states';
import { Button, Checkbox, Dialog, Field, Input, Segmented, Select } from '@/components/ui';
import { spendNote, useAccount } from '@/lib/account';
import { api, invalidateTopics, setCached, useApi } from '@/lib/api';
import { cn, fmtAgo, fmtDateTime, shortPath } from '@/lib/format';
import { languages, serverText, setLang, t, useLang, type Key } from '@/lib/i18n';
import { runMicrotask } from '@/lib/microtask';
import { efforts, modelGroups } from '@/lib/models';
import { useProjectColors } from '@/lib/projectColors';
import { toastError, useApp, type SettingsSection } from '@/lib/store';
import { askMapSetup, setUniverse } from '@/home/universe/menu';
import { DEFAULT_MAP_LIMIT, mapKeys, MAX_MAP_LIMIT } from '@/home/universe/selection';
import { SkyThemes } from '@/home/universe/SkyThemes';
import { EMPTY_HOME, SLOTS, stacks } from '@/home/slots';
import { purgeWidget, restoreWidget, trashWidget, widgetTitle, type Widgets } from '@/home/Widgets';
import type { MemoryGraph, Overview, Profile, Project, ProjectIcons, ProjectIde, QuestionLevel, SettingsView as Settings_, TerminalRun, VoiceStatus } from '@/lib/types';
import { TerminalText } from '@/work/TerminalText';
import { DownloadProgress, enableVoice, fmtMb } from '@/work/voice/VoiceButton';
import { AskClaude, Bar, Tag } from './admin/parts';

const SECTIONS: { id: SettingsSection; label: Key; icon: LucideIcon }[] = [
  { id: 'general', label: 'set.general', icon: SlidersHorizontal },
  { id: 'profile', label: 'settings.profile.title', icon: UserRound },
  { id: 'widgets', label: 'set.widgets', icon: LayoutGrid },
  { id: 'ides', label: 'set.ides', icon: SquareTerminal },
  { id: 'projects', label: 'set.projects', icon: FolderCog },
  { id: 'claude', label: 'set.claude', icon: CircleUser },
  { id: 'notes', label: 'set.notes', icon: BookOpen },
  { id: 'voice', label: 'set.voice', icon: Mic },
  { id: 'about', label: 'set.about', icon: Info },
];

function Head({ title, hint, aside }: { title: string; hint?: string; aside?: ReactNode }) {
  return (
    <header className="mb-4 flex flex-wrap items-start gap-3">
      <div className="min-w-0 flex-1">
        <h2 className="text-[15px] font-medium">{title}</h2>
        {hint && <p className="mt-0.5 text-xs text-dim">{hint}</p>}
      </div>
      {aside && <div className="flex flex-wrap items-center gap-2">{aside}</div>}
    </header>
  );
}

function Row({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-1.5 border-t border-line2 py-2.5 first:border-t-0">
      <div className="min-w-52 flex-1">
        <div className="text-soft">{label}</div>
        {hint && <div className="mt-px text-[11.5px] leading-[1.45] text-dim">{hint}</div>}
      </div>
      <div className="flex min-w-0 items-center gap-2">{children}</div>
    </div>
  );
}

function Rows({ children }: { children: ReactNode }) {
  return <div className="mb-6 rounded-xl bg-white/[.025] px-4 py-1 shadow-[inset_0_0_0_1px_rgba(255,255,255,.055)]">{children}</div>;
}

const onOff = (on: boolean) => t(on ? 'desktop.enabled' : 'desktop.disabled');

// Only the window has a tray and notifications: in a browser there is nothing to set.
function DesktopRows() {
  const prefs = useDesktopPrefs();
  const bridge = desktop();
  if (!bridge) return null;
  return (
    <>
      <Row label={t('desktop.closeSetting')} hint={t('desktop.closeSettingHint')}>
        <Select
          className="w-56"
          ariaLabel={t('desktop.closeSetting')}
          value={prefs.closeChoice}
          onChange={(v) => setDesktopPrefs({ closeChoice: (v ?? 'ask') as CloseChoice })}
          options={[{ value: 'ask', label: t('desktop.closeAsk') }, { value: 'tray', label: t('desktop.keep') }, { value: 'stop', label: t('desktop.stopAll') }]}
        />
      </Row>
      <Row label={t('desktop.notifySetting')} hint={t('desktop.notifyHint')}>
        <Checkbox checked={prefs.notifications} onChange={(v) => setDesktopPrefs({ notifications: v })}>{onOff(prefs.notifications)}</Checkbox>
      </Row>
      {bridge.canFullscreen && (
        <Row label={t('desktop.fullscreenSetting')} hint={t('desktop.fullscreenHint')}>
          <Checkbox checked={prefs.fullscreenMode} onChange={(v) => setDesktopPrefs({ fullscreenMode: v })}>{onOff(prefs.fullscreenMode)}</Checkbox>
        </Row>
      )}
    </>
  );
}

function General({ s }: { s: Settings_ | undefined }) {
  const lang = useLang((s) => s.lang);
  const sky = s?.universe;
  // With a profile the picker shows and sets profile.language (nothing selected for one without a catalog); before it, only the UI.
  const profileLang = s?.profile?.language;
  const choose = (code: string) => {
    if (!s) return; // whether a profile exists is not known yet
    if (profileLang === undefined) setLang(code);
    else if (code !== profileLang) void saveProfile({ language: code });
  };
  return (
    <>
      <Head title={t('set.general')} />
      <Rows>
        <Row label={t('settings.language')} hint={profileLang === undefined ? undefined : t('settings.profile.languageRowHint')}>
          <Languages size={13} className="text-dim" />
          <Segmented ariaLabel={t('settings.language')} value={profileLang ?? lang} onChange={choose} options={languages.map((l) => ({ value: l.code, label: l.label }))} />
        </Row>
        <DesktopRows />
      </Rows>
      {sky && (
        <>
          <Head title={t('set.sky')} hint={t('set.skyHint')} />
          <Rows>
            <SkyThemes options={sky} />
            <Row label={t('universe.crossLinks')}>
              <Checkbox checked={sky.crossLinks} onChange={(crossLinks) => void setUniverse({ crossLinks })}>{onOff(sky.crossLinks)}</Checkbox>
            </Row>
            <Row label={t('universe.nesting')}>
              <Checkbox checked={sky.nesting} onChange={(nesting) => void setUniverse({ nesting })}>{onOff(sky.nesting)}</Checkbox>
            </Row>
          </Rows>
        </>
      )}
    </>
  );
}

// The UI follows the saved profile (main.tsx), so a language change here switches it too.
async function saveProfile(patch: Partial<Profile>): Promise<boolean> {
  try {
    const next = await api<Settings_>('/api/settings/profile', { method: 'PUT', body: patch });
    setCached<Settings_>('/api/settings', () => next);
    return true;
  } catch (e) {
    // The server names the field ("projectsDir: ..."); the row already does.
    toastError(new Error((e as Error).message.replace(/^(name|language|projectsDir|questionLevel): /, '')));
    return false;
  }
}

// Saved on Enter or on leaving the field, like the task prefix; Escape puts the saved value back.
function ProfileText({ label, hint, value, field, className, lower, maxLength }: { label: string; hint?: string; value: string; field: 'name' | 'language' | 'projectsDir'; className: string; lower?: boolean; maxLength?: number }) {
  const [draft, setDraft] = useState<string | null>(null);
  const save = async () => {
    if (draft === null || draft.trim() === value) return setDraft(null);
    if (await saveProfile({ [field]: draft.trim() })) setDraft(null);
  };
  return (
    <Row label={label} hint={hint}>
      <Input
        aria-label={label}
        className={className}
        value={draft ?? value}
        maxLength={maxLength}
        spellCheck={false}
        onChange={(e) => setDraft(lower ? e.target.value.toLowerCase() : e.target.value)}
        onBlur={() => void save()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          else if (e.key === 'Escape') setDraft(null);
        }}
      />
    </Row>
  );
}

// A record, so a new level fails tsc here until it is listed.
const LEVELS = Object.keys({ minimal: 1, balanced: 1, thorough: 1 } satisfies Record<QuestionLevel, 1>) as QuestionLevel[];

function ProfileSection({ s }: { s: Settings_ | undefined }) {
  const p = s?.profile;
  return (
    <>
      <Head title={t('settings.profile.title')} hint={t('settings.profile.hint')} />
      {!s ? <Skeleton lines={4} /> : !p ? <Empty>{t('settings.profile.none')}</Empty> : (
        <Rows>
          <ProfileText label={t('settings.profile.name')} value={p.name} field="name" className="w-56" maxLength={60} />
          <ProfileText label={t('settings.profile.language')} hint={t('settings.profile.languageHint')} value={p.language} field="language" className="max-w-20 font-mono" lower />
          <ProfileText label={t('settings.profile.projectsDir')} hint={t('settings.profile.projectsDirHint')} value={p.projectsDir} field="projectsDir" className="min-w-96 font-mono text-xs" />
          <Row label={t('settings.profile.questionLevel')} hint={t(`settings.profile.levelHint.${p.questionLevel}`)}>
            <Segmented ariaLabel={t('settings.profile.questionLevel')} value={p.questionLevel} onChange={(questionLevel) => void saveProfile({ questionLevel })} options={LEVELS.map((l) => ({ value: l, label: t(`settings.profile.level.${l}`) }))} />
          </Row>
        </Rows>
      )}
    </>
  );
}

let idesRescanned = false;

const noData = (q: { loading: boolean }) => (q.loading ? '…' : t('common.noData'));

function WidgetsSection({ s }: { s: Settings_ | undefined }) {
  const widgets = useApi<Widgets>('/api/widgets', ['widgets']);
  const [purging, setPurging] = useState<{ id: string; title: string } | null>(null);
  const home = s?.home ?? EMPTY_HOME;
  const defs = widgets.data?.defs ?? [];
  const all = stacks(home, defs, { width: window.innerWidth, height: window.innerHeight });
  const onScreen = SLOTS.flatMap((slot) => all[slot].filter((id) => !home.hidden.includes(id)).map((id) => ({ id, slot, title: widgetTitle(id, defs) ?? id })));
  const trash = home.hidden.flatMap((id) => {
    const title = widgetTitle(id, defs);
    return title === undefined ? [] : [{ id, title }];
  });
  return (
    <section>
      <Head title={t('set.widgets')} hint={t('widget.settingsHint')} />
      <h3 className="mb-1 text-xs text-muted">{t('widget.onScreen')}</h3>
      <Rows>
        {onScreen.map((w) => (
          <Row key={w.id} label={w.title} hint={t(`slot.${w.slot}`)}>
            <Button onClick={() => trashWidget(home, w.id, w.title)}>{t('widget.removeAction')}</Button>
          </Row>
        ))}
      </Rows>
      <h3 className="mt-5 mb-1 text-xs text-muted">{t('widget.trash')}</h3>
      {trash.length === 0 ? (
        <Empty>{t('widget.trashEmpty')}</Empty>
      ) : (
        <Rows>
          {trash.map((w) => (
            <Row key={w.id} label={w.title}>
              <Button onClick={() => restoreWidget(home, w.id)}>{t('widget.restoreAction')}</Button>
              <Button variant="danger" onClick={() => setPurging(w)}>{t('widget.purgeAction')}</Button>
            </Row>
          ))}
        </Rows>
      )}
      <Dialog open={!!purging} onOpenChange={(o) => !o && setPurging(null)} title={t('widget.purgeTitle')} description={t('widget.purgeText', { title: purging?.title ?? '' })}>
        <div className="flex justify-end gap-2">
          <Button onClick={() => setPurging(null)}>{t('common.cancel')}</Button>
          <Button
            variant="danger"
            onClick={() => {
              if (purging) purgeWidget(home, purging.id);
              setPurging(null);
            }}
          >
            {t('widget.purgeAction')}
          </Button>
        </div>
      </Dialog>
    </section>
  );
}

function Ides({ s, error, retry }: { s: Settings_ | undefined; error: string | null; retry: () => void }) {
  const update = async (path: string) => {
    try {
      const next = await api<Settings_>(path, { method: 'POST' });
      setCached<Settings_>('/api/settings', () => next);
    } catch (e) {
      toastError(e);
    }
  };
  // The free local scan needs no button: it runs once per launch, the first time this section opens.
  useEffect(() => {
    if (idesRescanned) return;
    idesRescanned = true;
    void update('/api/ides/scan');
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <Head
        title={t('set.ides')}
        hint={t('settings.scanHint')}
        aside={
          <>
            {s?.scannedAt && <span className="text-[11px] text-dim">{t('settings.scanned', { ago: fmtAgo(s.scannedAt) })}</span>}
            {s?.scanning && <Spinner size={11} />}
            <Button title={spendNote()} onClick={() => runMicrotask({ id: 'ide-search', vars: { found: (s?.ides ?? []).map((e) => e.name).join(', ') || 'none' } })}>
              <ClaudeMark size={11} />{t('settings.viaClaude')}
            </Button>
          </>
        }
      />
      {error && !s && <ErrorState message={error} onRetry={retry} />}
      {s?.scanError && <ErrorState className="mb-3" message={t('settings.scanFailed', { error: s.scanError })} />}
      {!s && !error && <Skeleton lines={4} />}
      {s && s.ides.length === 0 && <Empty>{s.scanning ? t('settings.scanning') : t('settings.noIdes')}</Empty>}
      {s && s.ides.length > 0 && (
        <Rows>
          {s.ides.map((e) => (
            <div key={e.id} className="flex items-center gap-3 border-t border-line2 py-2 first:border-t-0">
              <ProgramIcon id={e.catalogId} name={e.name} size={22} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-soft">{e.name}</div>
                <div className="selectable truncate font-mono text-[11px] text-dim" title={e.exe}>{e.exe}</div>
              </div>
              <Tag>{e.side === 'windows' ? 'Windows' : 'Linux'}</Tag>
              <Tag>{e.source}</Tag>
              <span className="flex w-28 justify-end">
                {e.approved ? <Check size={13} className="text-ok" aria-label={t('settings.approved')} /> : (
                  <button type="button" onClick={() => update(`/api/ides/${encodeURIComponent(e.id)}/approve`)} className="press inline-flex items-center gap-1 text-[11.5px] text-accent hover:text-accent-hover"><ShieldAlert size={11} />{t('settings.approve')}</button>
                )}
              </span>
            </div>
          ))}
        </Rows>
      )}
    </>
  );
}

// The start of a task's id on the board: OS in OS-21. Saved on Enter or on leaving the field; the cards follow on the server.
function PrefixRow({ project, label }: { project: string | null; label: string }) {
  const board = useApi<{ prefixes: Record<string, string> }>('/api/kanban', ['kanban']);
  const current = board.data?.prefixes[project ?? '@general'] ?? '';
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? current;
  const save = async () => {
    if (draft === null || !draft.trim() || draft.trim().toUpperCase() === current) {
      setDraft(null);
      return;
    }
    try {
      await api('/api/kanban/prefix', { method: 'PUT', body: { project, prefix: draft } });
      invalidateTopics(['kanban']);
      setDraft(null);
    } catch (e) {
      toastError(e);
    }
  };
  return (
    <Row label={label} hint={t('settings.taskPrefixHint', { example: `${value || 'OS'}-21` })}>
      <Input
        aria-label={label}
        className="w-56 font-mono uppercase"
        value={value}
        maxLength={10}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value.toUpperCase())}
        onBlur={() => void save()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          else if (e.key === 'Escape') setDraft(null);
        }}
      />
    </Row>
  );
}

function ProjectsSection({ settings }: { settings: Settings_ | undefined }) {
  const projects = useApi<Project[]>('/api/projects', ['projects']);
  const models = useApi<{ id: string; label: string }[]>('/api/models');
  const icons = useApi<ProjectIcons>('/api/project-icons', ['projects']);
  const { color } = useProjectColors();
  const [picked, setPicked] = useState<string | null>(null);
  const list = (projects.data ?? []).filter((p) => !p.misc);
  const key = picked ?? list[0]?.key ?? null;
  const ide = useApi<ProjectIde>(key ? `/api/ides/project/${encodeURIComponent(key)}` : null, ['settings']);
  const current = key ? settings?.projects[key] ?? {} : {};

  const patch = async (body: Record<string, string | null>) => {
    if (!key) return;
    try {
      const next = await api<Settings_>(`/api/settings/project/${encodeURIComponent(key)}`, { method: 'PUT', body });
      setCached<Settings_>('/api/settings', () => next);
      ide.refetch();
    } catch (e) {
      toastError(e);
    }
  };

  const auto = ide.data?.auto && ide.data.chosen ? t('settings.autoIde', { name: ide.data.chosen.name, marker: ide.data.marker ?? t('settings.noMarker') }) : t('settings.autoIdeNone');
  const drawn = Object.keys(icons.data?.icons ?? {}).length;
  return (
    <>
      <Head title={t('set.projects')} hint={t('settings.defaultsHint')} />
      {projects.error && !projects.data ? <ErrorState className="mb-6" message={projects.error} onRetry={projects.refetch} /> : projects.data && list.length === 0 ? <Empty className="mb-6">{t('settings.noProjects')}</Empty> : (
        <Rows>
          <Row label={t('settings.project')}>
            <ProjectSelect className="w-56" ariaLabel={t('settings.project')} value={key} onChange={setPicked} projects={list} />
          </Row>
          <Row label={t('newTab.model')}>
            <Select className="w-56" ariaLabel={t('newTab.model')} value={current.model ?? null} onChange={(v) => patch({ model: v })} options={[{ value: null, label: t('newTab.fromSettings') }]} groups={modelGroups(models.data ?? [])} />
          </Row>
          <Row label={t('newTab.effort')}>
            <Select className="w-56" ariaLabel={t('newTab.effort')} value={current.effort ?? null} onChange={(v) => patch({ effort: v })} options={efforts()} />
          </Row>
          <Row label={t('settings.ide')} hint={!current.ide ? auto : undefined}>
            <Select className="w-56" ariaLabel={t('settings.ide')} value={current.ide ?? null} onChange={(v) => patch({ ide: v })} options={[{ value: null, label: t('settings.ideAuto') }, ...(settings?.ides ?? []).filter((e) => e.approved).map((e) => ({ value: e.id, label: e.name }))]} />
          </Row>
          <PrefixRow key={key} project={key} label={t('settings.taskPrefix')} />
          <PrefixRow project={null} label={t('settings.taskPrefixGeneral')} />
        </Rows>
      )}
      <MapSection settings={settings} projects={projects.data ?? []} />
      <Head title={t('icons.title')} hint={t('icons.hint')} />
      <Rows>
        <Row label={t('icons.state', { n: drawn, total: list.length })} hint={icons.data?.rejected.length ? t('icons.rejected', { list: icons.data.rejected.map((r) => `${r.key}: ${r.reason}`).join('; ') }) : icons.data ? shortPath(icons.data.dir) : undefined}>
          <Button title={spendNote()} disabled={!icons.data || list.length === 0} onClick={() => icons.data && askForIcons(icons.data.dir, list, icons.data.icons)}>
            <ClaudeMark size={12} />{t('icons.action')}
          </Button>
        </Row>
        {list.length > 0 && (
          <div className="flex flex-wrap gap-x-4 gap-y-2 border-t border-line2 py-3">
            {list.slice(0, 24).map((p) => (
              <span key={p.key} className="inline-flex items-center gap-1.5 text-xs text-muted"><ProjectIcon project={p.key} name={p.name} color={color(p.key)} size={18} />{p.name}</span>
            ))}
          </div>
        )}
      </Rows>
    </>
  );
}

function MapSection({ settings, projects }: { settings: Settings_ | undefined; projects: Project[] }) {
  const graph = useApi<MemoryGraph>('/api/memory/graph', ['memory']);
  const limit = settings?.universe?.limit ?? DEFAULT_MAP_LIMIT;
  const [draft, setDraft] = useState<string | null>(null);
  const coreKey = graph.data?.coreProject ?? null;
  const shown = graph.data ? mapKeys(projects, new Set(graph.data.nodes.map((n) => n.project)), coreKey, limit) : null;
  const commit = () => {
    const next = Number(draft);
    setDraft(null);
    if (draft !== null && Number.isInteger(next) && next >= 1 && next <= MAX_MAP_LIMIT && next !== limit) void setUniverse({ limit: next });
  };
  return (
    <>
      <Head title={t('set.map')} hint={t('set.mapHint')} aside={<Button title={spendNote()} onClick={() => askMapSetup(projects, limit)}><ClaudeMark size={12} />{t('universe.mapSetup')}</Button>} />
      <Rows>
        <Row label={t('set.mapLimit')} hint={shown ? t('set.mapState', { shown: [...shown].filter((k) => k !== coreKey).length, total: projects.filter((p) => p.key !== coreKey).length }) : undefined}>
          <Input
            type="number"
            min={1}
            max={MAX_MAP_LIMIT}
            aria-label={t('set.mapLimit')}
            className="w-20"
            value={draft ?? limit}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => e.key === 'Enter' && commit()}
          />
        </Row>
      </Rows>
    </>
  );
}

/** What /doctor would tell about the installation, from `claude doctor` in a background terminal: no model, no tokens. */
function DoctorRow() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ output: string; error: string | null; runs?: TerminalRun[]; key?: string; params?: Record<string, string | number> } | null>(null);
  const run = async () => {
    setBusy(true);
    try {
      setResult(await api<{ output: string; error: string | null; runs?: TerminalRun[]; key?: string; params?: Record<string, string | number> }>('/api/doctor', { method: 'POST' }));
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Row label={t('set.doctor')} hint={t('set.doctorHint')}>
        <Button disabled={busy} onClick={() => void run()}>{busy ? <Spinner size={11} /> : <Stethoscope size={12} />}{t('set.doctorRun')}</Button>
      </Row>
      {result?.error && <p role="alert" className="border-t border-line2 py-2.5 text-xs break-words text-accent">{serverText(result.error, result.key, result.params)}</p>}
      {result?.output && <TerminalText testId="doctor-output" text={result.output} runs={result.runs} className="mb-2 rounded-md border border-line2 bg-bg" />}
    </>
  );
}

function ClaudeSection() {
  const account = useAccount();
  const overview = useApi<Overview>('/api/overview', ['overview']);
  const a = account.data;
  const billing = a?.billing === 'api' ? t('set.billingApi') : a?.billing === 'subscription' ? t('set.billingPlan') : noData(account);
  return (
    <>
      <Head title={t('set.claude')} hint={t('set.claudeHint')} aside={<AskClaude task="admin-settings" vars={{ section: 'Claude account', context: `Plan: ${a?.plan ?? 'unknown'}. Claude Code ${overview.data?.claudeVersion ?? 'unknown'}.` }} />} />
      <Rows>
        <Row label={t('limits.plan')}><span className="text-soft">{a?.plan ?? noData(account)}</span></Row>
        <Row label={t('set.billing')} hint={spendNote()}><span className="text-soft">{billing}</span></Row>
        <Row label="Claude Code"><span className="font-mono text-xs text-soft">{overview.data?.claudeVersion ?? noData(overview)}</span></Row>
        <DoctorRow />
      </Rows>
      {(a?.windows.length ?? 0) > 0 && (
        <Rows>
          {a!.windows.map((w, i) => (
            <Row key={`${w.kind}${w.label}${i}`} label={`${w.kind === 'session' ? t('limits.session') : w.kind === 'weekly_all' ? t('limits.weekly') : t('limits.weeklyScoped')}${w.label ? ` · ${w.label}` : ''}`} hint={w.resetsAt ? t('limits.resets', { at: fmtDateTime(w.resetsAt) }) : undefined}>
              <Bar className="w-40" value={w.percent ?? 0} max={100} color="var(--color-accent)" />
              <span className="w-10 text-right text-xs text-soft">{w.percent == null ? '–' : `${Math.round(w.percent)}%`}</span>
            </Row>
          ))}
        </Rows>
      )}
    </>
  );
}

function Notes({ s }: { s: Settings_ | undefined }) {
  const go = useApp.getState().go;
  const state = s?.obsidian.installed === true ? t('settings.obsidianFound') : s?.obsidian.installed === false ? t('settings.obsidianMissing') : t('settings.obsidianUnknown');
  return (
    <>
      <Head title={t('set.notes')} aside={<AskClaude task="admin-settings" vars={{ section: 'Notes and Obsidian', context: `Obsidian installed: ${String(s?.obsidian.installed)}. Vault: ${s?.obsidian.vaultWindows ?? 'unknown'}.` }} />} />
      <Rows>
        <Row label="Obsidian" hint={state}>
          <ProgramIcon id="obsidian" size={20} />
          {s?.obsidian.installed === false && <a href={OBSIDIAN_DOWNLOAD} target="_blank" rel="noreferrer" className="text-xs text-accent">{t('obsidian.download')}</a>}
          {s?.obsidian.installed === true && <Check size={13} className="text-ok" />}
        </Row>
        <Row label={t('set.vault')} hint={t('obsidian.howTo')}>
          <code className="selectable max-w-xl font-mono text-[11.5px] wrap-anywhere text-soft">{s?.obsidian.vaultWindows}</code>
        </Row>
        <Row label={t('set.vaultPanel')}>
          <Button onClick={() => go({ kind: 'tools', pane: 'vault' })}>{t('set.openVaultPanel')}</Button>
        </Row>
      </Rows>
    </>
  );
}

function Voice() {
  const q = useApi<VoiceStatus>('/api/voice', ['voice']);
  const [confirm, setConfirm] = useState(false);
  const v = q.data;
  const remove = async () => {
    setConfirm(false);
    try {
      const next = await api<VoiceStatus>('/api/voice/model', { method: 'DELETE' });
      setCached<VoiceStatus>('/api/voice', () => next);
    } catch (e) {
      toastError(e);
    }
  };
  return (
    <>
      <Head title={t('set.voice')} hint={t('voice.hint')} />
      {q.error && !v && <ErrorState message={q.error} onRetry={q.refetch} />}
      {!v && !q.error && <Skeleton lines={3} />}
      {v && (
        <Rows>
          <Row label={t('voice.model')} hint={v.state === 'ready' ? t('voice.onDisk', { size: fmtMb(v.diskBytes) }) : t('voice.notInstalled', { size: fmtMb(v.modelBytes) })}>
            <span className="font-mono text-xs text-soft">{v.model}</span>
            {v.state === 'ready' && <Check size={13} className="text-ok" />}
          </Row>
          <Row label={t('voice.folder')}><code className="selectable max-w-xl font-mono text-[11.5px] wrap-anywhere text-soft">{v.dir}</code></Row>
          {v.error && <p role="alert" className="border-t border-line2 py-2.5 text-xs break-words text-accent">{t('voice.failed', { error: v.error })}</p>}
          <div className="border-t border-line2 py-2.5">
            {v.state === 'downloading' ? <DownloadProgress status={v} /> : v.state === 'ready' ? <Button onClick={() => setConfirm(true)}>{t('voice.remove')}</Button> : <Button variant="primary" onClick={() => void enableVoice()}>{t('voice.enable')}</Button>}
          </div>
        </Rows>
      )}
      <Dialog open={confirm} onOpenChange={setConfirm} title={t('voice.removeTitle')} description={t('voice.removeHint', { size: fmtMb(v?.diskBytes ?? 0) })}>
        <div className="flex justify-end gap-2">
          <Button onClick={() => setConfirm(false)}>{t('common.cancel')}</Button>
          <Button variant="danger" onClick={() => void remove()}>{t('voice.remove')}</Button>
        </div>
      </Dialog>
    </>
  );
}

function About({ s }: { s: Settings_ | undefined }) {
  const overview = useApi<Overview>('/api/overview', ['overview']);
  return (
    <>
      <Head title={t('set.about')} />
      <Rows>
        <Row label="Claude OS"><span className="text-xs text-muted">{t('set.aboutWhat')}</span></Row>
        <Row label="Claude Code"><span className="font-mono text-xs text-soft">{overview.data?.claudeVersion ?? noData(overview)}</span></Row>
        <Row label={t('set.platform')}><span className="font-mono text-xs text-soft">{s?.platform}</span></Row>
        <Row label={t('set.iconsCredit')} hint={t('set.iconsCreditHint')}><span className="text-xs text-muted">simple-icons, lucide</span></Row>
      </Rows>
    </>
  );
}

export function SettingsView({ section }: { section: SettingsSection }) {
  const q = useApi<Settings_>('/api/settings', ['settings']);
  const go = useApp((s) => s.go);
  const s = q.data;
  return (
    <div className="grid min-h-0 flex-1 grid-cols-[196px_minmax(0,1fr)]">
      <nav aria-label={t('set.nav')} className="flex min-h-0 flex-col gap-0.5 overflow-auto border-r border-line2 p-2">
        <h1 className="flex items-center gap-2 px-2 pt-1 pb-2.5 text-sm font-medium"><Settings size={15} className="text-dim" />{t('settings.title')}</h1>
        {SECTIONS.map((x) => (
          <button
            key={x.id}
            type="button"
            aria-current={section === x.id ? 'page' : undefined}
            onClick={() => go({ kind: 'settings', section: x.id })}
            className={cn('press flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-left', section === x.id ? 'bg-white/[.1] text-fg shadow-[inset_0_1px_0_rgba(255,255,255,.08)]' : 'text-muted hover:bg-raised hover:text-fg')}
          >
            <x.icon size={14} className={section === x.id ? 'text-accent' : 'text-dim'} />
            {t(x.label)}
          </button>
        ))}
      </nav>
      <div className="min-h-0 overflow-auto">
        <div className="max-w-4xl px-7 py-5">
          <Breadcrumbs className="mb-3 -ml-1" items={[{ label: t('nav.home'), view: { kind: 'home' } }, { label: t('settings.title'), view: { kind: 'settings' } }, { label: t(SECTIONS.find((x) => x.id === section)?.label ?? SECTIONS[0].label) }]} />
          {section === 'general' && <General s={s} />}
          {section === 'profile' && <ProfileSection s={s} />}
          {section === 'widgets' && <WidgetsSection s={s} />}
          {section === 'ides' && <Ides s={s} error={q.error} retry={q.refetch} />}
          {section === 'projects' && <ProjectsSection settings={s} />}
          {section === 'claude' && <ClaudeSection />}
          {section === 'notes' && <Notes s={s} />}
          {section === 'voice' && <Voice />}
          {section === 'about' && <About s={s} />}
        </div>
      </div>
    </div>
  );
}
