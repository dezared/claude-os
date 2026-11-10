import { ListPlus, Loader2, Mic, MicOff, X } from 'lucide-react';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { Button, Dialog, IconButton } from '@/components/ui';
import { api, setCached, useApi } from '@/lib/api';
import { cn } from '@/lib/format';
import { locale, t, type Key } from '@/lib/i18n';
import { toastError, usePersisted } from '@/lib/store';
import type { VoiceStatus } from '@/lib/types';
import { insertAtCaret, insertItems, meterLevel, micProblem, pcmToBase64, splitItems, type MicProblem } from './pcm';
import { startRecorder, type Recorder } from './recorder';

const MAX_SECONDS = 600;
const problemKey: Record<MicProblem, Key> = { denied: 'voice.denied', nodevice: 'voice.noDevice', busy: 'voice.busy', other: 'voice.micFailed' };

export const fmtMb = (bytes: number) => `${Math.round(bytes / 1_000_000)} ${t('voice.mb')}`;

export function DownloadProgress({ status }: { status: VoiceStatus }) {
  const percent = Math.min(100, Math.round(((status.downloaded ?? 0) / status.modelBytes) * 100));
  return (
    <div role="progressbar" aria-label={t('voice.downloading')} aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} className="flex items-center gap-2.5">
      <span className="block h-1 min-w-24 flex-1 overflow-hidden rounded-[2px] bg-white/[.07]">
        <i className="block h-full rounded-[2px] bg-accent transition-[width] duration-200" style={{ width: `${percent}%` }} />
      </span>
      <span className="flex-none text-xs text-muted tabular-nums">{percent}% · {fmtMb(status.downloaded ?? 0)} / {fmtMb(status.modelBytes)}</span>
    </div>
  );
}

export async function enableVoice() {
  try {
    const next = await api<VoiceStatus>('/api/voice/enable', { method: 'POST' });
    setCached<VoiceStatus>('/api/voice', () => next);
  } catch (e) {
    toastError(e);
  }
}

/**
 * `onPreview` takes the temporary "speak" text; without it `onText` does. `onBusy` is on while the field holds that text.
 * `itemsMode` adds the dictate-by-items switch.
 */
export function VoiceButton({ box, onText, onPreview = onText, onBusy, itemsMode }: { box: RefObject<HTMLTextAreaElement | null>; onText: (value: string) => void; onPreview?: (value: string) => void; onBusy?: (on: boolean) => void; itemsMode?: boolean }) {
  const voice = useApi<VoiceStatus>('/api/voice', ['voice']);
  const [phase, setPhase] = useState<'idle' | 'starting' | 'recording' | 'transcribing'>('idle');
  const [problem, setProblem] = useState<MicProblem | null>(null);
  const [nothing, setNothing] = useState(false);
  const [setup, setSetup] = useState(false);
  const [byItems, setByItems] = usePersisted('claude-os.voice.items', true);
  const recorder = useRef<Recorder | null>(null);
  // The field as it was when the recording began: the words in it now are only a state.
  const draft = useRef<{ value: string; start: number; end: number } | null>(null);
  const meter = useRef<HTMLSpanElement>(null);
  const limit = useRef<ReturnType<typeof setTimeout> | null>(null);
  const status = voice.data;

  // The level goes straight to the element: a React render ten times a second would be paid for by the whole composer.
  const showLevel = (chunk: Float32Array) => {
    const level = meterLevel(chunk);
    if (!meter.current) return;
    meter.current.style.transform = `scale(${0.35 + level * 0.65})`;
    meter.current.setAttribute('aria-valuenow', String(Math.round(level * 100)));
  };

  const lock = () => {
    const el = box.current;
    if (!el) return;
    draft.current = { value: el.value, start: el.selectionStart, end: el.selectionEnd };
    el.readOnly = true;
    el.style.color = 'var(--color-dim)';
    el.style.caretColor = 'transparent';
    onBusy?.(true);
  };

  // Puts back the field. The result then goes in by itself, or the field simply returns to what it was.
  const unlock = (text: string) => {
    const el = box.current;
    const was = draft.current;
    draft.current = null;
    if (!el || !was) return;
    el.readOnly = false;
    el.style.color = '';
    el.style.caretColor = '';
    onBusy?.(false);
    const items = itemsMode && byItems ? splitItems(text, locale()) : [];
    const next = items.length > 0 ? insertItems(was.value, was.start, was.end, items) : text ? insertAtCaret(was.value, was.start, was.end, text) : { value: was.value, caret: was.end };
    onText(next.value);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(next.caret, next.caret);
    });
  };

  const stop = async () => {
    if (limit.current) clearTimeout(limit.current);
    const rec = recorder.current;
    recorder.current = null;
    if (!rec) return;
    setPhase('transcribing');
    let text = '';
    try {
      const res = await api<{ text: string }>('/api/voice/transcribe', { method: 'POST', body: { pcm: pcmToBase64(rec.stop()) } });
      text = res.text;
      if (!text) setNothing(true);
    } catch (e) {
      toastError(e);
    }
    unlock(text);
    setPhase('idle');
  };

  const start = async () => {
    setProblem(null);
    setNothing(false);
    setPhase('starting');
    try {
      recorder.current = await startRecorder(showLevel);
      lock();
      setPhase('recording');
      limit.current = setTimeout(() => void stop(), MAX_SECONDS * 1000);
      void api('/api/voice/warm', { method: 'POST' }).catch(() => {});
    } catch (e) {
      setProblem(micProblem(e));
      setPhase('idle');
    }
  };

  // Partials are not worth it on CPU: a job takes 6 s at best on 2.7 of 4 cores, and on the growing buffer the text falls 60 s behind.
  // So the field says what is going on, with the words at the caret, where the result will land.
  useEffect(() => {
    if (phase !== 'recording' && phase !== 'transcribing') return;
    const was = draft.current;
    if (!was) return;
    const word = t(phase === 'recording' ? 'voice.speak' : 'voice.transcribing');
    const show = (dots: number) => onPreview(insertAtCaret(was.value, was.start, was.end, word + '.'.repeat(dots)).value);
    show(3);
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let dots = 3;
    const timer = setInterval(() => show((dots = (dots % 3) + 1)), 450);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  useEffect(
    () => () => {
      if (limit.current) clearTimeout(limit.current);
      recorder.current?.stop();
      recorder.current = null;
      // A field shared with another one (the planner's large view) must not keep the temporary words. A result still on its way has nowhere to go: the same as before.
      if (draft.current) {
        onPreview(draft.current.value);
        onBusy?.(false);
        draft.current = null;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const press = () => {
    if (phase === 'recording') void stop();
    else if (status?.state === 'ready') void start();
    else setSetup(true);
  };

  useEffect(() => {
    if (setup && status?.state === 'ready') setSetup(false);
  }, [setup, status?.state]);

  const label = phase === 'recording' ? t('voice.stop') : phase === 'transcribing' ? t('voice.transcribing') : problem ? t(problemKey[problem]) : status?.state === 'downloading' ? t('voice.downloading') : t('voice.record');
  const note = problem ? t(problemKey[problem]) : nothing ? t('voice.nothing') : null;

  return (
    <div className="relative flex flex-none">
      {itemsMode && (
        <IconButton
          label={t('voice.byItems')}
          aria-pressed={byItems}
          className={cn('size-6', byItems ? 'text-accent!' : 'text-white')}
          onClick={() => setByItems(!byItems)}
        >
          <ListPlus size={13} />
        </IconButton>
      )}
      {note && (
        <div role="alert" className="enter-pop popover absolute right-0 bottom-full z-10 mb-2 flex w-72 items-start gap-2 rounded-xl p-2.5 text-xs text-soft">
          <MicOff size={13} className="mt-px flex-none text-accent" />
          <span className="min-w-0 flex-1">{note}</span>
          <IconButton label={t('common.hide')} className="-mt-1 -mr-1 size-6" onClick={() => { setProblem(null); setNothing(false); }}><X size={11} /></IconButton>
        </div>
      )}
      <IconButton
        label={label}
        aria-pressed={phase === 'recording'}
        disabled={phase === 'starting' || phase === 'transcribing' || !status}
        onClick={press}
        className={cn('relative', phase === 'recording' || problem ? 'text-accent! enabled:hover:text-accent!' : 'text-dim')}
      >
        {phase === 'recording' && (
          <span ref={meter} role="meter" aria-label={t('voice.level')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={0} style={{ transform: 'scale(.35)' }} className="absolute inset-0 rounded-md bg-accent/35 transition-transform duration-75" />
        )}
        {phase === 'transcribing' || phase === 'starting' || status?.state === 'downloading' ? <Loader2 size={14} className="animate-spin" /> : problem ? <MicOff size={14} /> : <Mic size={14} className="relative" />}
      </IconButton>
      {status && (
        <Dialog open={setup} onOpenChange={setSetup} title={t('voice.setupTitle')} description={t('voice.setupHint')}>
          <p className="mb-3 text-xs text-muted">{t('voice.setupSize', { model: status.model, size: fmtMb(status.modelBytes) })}</p>
          {status.error && <p role="alert" className="mb-3 text-xs break-words text-accent">{t('voice.failed', { error: status.error })}</p>}
          {status.state === 'downloading' ? <DownloadProgress status={status} /> : (
            <div className="flex justify-end gap-2">
              <Button onClick={() => setSetup(false)}>{t('common.cancel')}</Button>
              <Button variant="primary" onClick={() => void enableVoice()}>{t('voice.download', { size: fmtMb(status.modelBytes) })}</Button>
            </div>
          )}
        </Dialog>
      )}
    </div>
  );
}
