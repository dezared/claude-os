import { OFF_CHAT, type OffChatCommand } from '../../../shared/commands.ts';
import { Button, Dialog } from '@/components/ui';
import { api, useApi } from '@/lib/api';
import { useChat, type Item } from '@/lib/chat';
import { cn } from '@/lib/format';
import { t, type Key } from '@/lib/i18n';
import { toast, toastError, useApp, type View } from '@/lib/store';
import { closeTab } from '@/lib/tabs';
import { tabTitle } from '@/lib/tabTitle';
import type { ProjectIde, Tab, TerminalPreview } from '@/lib/types';
import { ActionButton, findTerminalAction, useActions } from './Actions';
import { setTabMode } from './ModeControl';
import { sendTabCommand } from './tabCommands';
import { toolSummary } from './ToolCall';

/** The command goes to this dialog and not to the CLI. A skill of that name is listed as working and is left alone. */
export function isOffChat(name: string, args: string, listed: { name: string; needsTerminal: boolean }[]): boolean {
  const entry = OFF_CHAT[name];
  if (entry?.bareOnly && args) return false;
  const row = listed.find((c) => c.name.replace(/^\//, '') === name);
  return row ? row.needsTerminal : !!entry;
}

const WHY: Record<Exclude<OffChatCommand['why'], null>, Key> = { panel: 'cmd.whyPanel', bound: 'cmd.whyBound', model: 'cmd.whyModel' };

const LINKS: Record<NonNullable<OffChatCommand['link']>, { label: Key; view: View }> = {
  settings: { label: 'cmd.toSettings', view: { kind: 'settings' } },
  doctor: { label: 'cmd.toDoctor', view: { kind: 'settings', section: 'claude' } },
  sessions: { label: 'cmd.toSessions', view: { kind: 'sessions' } },
  memory: { label: 'cmd.toMemory', view: { kind: 'tools', pane: 'claude-md' } },
  hooks: { label: 'cmd.toHooks', view: { kind: 'tools', pane: 'hooks' } },
  plugins: { label: 'cmd.toPlugins', view: { kind: 'tools', pane: 'plugins' } },
  skills: { label: 'cmd.toSkills', view: { kind: 'tools', pane: 'skills' } },
  account: { label: 'cmd.toAccount', view: { kind: 'settings', section: 'claude' } },
  theme: { label: 'cmd.toTheme', view: { kind: 'settings', section: 'general' } },
};

const CONTROLS: Record<NonNullable<OffChatCommand['control']>, Key> = { git: 'cmd.controlGit', ide: 'cmd.controlIde', running: 'cmd.controlRunning', mode: 'cmd.controlMode', account: 'cmd.controlAccount', theme: 'cmd.controlTheme', here: 'cmd.controlHere' };

// These live in the bar and the panels of a work tab: Home has none of them.
const WORK_TAB_ONLY = new Set<OffChatCommand['control']>(['git', 'ide', 'running', 'mode']);
const WORK_TAB_RUNS = new Set<OffChatCommand['run']>(['git', 'ide', 'running', 'mode']);

const textOf = (item: Extract<Item, { k: 'user' | 'assistant' }>) => item.blocks.flatMap((b) => (b.type === 'text' && b.text.trim() ? [b.text.trim()] : [])).join('\n\n');

function lastReply(items: Item[]): string {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.k === 'assistant' && textOf(item)) return textOf(item);
  }
  return '';
}

/** The conversation as Markdown: the words, each tool call as one line, a terminal screen as it was. */
function conversationText(items: Item[]): string {
  const out: string[] = [];
  for (const item of items) {
    if (item.k === 'user' && textOf(item)) out.push(`## ${t('cmd.exportYou')}\n\n${textOf(item)}`);
    else if (item.k === 'assistant') {
      const tools = item.blocks.flatMap((b) => (b.type === 'tool_use' ? [`> ${b.name}: ${toolSummary(b.name, b.input)}`] : []));
      const body = [textOf(item), tools.join('\n')].filter(Boolean).join('\n\n');
      if (body) out.push(`## Claude\n\n${body}`);
    } else if (item.k === 'terminal' && item.screen) out.push(`## ${item.command}\n\n\`\`\`\n${item.screen}\n\`\`\``);
  }
  return out.join('\n\n');
}

function copyText(text: string, done: Key) {
  navigator.clipboard.writeText(text).then(() => toast(t(done)), toastError);
}

function saveFile(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** /ide: the project's IDE opens from here; with none chosen, the place to choose one. */
function OpenIde({ tab, leave, onClose }: { tab: Tab; leave: (view: View) => void; onClose: () => void }) {
  const chosen = useApi<ProjectIde>(tab.project ? `/api/ides/project/${encodeURIComponent(tab.project)}` : null, ['settings']).data?.chosen;
  if (!tab.project) return null;
  if (!chosen) return <Button variant="primary" onClick={() => leave({ kind: 'settings', section: 'ides' })}>{t('cmd.toIdes')}</Button>;
  const open = () => {
    onClose();
    api('/api/ides/open', { method: 'POST', body: { ide: chosen.id, project: tab.project, cwd: tab.cwd } }).catch(toastError);
  };
  return <Button variant="primary" onClick={open}>{t('cmd.runIde', { name: chosen.name })}</Button>;
}

const HANDOFF: Record<'copy' | 'copyHeld' | 'same' | 'none', Key> = { copy: 'cmd.handoffCopy', copyHeld: 'cmd.handoffCopyHeld', same: 'cmd.handoffSame', none: 'cmd.handoffNew' };

/** /branch: a copy of the journal in a new tab, nothing is sent to Claude. */
async function openBranch(tab: Tab) {
  try {
    const next = await api<Tab>(`/api/tabs/${encodeURIComponent(tab.id)}/branch`, { method: 'POST', body: { title: t('tabs.branchTitle', { title: tabTitle(tab, t('tabs.root')) }) } });
    useApp.getState().go({ kind: 'tab', id: next.id });
  } catch (e) {
    toastError(e);
  }
}

export function CommandHelp({ name, tab, onClose }: { name: string | null; tab: Tab; onClose: () => void }) {
  const terminal = findTerminalAction(useActions().data);
  const entry = name ? OFF_CHAT[name] : undefined;
  const link = entry?.link && LINKS[entry.link];
  const close = entry?.run === 'close' && tab.kind !== 'root';
  const items = useChat((s) => s.tabs[tab.id]?.items);
  const sessionId = useChat((s) => s.tabs[tab.id]?.sessionId) ?? tab.sessionId;
  const inTab = tab.kind !== 'root';
  const control = entry?.control && (inTab || !WORK_TAB_ONLY.has(entry.control)) ? entry.control : null;
  const reply = entry?.run === 'copy' ? lastReply(items ?? []) : '';
  const talk = entry?.run === 'export' ? conversationText(items ?? []) : '';
  const fileName = `claude-${(sessionId ?? tab.id).slice(0, 8)}.md`;
  const previewQuery = new URLSearchParams({ cwd: tab.cwd, ...(sessionId ? { sessionId } : {}) });
  const preview = useApi<TerminalPreview>(name !== null && terminal ? `/api/open-terminal/preview?${previewQuery}` : null, ['sessions', 'tabs']).data;
  const handoff = !preview ? null : !sessionId ? 'none' : !preview.fork ? 'same' : preview.holder === 'terminal' ? 'copyHeld' : 'copy';
  // With something to do right here, the terminal is the fallback and stops looking like the way forward.
  const native = !!link || close || entry?.run === 'plan' || entry?.run === 'copy' || entry?.run === 'export' || entry?.run === 'branch' || (inTab && !!entry?.run && WORK_TAB_RUNS.has(entry.run));
  const leave = (view: View) => {
    onClose();
    useApp.getState().go(view);
  };
  return (
    <Dialog open={name !== null} onOpenChange={(open) => !open && onClose()} title={`/${name ?? ''}`} description={t('cmd.dialogHint')}>
      <dl className="flex flex-col gap-3 text-[13px]">
        <div>
          <dt className="mb-0.5 text-xs text-dim">{t('cmd.why')}</dt>
          <dd className="text-soft">{t(entry?.why ? WHY[entry.why] : 'cmd.whyUnknown')}</dd>
        </div>
        <div>
          <dt className="mb-0.5 text-xs text-dim">{t('cmd.where')}</dt>
          <dd className="text-soft">
            {t(entry?.why === 'model' ? 'cmd.whereDoctor' : native ? 'cmd.whereNative' : 'cmd.whereTerminal')}
            {control && <> {t(CONTROLS[control])}</>}
            {entry && !entry.link && !entry.run && !entry.control && <> {t('cmd.noFeature')}</>}
          </dd>
        </div>
        {handoff && preview && (
          <div>
            <dt className="mb-0.5 text-xs text-dim">{t('cmd.terminal')}</dt>
            <dd className="text-soft">{t(HANDOFF[handoff])}</dd>
            <dd className="selectable mt-1 font-mono text-[11px] wrap-anywhere text-dim">{preview.command}</dd>
          </div>
        )}
      </dl>
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        {terminal
          ? <span className={cn(native && 'mr-auto')}><ActionButton action={terminal} tab={{ ...tab, sessionId: sessionId ?? null }} label={t('composer.openTerminal')} variant={native ? 'outline' : 'primary'} /></span>
          : <span className="self-center text-xs text-dim">{t('composer.noTerminal')}</span>}
        {entry?.run === 'branch' && <Button variant="primary" disabled={!sessionId} title={sessionId ? undefined : t('cmd.nothingYet')} onClick={() => { onClose(); void openBranch(tab); }}>{t('cmd.runBranch')}</Button>}
        {link && <Button variant="primary" onClick={() => leave(link.view)}>{t(link.label)}</Button>}
        {entry?.run === 'plan' && <Button variant="primary" onClick={() => { onClose(); void setTabMode(tab.id, 'plan'); }}>{t('cmd.runPlan')}</Button>}
        {close && <Button variant="primary" onClick={() => { onClose(); void closeTab(tab); }}>{t('cmd.runClose')}</Button>}
        {inTab && entry?.run === 'git' && <Button variant="primary" onClick={() => { onClose(); sendTabCommand(tab.id, 'git'); }}>{t('cmd.runGit')}</Button>}
        {inTab && entry?.run === 'mode' && <Button variant="primary" onClick={() => { onClose(); sendTabCommand(tab.id, 'mode'); }}>{t('cmd.runMode')}</Button>}
        {inTab && entry?.run === 'running' && <Button variant="primary" onClick={() => { onClose(); sendTabCommand(tab.id, 'running'); }}>{t('cmd.runRunning')}</Button>}
        {inTab && entry?.run === 'ide' && <OpenIde tab={tab} leave={leave} onClose={onClose} />}
        {entry?.run === 'copy' && <Button variant="primary" disabled={!reply} title={reply ? undefined : t('cmd.nothingYet')} onClick={() => { onClose(); copyText(reply, 'cmd.copied'); }}>{t('cmd.runCopy')}</Button>}
        {entry?.run === 'export' && <Button disabled={!talk} title={talk ? undefined : t('cmd.nothingYet')} onClick={() => { onClose(); copyText(talk, 'cmd.exportCopied'); }}>{t('cmd.runExportCopy')}</Button>}
        {entry?.run === 'export' && <Button variant="primary" disabled={!talk} title={talk ? undefined : t('cmd.nothingYet')} onClick={() => { onClose(); saveFile(fileName, talk); }}>{t('cmd.runExportFile')}</Button>}
      </div>
    </Dialog>
  );
}
