import { spendNote } from '@/lib/account';
import { useEffect, useState } from 'react';
import { useApi } from '@/lib/api';
import { t } from '@/lib/i18n';
import { fillPrompt, microtaskTitle, sendMicrotask } from '@/lib/microtask';
import { useApp } from '@/lib/store';
import type { Microtask } from '@/lib/types';
import { ClaudeMark } from './ClaudeMark';
import { ErrorState, Skeleton } from './states';
import { Button, Dialog, Field, Segmented, Textarea } from './ui';

// The prompt's language stays English like its template; only the labels follow the interface.
const GOALS = {
  advise: 'give advice on how to set this up',
  configure: 'configure what is missing',
  update: 'find what is out of date and update it',
  clean: 'find what is not needed and propose removing it',
} as const;
type Goal = keyof typeof GOALS;

/** Mounted once. Fetches templates only when a task is opened. */
export function MicrotaskDialog() {
  const req = useApp((s) => s.microtask);
  const close = () => useApp.getState().setMicrotask(null);
  const [input, setInput] = useState('');
  const [target, setTarget] = useState<'service' | 'new'>('service');
  const [goal, setGoal] = useState<Goal>('advise');
  const [busy, setBusy] = useState(false);
  const list = useApi<Microtask[]>(req ? '/api/microtasks' : null);
  const task = list.data?.find((m) => m.id === req?.id);

  useEffect(() => {
    setInput('');
    setGoal('advise');
    setTarget('service');
  }, [req]);

  if (!req) return null;
  const hasGoal = !!task?.prompt.includes('{goal}');
  const vars = { ...req.vars, ...(hasGoal ? { goal: GOALS[goal] } : {}), ...(task?.input ? { [task.input]: input } : {}) };
  const prompt = task ? fillPrompt(task.prompt, vars) : '';
  const ready = !!task && (!task.input || input.trim() !== '');

  const send = async () => {
    if (!task) return;
    setBusy(true);
    const ok = await sendMicrotask(prompt, target, req, microtaskTitle(task), { source: 'microtask', sourceDetail: task.id });
    setBusy(false);
    if (ok) close();
  };

  return (
    <Dialog open onOpenChange={(o) => !o && close()} title={task ? microtaskTitle(task) : t('task.title')} width={620}>
      {list.error && !list.data ? <ErrorState message={list.error} onRetry={list.refetch} /> : !list.data ? <Skeleton lines={4} /> : !task ? <ErrorState message={t('task.missing', { id: req.id })} /> : (
        <div className="flex flex-col gap-3">
          {hasGoal && (
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-xs text-muted">{t('task.goal')}</span>
              <Segmented
                ariaLabel={t('task.goal')}
                value={goal}
                onChange={setGoal}
                options={[
                  { value: 'advise', label: t('task.goalAdvise') },
                  { value: 'configure', label: t('task.goalConfigure') },
                  { value: 'update', label: t('task.goalUpdate') },
                  { value: 'clean', label: t('task.goalClean') },
                ]}
              />
            </div>
          )}
          {task.input && (
            <Field label={t('task.describe')}>
              <Textarea autoFocus rows={3} placeholder={req.placeholder} value={input} onChange={(e) => setInput(e.target.value)} />
            </Field>
          )}
          <div>
            <div className="mb-1 text-xs text-muted">{t('task.prompt')}</div>
            <pre className="selectable max-h-56 overflow-auto rounded-md border border-line2 bg-bg p-2.5 font-mono text-[11.5px] leading-[1.5] whitespace-pre-wrap wrap-anywhere text-soft">{prompt}</pre>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-xs text-muted">{t('task.session')}</span>
            <Segmented
              ariaLabel={t('task.session')}
              value={target}
              onChange={setTarget}
              options={[
                { value: 'service', label: t('task.service') },
                ...(req.project ? [{ value: 'new' as const, label: t('task.newTab') }] : []),
              ]}
            />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 text-xs text-muted"><ClaudeMark size={12} />{spendNote()}</span>
            <div className="flex gap-2">
              {req.secondary && <Button onClick={() => { const s = req.secondary!; close(); s.onClick(); }}>{req.secondary.label}</Button>}
              <Button onClick={close}>{t('common.cancel')}</Button>
              <Button variant="primary" disabled={!ready || busy} onClick={send}>{t('task.send')}</Button>
            </div>
          </div>
        </div>
      )}
    </Dialog>
  );
}
