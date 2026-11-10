import { useEffect, useRef, useState } from 'react';
import { spendNote } from '@/lib/account';
import { t } from '@/lib/i18n';
import { askPrompt, sendMicrotask } from '@/lib/microtask';
import { useApp } from '@/lib/store';
import { ClaudeMark } from './ClaudeMark';
import { Button, Dialog, Field, Segmented, Textarea } from './ui';

/** Mounted once. Opened by `askClaude`: presets or free text, wrapped in the subject's context. Only the button sends. */
export function AskClaudeDialog() {
  const req = useApp((s) => s.ask);
  const close = () => useApp.getState().setAsk(null);
  const [text, setText] = useState('');
  const [target, setTarget] = useState<'service' | 'new'>('service');
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setText('');
    setTarget('service');
  }, [req]);

  if (!req) return null;
  const project = req.subject.project;
  const ready = text.trim() !== '' && !busy;

  const send = async () => {
    if (!ready) return;
    setBusy(true);
    const ok = await sendMicrotask(askPrompt(req, text.trim()), target, { project, title: req.title }, req.title, { source: 'ask', sourceDetail: req.subject.kind });
    setBusy(false);
    if (ok) close();
  };

  return (
    <Dialog open onOpenChange={(o) => !o && close()} title={req.title} width={620}>
      <div className="flex flex-col gap-3">
        {req.presets && req.presets.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {req.presets.map((p) => (
              <Button
                key={p}
                size="sm"
                onClick={() => {
                  setText(p);
                  box.current?.focus();
                }}
              >
                {p}
              </Button>
            ))}
          </div>
        )}
        <Field label={t('task.describe')}>
          <Textarea
            ref={box}
            autoFocus
            rows={3}
            value={text}
            placeholder={req.placeholder}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
              e.preventDefault();
              void send();
            }}
          />
        </Field>
        <div>
          <div className="mb-1 text-xs text-muted">{t('task.prompt')}</div>
          <pre className="selectable max-h-40 overflow-auto rounded-md border border-line2 bg-bg p-2.5 font-mono text-[11.5px] leading-[1.5] whitespace-pre-wrap wrap-anywhere text-soft">{askPrompt(req, text.trim())}</pre>
        </div>
        {project && (
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-xs text-muted">{t('task.session')}</span>
            <Segmented
              ariaLabel={t('task.session')}
              value={target}
              onChange={setTarget}
              options={[
                { value: 'service', label: t('task.service') },
                { value: 'new', label: t('task.newTab') },
              ]}
            />
          </div>
        )}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-xs text-muted"><ClaudeMark size={12} />{spendNote()}</span>
          <div className="flex gap-2">
            <Button onClick={close}>{t('common.cancel')}</Button>
            <Button variant="primary" disabled={!ready} onClick={send}>{t('task.send')}</Button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
