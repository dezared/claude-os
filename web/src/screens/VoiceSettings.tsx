import { Check } from 'lucide-react';
import { useState } from 'react';
import { ErrorState, Skeleton } from '@/components/states';
import { Button, Dialog, Select } from '@/components/ui';
import { api, setCached, useApi } from '@/lib/api';
import { cn } from '@/lib/format';
import { locale, t, type Key } from '@/lib/i18n';
import { toastError } from '@/lib/store';
import type { SettingsView, VoiceLanguage, VoiceModelId, VoiceOptions, VoiceStatus } from '@/lib/types';
import { DownloadProgress, enableVoice, fmtMb } from '@/work/voice/VoiceButton';
import { VOICE_LANGUAGES, VOICE_MODEL_IDS, VOICE_MODELS } from '../../../shared/voice.ts';
import { Head, Row, Rows } from './SettingsRows';

const MODEL_HINT = {
  'whisper-small': 'voice.model.whisper-small',
  'whisper-large-v3-turbo': 'voice.model.whisper-large-v3-turbo',
  'whisper-large-v3-turbo-russian': 'voice.model.whisper-large-v3-turbo-russian',
} as const satisfies Record<VoiceModelId, Key>;

// Language names come from the browser in the interface language, so the list needs no strings of its own.
function languageName(code: VoiceLanguage): string {
  if (code === 'auto') return t('voice.auto');
  const name = new Intl.DisplayNames([locale()], { type: 'language' }).of(code) ?? code;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

// The status follows the chosen model, so it is fetched right away rather than on the broadcast.
async function setVoice(patch: Partial<VoiceOptions>) {
  try {
    const next = await api<SettingsView>('/api/settings/voice', { method: 'PUT', body: patch });
    setCached<SettingsView>('/api/settings', () => next);
    const status = await api<VoiceStatus>('/api/voice');
    setCached<VoiceStatus>('/api/voice', () => status);
  } catch (e) {
    toastError(e);
  }
}

function ModelPicker({ v }: { v: VoiceStatus }) {
  return (
    <div role="radiogroup" aria-label={t('voice.model')} className="flex flex-col gap-1 border-t border-line2 py-2.5">
      <div className="mb-1 text-[11.5px] text-dim">{t('voice.modelHint')}</div>
      {VOICE_MODEL_IDS.map((id) => (
        <label key={id} className={cn('flex items-start gap-2.5 rounded-lg px-2 py-1.5', v.model === id ? 'bg-fg/[.06]' : 'hover:bg-fg/[.03]')}>
          <input type="radio" name="voice-model" className="mt-1 size-3.5 flex-none accent-accent" checked={v.model === id} disabled={v.state === 'downloading'} onChange={() => void setVoice({ model: id })} />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2 font-mono text-xs text-soft">
              {id}
              <span className="font-sans text-dim">{fmtMb(VOICE_MODELS[id].bytes)}</span>
              {v.installed.includes(id) && <span className="flex items-center gap-1 font-sans text-ok"><Check size={12} />{t('voice.installed')}</span>}
            </span>
            <span className="block text-[11.5px] text-dim">{t(MODEL_HINT[id])}</span>
          </span>
        </label>
      ))}
    </div>
  );
}

// The chosen model: its size on disk, the download or the removal.
function ModelState({ v }: { v: VoiceStatus }) {
  const [confirm, setConfirm] = useState(false);
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
      <Row label={t('voice.model')} hint={v.state === 'ready' ? t('voice.onDisk', { size: fmtMb(v.diskBytes) }) : t('voice.notInstalled', { size: fmtMb(v.modelBytes) })}>
        <span className="font-mono text-xs text-soft">{v.model}</span>
        {v.state === 'ready' && <Check size={13} className="text-ok" />}
      </Row>
      <Row label={t('voice.folder')}><code className="selectable max-w-xl font-mono text-[11.5px] wrap-anywhere text-soft">{v.dir}</code></Row>
      {v.error && <p role="alert" className="border-t border-line2 py-2.5 text-xs break-words text-accent">{t('voice.failed', { error: v.error })}</p>}
      <div className="border-t border-line2 py-2.5">
        {v.state === 'downloading' ? <DownloadProgress status={v} /> : v.state === 'ready' ? <Button onClick={() => setConfirm(true)}>{t('voice.remove')}</Button> : <Button variant="primary" onClick={() => void enableVoice()}>{t('voice.enable')}</Button>}
      </div>
      <Dialog open={confirm} onOpenChange={setConfirm} title={t('voice.removeTitle')} description={t('voice.removeHint', { size: fmtMb(v.diskBytes) })}>
        <div className="flex justify-end gap-2">
          <Button onClick={() => setConfirm(false)}>{t('common.cancel')}</Button>
          <Button variant="danger" onClick={() => void remove()}>{t('voice.remove')}</Button>
        </div>
      </Dialog>
    </>
  );
}

export function VoiceSection({ s }: { s: SettingsView | undefined }) {
  const q = useApi<VoiceStatus>('/api/voice', ['voice']);
  const v = q.data;
  return (
    <>
      <Head title={t('set.voice')} hint={t('voice.hint')} />
      {q.error && !v && <ErrorState message={q.error} onRetry={q.refetch} />}
      {!v && !q.error && <Skeleton lines={3} />}
      {v && (
        <Rows>
          {s && (
            <Row label={t('voice.language')} hint={t('voice.languageHint')}>
              <Select className="w-56" ariaLabel={t('voice.language')} value={s.voice.language} onChange={(language) => void setVoice({ language: language as VoiceLanguage })} options={VOICE_LANGUAGES.map((code) => ({ value: code, label: languageName(code) }))} />
            </Row>
          )}
          <ModelPicker v={v} />
          <ModelState v={v} />
        </Rows>
      )}
    </>
  );
}
