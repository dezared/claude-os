import { Check } from 'lucide-react';
import { useState } from 'react';
import { Fold } from '@/components/Motion';
import { ErrorState, Skeleton } from '@/components/states';
import { Button, Checkbox, Dialog } from '@/components/ui';
import { api, setCached, useApi } from '@/lib/api';
import { locale, t } from '@/lib/i18n';
import { toastError } from '@/lib/store';
import type { SemanticStatus } from '@/lib/types';
import { DownloadProgress, fmtMb } from '@/work/voice/VoiceButton';
import { onOff, Row, Rows, Head } from './SettingsRows';

const PATH = '/api/memory/semantic';

async function send(method: 'POST' | 'DELETE', url: string) {
  try {
    const next = await api<SemanticStatus>(url, { method });
    setCached<SemanticStatus>(PATH, () => next);
  } catch (e) {
    toastError(e);
  }
}

// The box follows the click at once; the answer confirms it, a failure puts it back.
async function toggle(on: boolean) {
  setCached<SemanticStatus>(PATH, (v) => ({ ...v!, enabled: on }));
  try {
    const next = await api<SemanticStatus>(`${PATH}/${on ? 'enable' : 'disable'}`, { method: 'POST' });
    setCached<SemanticStatus>(PATH, () => next);
  } catch (e) {
    setCached<SemanticStatus>(PATH, (v) => ({ ...v!, enabled: !on }));
    toastError(e);
  }
}

// How far the vectors are: a bar while the background build runs, the size they take in memory.
function IndexRow({ v }: { v: SemanticStatus }) {
  const building = v.indexed < v.total;
  const percent = v.total ? Math.min(100, Math.round((v.indexed / v.total) * 100)) : 0;
  const n = (x: number) => x.toLocaleString(locale());
  return (
    <Row label={t('semantic.index')} hint={`${t('semantic.indexed', { indexed: n(v.indexed), total: n(v.total), size: fmtMb(v.indexBytes) })}${building ? `. ${t('semantic.building')}` : ''}`}>
      {building ? (
        <span role="progressbar" aria-label={t('semantic.index')} aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} className="block h-1 w-40 overflow-hidden rounded-[2px] bg-fg/[.07]">
          <i className="block h-full rounded-[2px] bg-accent transition-[width] duration-200" style={{ width: `${percent}%` }} />
        </span>
      ) : <Check size={13} className="text-ok" />}
    </Row>
  );
}

function ModelRows({ v }: { v: SemanticStatus }) {
  const [confirm, setConfirm] = useState(false);
  const ready = v.state === 'ready';
  return (
    <>
      <Row label={t('voice.model')} hint={ready ? t('voice.onDisk', { size: fmtMb(v.diskBytes) }) : t('voice.notInstalled', { size: fmtMb(v.modelBytes) })}>
        <span className="font-mono text-xs text-soft">{v.model}</span>
        {ready && <Check size={13} className="text-ok" />}
      </Row>
      <Row label={t('voice.folder')}><code className="selectable max-w-xl font-mono text-[11.5px] wrap-anywhere text-soft">{v.dir}</code></Row>
      <Fold show={!!v.error}>
        <p role="alert" className="border-t border-line2 py-2.5 text-xs break-words text-accent">{t('voice.failed', { error: v.error ?? '' })}</p>
      </Fold>
      <div className="border-t border-line2 py-2.5">
        {v.state === 'downloading' ? <DownloadProgress status={v} /> : ready ? <Button onClick={() => setConfirm(true)}>{t('voice.remove')}</Button> : <Button variant="primary" onClick={() => void send('POST', `${PATH}/enable`)}>{t('semantic.enable', { size: fmtMb(v.modelBytes) })}</Button>}
      </div>
      <Dialog open={confirm} onOpenChange={setConfirm} title={t('voice.removeTitle')} description={t('semantic.removeHint', { size: fmtMb(v.diskBytes + v.indexBytes) })}>
        <div className="flex justify-end gap-2">
          <Button onClick={() => setConfirm(false)}>{t('common.cancel')}</Button>
          <Button variant="danger" onClick={() => { setConfirm(false); void send('DELETE', `${PATH}/model`); }}>{t('voice.remove')}</Button>
        </div>
      </Dialog>
    </>
  );
}

/** Settings → Notes: the search by meaning, its model and its index. */
export function SemanticSection() {
  const q = useApi<SemanticStatus>(PATH, ['memorySemantic']);
  const v = q.data;
  return (
    <>
      <Head title={t('semantic.title')} hint={t('semantic.hint')} />
      {q.error && !v && <ErrorState message={q.error} onRetry={q.refetch} />}
      {!v && !q.error && <Skeleton lines={3} />}
      {v && (
        <Rows>
          <Fold show={v.state === 'ready'}>
            <Row label={t('semantic.toggle')} hint={t('semantic.toggleHint')}>
              <Checkbox checked={v.enabled} onChange={(on) => void toggle(on)}>{onOff(v.enabled)}</Checkbox>
            </Row>
          </Fold>
          <Fold show={v.state === 'ready' && v.enabled && v.total > 0} className="border-t border-line2">
            <IndexRow v={v} />
          </Fold>
          <ModelRows v={v} />
        </Rows>
      )}
    </>
  );
}
