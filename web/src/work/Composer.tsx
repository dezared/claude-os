import { ArrowUp, FileText, Focus, MoveHorizontal, Paperclip, ShieldOff, WrapText, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useContextMenu } from '@/components/ContextMenu';
import { Button, IconButton } from '@/components/ui';
import { api, useApi } from '@/lib/api';
import { updateChat, type ChatState } from '@/lib/chat';
import { CHAT_WIDTHS, nextChatWidth, setChatWidth, useChatWidth, useChatWidthClass } from '@/lib/chatWidth';
import { setFocusMode, useFocusMode } from '@/lib/focus';
import { cn, fmtInt } from '@/lib/format';
import { effortLevel } from '@/lib/models';
import { toast, toastError } from '@/lib/store';
import type { Attachment, CommandInfo, Tab } from '@/lib/types';
import { pluginCommands, PluginComposerMarks, useUiPlugins, withPluginCommands } from '@/lib/uiPlugins';
import { insertMention, MENTION_MIME, onTag } from '@/notes/mention';
import { BTW_COMMAND } from '../../../shared/commands.ts';
import { askBtw, BtwCards } from './Btw';
import { ChipInput, chipAt, CHIP_KINDS, findChips } from './ChipInput';
import { CommandHelp, isOffChat } from './CommandHelp';
import { useComposerLayout } from './composerLayout';
import { MentionMenu } from './MentionMenu';
import { mentionRows, mentionSource, mentionSources, openedQuery, type MentionItem, type MentionRow } from './mentionSources';
import { BYPASS, ModeControl, setTabMode } from './ModeControl';
import { QueueRow } from './QueueRow';
import { t } from '@/lib/i18n';
import { addPaste, expandPastes, PASTE_THRESHOLD, pasteText, prunePastes } from './pastes';
import { VoiceButton } from './voice/VoiceButton';

// What is typed outlives the page like a note: read from localStorage, written a moment after the last key.
const DRAFT_KEY = 'claude-os.draft.';
const DRAFT_SAVE_MS = 300;
const drafts = new Map<string, string>();
const unsavedDrafts = new Set<string>();
let draftTimer: ReturnType<typeof setTimeout> | undefined;

function readDraft(id: string): string {
  return drafts.get(id) ?? localStorage.getItem(DRAFT_KEY + id) ?? '';
}

function saveDrafts() {
  clearTimeout(draftTimer);
  draftTimer = undefined;
  for (const id of unsavedDrafts) {
    const value = drafts.get(id);
    try {
      if (value) localStorage.setItem(DRAFT_KEY + id, value);
      else localStorage.removeItem(DRAFT_KEY + id);
    } catch {
      // Over the storage quota: the text stays in the field and in memory, the page must go on.
    }
  }
  unsavedDrafts.clear();
}

// A separate window of the same chat has its own copy of this page: the draft stays one text across them. So do the two inputs of the root session in one page, on Home and in its tab.
const draftWatchers = new Set<(id: string, value: string) => void>();

function keepDraft(id: string, value: string) {
  drafts.set(id, value);
  unsavedDrafts.add(id);
  draftTimer ??= setTimeout(saveDrafts, DRAFT_SAVE_MS);
  for (const watch of draftWatchers) watch(id, value);
}

window.addEventListener('pagehide', saveDrafts);

window.addEventListener('storage', (e) => {
  if (!e.key?.startsWith(DRAFT_KEY)) return;
  const id = e.key.slice(DRAFT_KEY.length);
  drafts.set(id, e.newValue ?? '');
  unsavedDrafts.delete(id);
  for (const watch of draftWatchers) watch(id, e.newValue ?? '');
});

/** Adds to the chat's input from outside it: whichever window shows that input gets the words, or they wait in the draft. */
export function addToDraft(id: string, words: string) {
  const current = readDraft(id);
  const value = `${current}${current && !/\s$/.test(current) ? ' ' : ''}${words} `;
  keepDraft(id, value);
  saveDrafts();
}

const MAX_ATTACH = 40 * 1024 * 1024;

// Shift+Tab walks the same circle as the terminal; going without checks takes a deliberate choice.
const CYCLE = ['default', 'acceptEdits', 'plan', 'auto'];

export function clipboardFiles(data: DataTransfer): File[] {
  const files = data.files.length > 0 ? [...data.files] : [...data.items].flatMap((i) => (i.kind === 'file' ? [i.getAsFile()].filter((f): f is File => f !== null) : []));
  // Word, Excel and some browsers put a picture of the copied text beside it: the text is what was copied.
  return data.getData('text/plain').trim() && files.every((f) => f.type.startsWith('image/')) ? [] : files;
}

export function readFile(file: File): Promise<Attachment> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(new Error(t('composer.readFailed', { name: file.name })));
    r.onload = () => {
      const url = String(r.result);
      resolve({ name: file.name || t('composer.pasted'), mediaType: file.type || 'application/octet-stream', base64: url.slice(url.indexOf(',') + 1) });
    };
    r.readAsDataURL(file);
  });
}

const widthName = { default: 'view.default', large: 'view.large', full: 'view.full' } as const;
const widthTurn = { default: 'view.toDefault', large: 'view.toLarge', full: 'view.toFull' } as const;

const sourceKey = { builtin: 'composer.srcBuiltin', skill: 'composer.srcSkill', plugin: 'composer.srcPlugin', project: 'composer.srcProject' } as const;

// Name matches first, then the description: the way you remember a command is often not its name.
export function filterCommands(all: CommandInfo[], query: string): CommandInfo[] {
  const q = query.toLowerCase();
  if (!q) return all.slice(0, 80);
  const rank = (c: CommandInfo) => {
    const name = c.name.toLowerCase();
    return name.startsWith(q) ? 0 : name.includes(q) ? 1 : c.description?.toLowerCase().includes(q) ? 2 : 3;
  };
  return all.map((c) => ({ c, r: rank(c) })).filter((x) => x.r < 3).sort((a, b) => a.r - b.r).map((x) => x.c).slice(0, 80);
}

type Popup =
  | { kind: 'slash'; query: string; start: number }
  | { kind: 'mention'; query: string; start: number; files: string[] | null; source: string | null; found: Record<string, MentionItem[]> };

function detectPopup(value: string, caret: number): Pick<Extract<Popup, { kind: 'mention' }>, 'kind' | 'query' | 'start'> | Extract<Popup, { kind: 'slash' }> | null {
  const before = value.slice(0, caret);
  const slash = /^\/(\S*)$/.exec(before);
  if (slash) return { kind: 'slash', query: slash[1].toLowerCase(), start: 0 };
  const at = /(?:^|\s)@([^\s@]*)$/.exec(before);
  if (at) return { kind: 'mention', query: at[1], start: caret - at[1].length - 1 };
  return null;
}

export function Composer({
  tab,
  chat,
  placeholder,
  compact,
  prefill,
  onPrefillUsed,
  onSubmit,
  caption,
  underClass,
}: {
  tab: Tab;
  chat: ChatState;
  placeholder: string;
  compact?: boolean;
  prefill?: string | null;
  onPrefillUsed?: () => void;
  onSubmit?: () => void;
  caption?: React.ReactNode;
  underClass?: string;
}) {
  const [text, setTextState] = useState(() => readDraft(tab.id));
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [sending, setSending] = useState(false);
  const [dictating, setDictating] = useState(false);
  const [popup, setPopup] = useState<Popup | null>(null);
  const [active, setActive] = useState(0);
  const [helpFor, setHelpFor] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [editingQueue, setEditingQueue] = useState<string | null>(null);
  const { row, field: ref, controls, tall } = useComposerLayout(compact, text);
  const focusOn = useFocusMode((s) => s.on);
  const widthClass = useChatWidthClass();
  const menuArea = useContextMenu((e) => {
    const width = nextChatWidth(useChatWidth.getState().width);
    const field = ref.current;
    const chip = field && e.target === field ? chipAt(field, e.clientX, e.clientY) : null;
    const full = chip?.kind === 'paste' ? pasteText(tab.id, chip.text) : undefined;
    return [
      ...(chip && full !== undefined ? [{ id: 'chip.expand', label: t('composer.expandPaste'), title: CHIP_KINDS.find((k) => k.kind === chip.kind)?.label(chip.id), icon: WrapText, onSelect: () => expandChip(chip.start, chip.text, full) }] : []),
      { id: 'focus.toggle', label: t(useFocusMode.getState().on ? 'focus.turnOff' : 'focus.turnOn'), icon: Focus, onSelect: () => setFocusMode(!useFocusMode.getState().on) },
      ...(compact ? [] : [{ id: 'view.width', label: t(widthTurn[width]), icon: MoveHorizontal, onSelect: () => setChatWidth(width) }]),
    ];
  });
  const effort = effortLevel(tab.effort);

  const lastDetect = useRef('');
  const setText = (v: string) => {
    lastDetect.current = '';
    keepDraft(tab.id, v);
    setTextState(v);
  };

  useEffect(() => {
    if (prefill) {
      setText(prefill);
      onPrefillUsed?.();
      ref.current?.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill]);

  useEffect(() => {
    const watch = (id: string, value: string) => {
      if (id !== tab.id) return;
      lastDetect.current = '';
      setTextState(value);
    };
    draftWatchers.add(watch);
    return () => void draftWatchers.delete(watch);
  }, [tab.id]);

  // The server's count is the authority: an interrupt cancels queued messages without a queued:false event.
  useEffect(() => {
    if (tab.queued === 0) updateChat(tab.id, (s) => (s.queue.length ? { ...s, queue: [] } : s));
  }, [tab.queued, tab.id]);

  // Mention completion goes to the server: the project may be big.
  const mentionQuery = popup?.kind === 'mention' ? popup.query : null;
  const openedSource = popup?.kind === 'mention' ? popup.source : null;
  useEffect(() => {
    if (mentionQuery === null || openedSource) return;
    let stale = false;
    const t = setTimeout(() => {
      api<string[]>(`/api/tabs/${encodeURIComponent(tab.id)}/files?q=${encodeURIComponent(mentionQuery)}`)
        .then((files) => {
          if (!stale) setPopup((p) => (p?.kind === 'mention' ? { ...p, files } : p));
        })
        .catch(() => {
          if (!stale) setPopup((p) => (p?.kind === 'mention' ? { ...p, files: [] } : p));
        });
    }, 90);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [mentionQuery, openedSource, tab.id]);

  // The sections of the menu ask their own sources: an opened one always, the others only once there is something to look for.
  useEffect(() => {
    if (mentionQuery === null || (!openedSource && !mentionQuery)) return;
    let stale = false;
    const timer = setTimeout(() => {
      for (const source of mentionSources().filter((s) => !openedSource || s.id === openedSource)) {
        source.search(mentionQuery, tab.project ?? null).then((items) => {
          if (!stale) setPopup((p) => (p?.kind === 'mention' ? { ...p, found: { ...p.found, [source.id]: items } } : p));
        }).catch(() => {});
      }
    }, 90);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [mentionQuery, openedSource, tab.project]);

  // Asked for only when `/` is typed. Works before the first message: the server asks the CLI, no prompt, no tokens.
  const commands = useApi<CommandInfo[]>(popup?.kind === 'slash' ? `/api/tabs/${encodeURIComponent(tab.id)}/commands` : null, ['skills']);
  const plugins = useUiPlugins();
  const known: CommandInfo[] = withPluginCommands(commands.data ?? chat.slash.map((c) => ({ ...c, name: c.name.replace(/^\//, ''), description: null, argumentHint: null, source: 'builtin' as const })), plugins);
  const slashItems = popup?.kind === 'slash' ? filterCommands(known, popup.query) : [];
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active, popup?.kind]);
  const rows: MentionRow[] = popup?.kind === 'mention' ? mentionRows(popup.query, popup.source, popup.found, popup.files, (key) => t(key)) : [];
  const count = popup?.kind === 'slash' ? slashItems.length : rows.length;

  // React also reports "selection changed" on key presses: Esc must not reopen the list, arrows must not reset it.
  const refreshPopup = (value: string, caret: number) => {
    if (lastDetect.current === `${caret}|${value}`) return;
    lastDetect.current = `${caret}|${value}`;
    const inside = popup?.kind === 'mention' && popup.source ? openedQuery(value, caret, popup.start) : null;
    const d = inside !== null && popup?.kind === 'mention' ? { kind: 'mention' as const, query: inside, start: popup.start } : detectPopup(value, caret);
    setActive(0);
    setPopup((old) => (d ? (d.kind === 'mention' ? { ...d, files: old?.kind === 'mention' ? old.files : null, source: inside !== null && old?.kind === 'mention' ? old.source : null, found: old?.kind === 'mention' ? old.found : {} } : d) : null));
  };

  const addFiles = async (files: File[]) => {
    if (files.length === 0) return;
    try {
      const read = await Promise.all(files.map(readFile));
      setAttachments((cur) => {
        const next = [...cur, ...read];
        const size = next.reduce((s, a) => s + a.base64.length * 0.75, 0);
        if (size > MAX_ATTACH) {
          toast(t('composer.tooBig'), 'error');
          return cur;
        }
        return next;
      });
    } catch (e) {
      toastError(e);
    }
  };

  // A click on a file or a note goes to the input on the screen: the home composer stays mounted under other screens.
  useEffect(() => onTag((e) => {
    if (!ref.current?.checkVisibility({ visibilityProperty: true })) return;
    e.preventDefault();
    insertMention(ref.current, e.detail);
  }), []);

  // The chip gives way to its text in place, through the field's own input event: undo brings the chip back.
  const expandChip = (start: number, mark: string, full: string) => {
    const field = ref.current;
    const chip = field && findChips(field.value).find((c) => c.start === start && c.text === mark);
    if (!field || !chip) return;
    field.focus();
    field.setSelectionRange(chip.start, chip.end);
    document.execCommand('insertText', false, full);
  };

  // insertText goes through the field's own input event: React state and undo both see it.
  const insertPaste = (pasted: string) => {
    ref.current?.focus();
    document.execCommand('insertText', false, pasted.length > PASTE_THRESHOLD ? addPaste(tab.id, pasted) : pasted);
  };

  // Ctrl+V with the focus elsewhere on the screen, on the transcript for example.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (e.defaultPrevented || !e.clipboardData || el?.closest('input, textarea, [contenteditable="true"]')) return;
      if (!ref.current?.checkVisibility({ visibilityProperty: true })) return; // the home composer stays mounted under other screens
      if (document.querySelector('[role="dialog"][data-state="open"]')) return; // the dialog on top is what is being pasted into
      const files = clipboardFiles(e.clipboardData);
      const pasted = e.clipboardData.getData('text/plain');
      if (files.length === 0 && !pasted) return;
      e.preventDefault();
      if (files.length === 0) return insertPaste(pasted);
      void addFiles(files);
      ref.current?.focus();
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [tab.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const mode = chat.permissionMode ?? tab.permissionMode ?? null;

  const applySlash = (name: string, needsTerminal: boolean) => {
    const clean = name.startsWith('/') ? name : `/${name}`;
    setPopup(null);
    if (needsTerminal && clean !== `/${BTW_COMMAND}`) {
      setHelpFor(clean.slice(1));
      setText('');
      return;
    }
    setText(`${clean} `);
    ref.current?.focus();
  };

  const applyMention = (mention: string) => {
    if (popup?.kind !== 'mention') return;
    const caret = ref.current?.selectionStart ?? text.length;
    const next = `${text.slice(0, popup.start)}${mention} ${text.slice(caret)}`;
    setText(next);
    setPopup(null);
    requestAnimationFrame(() => {
      const pos = popup.start + mention.length + 1;
      ref.current?.setSelectionRange(pos, pos);
      ref.current?.focus();
    });
  };

  // Into a section: what was typed goes, the @ stays, and from here on the field is the section's search.
  const openSection = (id: string | null) => {
    if (popup?.kind !== 'mention') return;
    const caret = ref.current?.selectionStart ?? text.length;
    setText(`${text.slice(0, popup.start)}@${text.slice(caret)}`);
    setPopup({ ...popup, query: '', source: id, found: {} });
    setActive(0);
    if (caret === popup.start + 1) return; // nothing was cut: moving the caret a frame later would land inside what is typed by then
    requestAnimationFrame(() => {
      ref.current?.setSelectionRange(popup.start + 1, popup.start + 1);
      ref.current?.focus();
    });
  };

  const pickRow = (row: MentionRow) => {
    if (row.kind === 'section') openSection(row.source.id);
    else applyMention(row.kind === 'item' ? row.item.mention : `@${row.path}`);
  };

  const send = async () => {
    const typedText = text.trim();
    const body = expandPastes(tab.id, typedText).trim();
    if ((!body && attachments.length === 0) || sending || dictating) return; // dictating: the field holds a state, not a message
    const typed = /^\/(\S+)\s*([\s\S]*)$/.exec(body);
    if (typed?.[1] === BTW_COMMAND) {
      if (typed[2]) {
        void askBtw(tab.id, typed[2]);
        setText('');
      } else {
        setText(`/${BTW_COMMAND} `);
        ref.current?.focus();
      }
      setPopup(null);
      return;
    }
    if (typed?.[1] === 'focus') {
      if (typed[2] && typed[2] !== 'on' && typed[2] !== 'off') {
        toast(t('focus.usage'), 'error');
        return;
      }
      const on = typed[2] ? typed[2] === 'on' : !focusOn;
      setFocusMode(on);
      toast(t(on ? 'focus.turnedOn' : 'focus.turnedOff'));
      setText('');
      setPopup(null);
      return;
    }
    if (typed?.[1] === 'view') {
      const width = typed[2] ? CHAT_WIDTHS.find((w) => w === typed[2]) : nextChatWidth(useChatWidth.getState().width);
      if (!width) {
        toast(t('view.usage'), 'error');
        return;
      }
      setChatWidth(width);
      toast(t('view.set', { width: t(widthName[width]) }));
      setText('');
      setPopup(null);
      return;
    }
    const pluginCommand = pluginCommands(plugins).find((c) => c.name === typed?.[1]);
    if (pluginCommand) {
      setText('');
      setPopup(null);
      try {
        await pluginCommand.run(typed![2], { tabId: tab.id });
      } catch (e) {
        toastError(e);
      }
      return;
    }
    if (typed && isOffChat(typed[1], typed[2], [...known, ...chat.slash])) {
      setHelpFor(typed[1]);
      setText('');
      setPopup(null);
      return;
    }
    onSubmit?.();
    setSending(true);
    const sentAttachments = attachments;
    // The field empties at once, the saved copy waits for the server's answer: a crash in between loses nothing.
    saveDrafts();
    drafts.set(tab.id, '');
    for (const watch of draftWatchers) watch(tab.id, '');
    lastDetect.current = '';
    setTextState('');
    setAttachments([]);
    setPopup(null);
    try {
      await api(`/api/tabs/${encodeURIComponent(tab.id)}/send`, { method: 'POST', body: { text: body, attachments: sentAttachments.length ? sentAttachments : undefined } });
      if (!drafts.get(tab.id)) keepDraft(tab.id, ''); // something typed meanwhile is the new draft
      prunePastes(tab.id, drafts.get(tab.id) ?? '');
    } catch (e) {
      const typedMeanwhile = drafts.get(tab.id);
      setText(typedMeanwhile ? `${typedText}\n${typedMeanwhile}` : typedText);
      setAttachments(sentAttachments);
      toastError(e);
    } finally {
      setSending(false);
    }
  };

  const working = (chat.status ?? tab.status) === 'working' || tab.status === 'working';

  return (
    <div ref={menuArea} className={cn('mx-auto w-full', !compact && widthClass)}>
      {chat.queue.length > 0 && (
        <div className="mb-2 flex flex-col gap-1" aria-label={t('composer.queueAria')}>
          <div className="text-[11px] text-dim">{t('composer.queueTitle', { n: fmtInt(chat.queue.length) })}</div>
          {chat.queue.map((q) => (
            <QueueRow key={q.id ?? q.seq} tabId={tab.id} item={q} editing={q.id !== null && editingQueue === q.id} setEditing={(on) => setEditingQueue(on ? q.id : null)} />
          ))}
        </div>
      )}
      {mode === BYPASS && (
        <div role="alert" className="enter-fade mb-2 flex items-center gap-2 rounded-md border border-accent-deep bg-accent-bg px-3 py-1.5 text-xs text-soft">
          <ShieldOff size={13} className="flex-none text-accent" />
          {t('mode.bypassActive')}
        </div>
      )}
      <BtwCards tabId={tab.id} box={ref} hint={text.trim() === `/${BTW_COMMAND}`} />
      <CommandHelp name={helpFor} tab={tab} onClose={() => setHelpFor(null)} />
      <div
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('Files') || e.dataTransfer.types.includes(MENTION_MIME)) {
            e.preventDefault();
            setDragOver(true);
          }
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          const mention = e.dataTransfer.getData(MENTION_MIME);
          if (mention) {
            e.preventDefault();
            setDragOver(false);
            if (ref.current) insertMention(ref.current, mention);
            return;
          }
          if (e.dataTransfer.files.length === 0) return;
          e.preventDefault();
          setDragOver(false);
          void addFiles([...e.dataTransfer.files]);
        }}
        className={cn(
          'relative rounded-2xl transition-colors duration-150 focus-within:border-accent-deep',
          compact ? 'glass' : 'composer-solid border',
          dragOver ? 'border-accent' : !compact && 'border-line',
        )}
      >
        {popup && (
          <div ref={listRef} role="listbox" aria-label={popup.kind === 'slash' ? t('composer.slashAria') : popup.source ? t(mentionSource(popup.source)?.label ?? 'composer.mentionAria') : t('composer.mentionAria')} className="enter-pop absolute inset-x-0 bottom-full z-10 mb-1.5 max-h-72 overflow-auto rounded-xl popover p-1">
            {popup.kind === 'slash' && !commands.data && known.length === 0 && (commands.error ? <div className="px-2.5 py-1.5 text-xs text-accent">{commands.error}</div> : <div className="px-2.5 py-1.5 text-xs text-dim">{t('composer.loadingCommands')}</div>)}
            {popup.kind === 'slash' && known.length > 0 && slashItems.length === 0 && <div className="px-2.5 py-1.5 text-xs text-dim">{t('composer.noSlash')}</div>}
            {popup.kind === 'mention' && popup.source && rows.length === 0 && <div className="px-2.5 py-1.5 text-xs text-dim">{t('composer.sourceEmpty')}</div>}
            {popup.kind === 'mention' && !popup.source && popup.files === null && <div className="px-2.5 py-1.5 text-xs text-dim">{t('composer.searching')}</div>}
            {popup.kind === 'mention' && !popup.source && popup.files?.length === 0 && <div className="px-2.5 py-1.5 text-xs text-dim">{t('composer.noFiles')}</div>}
            {slashItems.map((c, i) => (
              <button
                key={c.name}
                type="button"
                role="option"
                aria-selected={i === active}
                tabIndex={-1}
                onPointerMove={() => setActive(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => applySlash(c.name, c.needsTerminal)}
                className={cn('flex w-full items-baseline gap-2.5 rounded-md px-2.5 py-1 text-left text-xs', i === active ? 'bg-raised text-fg' : 'text-muted')}
              >
                <span className="max-w-[45%] flex-none truncate font-mono" title={c.argumentHint ?? undefined}>/{c.name}{c.argumentHint && <span className="ml-1.5 text-dim">{c.argumentHint}</span>}</span>
                <span className="min-w-0 flex-1 truncate text-[11.5px] text-dim" title={c.description ?? undefined}>{c.description}</span>
                {c.needsTerminal && <span className="flex-none text-[11px] text-accent">{t('composer.terminalOnly')}</span>}
                <span className="flex-none rounded bg-white/[.07] px-1.5 text-[10.5px] leading-[1.6] text-dim">{t(sourceKey[c.source])}</span>
              </button>
            ))}
            {popup.kind === 'mention' && <MentionMenu rows={rows} active={active} setActive={setActive} opened={mentionSource(popup.source)} onPick={pickRow} onBack={() => openSection(null)} />}
          </div>
        )}
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-2.5 pt-2.5">
            {attachments.map((a, i) => (
              <div key={`${a.name}${i}`} className="group flex max-w-52 items-center gap-1.5 rounded-md border border-line bg-raised py-0.5 pr-0.5 pl-1">
                {a.mediaType.startsWith('image/') ? (
                  <img alt={a.name} src={`data:${a.mediaType};base64,${a.base64}`} className="size-10 rounded object-cover" />
                ) : (
                  <FileText size={13} className="ml-0.5 flex-none text-dim" />
                )}
                <span className="min-w-0 truncate text-xs text-muted">{a.name}</span>
                <IconButton label={t('composer.remove', { name: a.name })} className="size-5" onClick={() => setAttachments((cur) => cur.filter((_, j) => j !== i))}>
                  <X size={10} />
                </IconButton>
              </div>
            ))}
          </div>
        )}
        {/* One row, everything sits on its bottom edge: the field grows upward, the controls stay where the pointer left them. */}
        <div ref={row} className={cn('flex items-end gap-1 py-2 pr-2 pl-4', tall && 'composer-tall')}>
          <ChipInput
            ref={ref}
            rows={1}
            aria-label={placeholder}
            value={text}
            placeholder={placeholder}
            spellCheck={false}
            onChange={(e) => {
              setText(e.target.value);
              refreshPopup(e.target.value, e.target.selectionStart);
            }}
            onSelect={(e) => refreshPopup(e.currentTarget.value, e.currentTarget.selectionStart)}
            onPaste={(e) => {
              const files = clipboardFiles(e.clipboardData);
              const pasted = e.clipboardData.getData('text/plain');
              if (files.length > 0) {
                e.preventDefault();
                void addFiles(files);
              } else if (pasted.length > PASTE_THRESHOLD) {
                e.preventDefault();
                insertPaste(pasted);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Tab' && e.shiftKey) {
                e.preventDefault();
                const at = mode ? CYCLE.indexOf(mode) : -1;
                void setTabMode(tab.id, CYCLE[(at + 1) % CYCLE.length]);
                return;
              }
              if (e.key === 'ArrowUp' && !text && !popup && attachments.length === 0) {
                const last = chat.queue.at(-1);
                if (last?.id) {
                  e.preventDefault();
                  setEditingQueue(last.id);
                  return;
                }
              }
              if (popup?.kind === 'mention' && popup.source) {
                if (e.key === 'Backspace' && !popup.query && ref.current?.selectionStart === ref.current?.selectionEnd) {
                  e.preventDefault();
                  openSection(null);
                  return;
                }
                if (e.key === 'Enter' && count === 0) {
                  e.preventDefault();
                  return;
                }
              }
              if (e.key === ' ' && !e.nativeEvent.isComposing && rows[active]?.kind === 'section') {
                e.preventDefault();
                pickRow(rows[active]);
                return;
              }
              if (popup && count > 0) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setActive((a) => (a + 1) % count);
                  return;
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setActive((a) => (a - 1 + count) % count);
                  return;
                }
                // A command typed out in full has nothing left to complete: Enter runs it, as in the terminal.
                const typedOut = e.key === 'Enter' && popup.kind === 'slash' && slashItems[active].name.toLowerCase() === popup.query && !slashItems[active].argumentHint;
                if ((e.key === 'Tab' || e.key === 'Enter') && !typedOut) {
                  e.preventDefault();
                  if (popup.kind === 'slash') applySlash(slashItems[active].name, slashItems[active].needsTerminal);
                  else pickRow(rows[active]);
                  return;
                }
              }
              if (popup && e.key === 'Escape') {
                e.preventDefault();
                setPopup(null);
                return;
              }
              if (e.key !== 'Enter' || e.nativeEvent.isComposing || e.shiftKey) return; // Shift+Enter breaks the line by itself
              e.preventDefault();
              if (e.ctrlKey || e.metaKey || e.altKey) {
                document.execCommand('insertText', false, '\n'); // through the field's own input event: React state and undo both see it
              } else void send();
            }}
            className={cn('max-h-[40vh] min-h-7 min-w-0 flex-1 resize-none bg-transparent py-1 text-sm leading-5 [field-sizing:content] outline-none placeholder:text-dim')}
          />
          <div ref={controls} className="ml-auto flex flex-none items-end gap-1">
          <VoiceButton box={ref} onText={setText} onPreview={setTextState} onBusy={setDictating} />
          <label title={t('composer.attach')} className="press flex size-7 flex-none items-center justify-center rounded-md text-dim hover:bg-raised hover:text-fg has-focus-visible:outline-2 has-focus-visible:outline-accent">
            <input
              type="file"
              multiple
              aria-label={t('composer.attach')}
              className="sr-only"
              onChange={(e) => {
                void addFiles([...(e.target.files ?? [])]);
                e.target.value = '';
              }}
            />
            <Paperclip size={14} />
          </label>
          <Button variant="primary" className="h-7 flex-none" onClick={send} disabled={sending || dictating || (!text.trim() && attachments.length === 0)}>
            <ArrowUp size={13} />
            {working ? t('composer.toQueue') : t('composer.send')}
          </Button>
          </div>
        </div>
      </div>
      <div className={cn('composer-under', underClass)}>
      {caption}
      {(!compact || !focusOn || plugins.some((p) => p.composerMark)) && (
        <div className="composer-foot mt-1.5 flex items-center gap-3 pl-4 empty:hidden">
          {!compact && <ModeControl tab={tab} chat={chat} />}
          {!compact && effort && (
            <span title={t('work.effortAria')} className="inline-flex flex-none items-center gap-1 text-[11px] text-muted">
              <effort.icon size={11} className={effort.iconClass} />
              {effort.value}
            </span>
          )}
          {/* Focus is the normal state and says nothing; only the way out of it is worth a mark, with the way back in it. */}
          {!focusOn && (
            <button type="button" title={t('focus.turnOn')} onClick={() => setFocusMode(true)} className="press inline-flex flex-none items-center gap-1 rounded text-[11px] text-muted hover:text-fg">
              <Focus size={11} />
              {t('focus.badgeOff')}
            </button>
          )}
          <PluginComposerMarks />
        </div>
      )}
      </div>
    </div>
  );
}
