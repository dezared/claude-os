import { Check, ShieldQuestion, X } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Diff } from '@/components/Diff';
import { Markdown } from '@/components/Markdown';
import { Button, Input, Textarea } from '@/components/ui';
import { api } from '@/lib/api';
import { clearDraft, useDraft } from '@/lib/drafts';
import { cn } from '@/lib/format';
import type { RequestItem } from '@/lib/chat';
import { toastError } from '@/lib/store';
import type { RespondRequest } from '@/lib/types';
import { KIT_APPLY_TOOL } from '@/lib/projectKit';
import { KitPlanCard } from './KitPlanCard';
import { toolSummary } from './ToolCall';
import { t } from '@/lib/i18n';

function decisionLabel(decision: string): { text: string; positive: boolean } {
  if (/allow|approve|yes|accept|answer/i.test(decision)) return { text: /answer/i.test(decision) ? t('req.answered') : t('req.allowed'), positive: true };
  if (/deny|reject|no$|refus/i.test(decision)) return { text: t('req.denied'), positive: false };
  return { text: decision, positive: true };
}

export function useRespond(tabId: string | null, requestId: string) {
  const [busy, setBusy] = useState(false);
  const respond = async (body: RespondRequest) => {
    if (!tabId) return;
    setBusy(true);
    try {
      await api(`/api/tabs/${encodeURIComponent(tabId)}/respond/${encodeURIComponent(requestId)}`, { method: 'POST', body });
    } catch (e) {
      toastError(e);
      setBusy(false);
    }
    // On success `busy` stays set until the 'resolved' event swaps the card out.
  };
  return { busy, respond };
}

// Drafts outlive the card on a tab switch; an answered card drops its draft once it leaves the screen, so the answer stays visible meanwhile.
function useCardDraft<T>(tabId: string | null, item: RequestItem, initial: T) {
  const key = `${tabId}:${item.requestId}`;
  const resolved = item.decision !== null;
  useEffect(() => (resolved ? () => clearDraft(key) : undefined), [key, resolved]);
  return useDraft(key, initial);
}

export function CardShell({ title, children, pending }: { title: ReactNode; children: ReactNode; pending: boolean }) {
  return (
    <div className={cn('rounded-[10px] border bg-card p-3', pending ? 'border-accent-deep' : 'border-line2')}>
      <div className="mb-2 flex items-center gap-2 text-xs font-medium">
        <ShieldQuestion size={13} className={pending ? 'text-accent' : 'text-dim'} />
        <span className="min-w-0 flex-1 wrap-anywhere">{title}</span>
      </div>
      {children}
    </div>
  );
}

export function Resolved({ decision }: { decision: string }) {
  const d = decisionLabel(decision);
  return (
    <div className="flex items-center gap-1.5 text-xs text-dim">
      {d.positive ? <Check size={12} /> : <X size={12} />}
      {d.text}
    </div>
  );
}

function Permission({ item, tabId }: { item: Extract<RequestItem, { type: 'permission' }>; tabId: string | null }) {
  const { busy, respond } = useRespond(tabId, item.requestId);
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useCardDraft(tabId, item, '');
  const summary = toolSummary(item.tool, item.input);
  const canAct = !!tabId && item.decision === null;
  const showInput = !item.diff && !summary;
  return (
    <CardShell pending={canAct} title={item.title ?? t('req.askPermission', { tool: item.tool })}>
      {summary && <pre className="selectable mb-2 max-h-40 overflow-auto rounded-md border border-line2 bg-bg p-2 font-mono text-[11.5px] whitespace-pre-wrap wrap-anywhere text-soft">{item.tool === 'Bash' ? String((item.input as { command?: string }).command ?? summary) : summary}</pre>}
      {showInput && <pre className="selectable mb-2 max-h-40 overflow-auto rounded-md border border-line2 bg-bg p-2 font-mono text-[11.5px] whitespace-pre-wrap wrap-anywhere text-muted">{JSON.stringify(item.input, null, 2)}</pre>}
      {item.diff && (
        <div className="mb-2">
          <Diff diff={item.diff} />
        </div>
      )}
      {item.decision !== null && <Resolved decision={item.decision} />}
      {canAct &&
        (denying ? (
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void respond({ kind: 'permission', allow: false, message: reason.trim() || undefined });
            }}
          >
            <Input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t('req.denyReason')} className="py-1 text-xs" />
            <Button type="submit" disabled={busy}>
              {t('req.deny')}
            </Button>
            <Button variant="ghost" onClick={() => setDenying(false)}>
              {t('common.back')}
            </Button>
          </form>
        ) : (
          <div className="flex gap-2">
            <Button variant="primary" disabled={busy} onClick={() => respond({ kind: 'permission', allow: true })}>
              {t('req.allow')}
            </Button>
            <Button disabled={busy} onClick={() => setDenying(true)}>
              {t('req.deny')}
            </Button>
          </div>
        ))}
      {!tabId && item.decision === null && <div className="text-xs text-dim">{t('req.noAnswer')}</div>}
    </CardShell>
  );
}

interface Question {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options?: { label: string; description?: string }[];
}

function asQuestions(raw: unknown): Question[] | null {
  const list = Array.isArray(raw) ? raw : (raw as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(list)) return null;
  return list.filter((q): q is Question => typeof q?.question === 'string');
}

const OTHER = '__other__';

function QuestionForm({ item, tabId }: { item: Extract<RequestItem, { type: 'question' }>; tabId: string | null }) {
  const { busy, respond } = useRespond(tabId, item.requestId);
  const questions = asQuestions(item.questions);
  const [draft, setDraft] = useCardDraft<{ picked: Record<string, string[]>; other: Record<string, string> }>(tabId, item, { picked: {}, other: {} });
  const { picked, other } = draft;
  const canAct = !!tabId && item.decision === null;

  if (!questions) {
    return (
      <CardShell pending={false} title={t('req.question')}>
        <pre className="selectable overflow-auto font-mono text-xs text-muted">{JSON.stringify(item.questions, null, 2)}</pre>
      </CardShell>
    );
  }
  const answerFor = (q: Question) =>
    (picked[q.question] ?? []).map((v) => (v === OTHER ? (other[q.question] ?? '').trim() : v)).filter(Boolean).join(', ');
  const complete = questions.every((q) => answerFor(q));
  const toggle = (q: Question, value: string) => {
    const cur = picked[q.question] ?? [];
    const next = !q.multiSelect ? [value] : cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value];
    setDraft({ ...draft, picked: { ...picked, [q.question]: next } });
  };

  return (
    <CardShell pending={canAct} title={t('req.asks')}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!complete) return;
          void respond({ kind: 'question', answers: Object.fromEntries(questions.map((q) => [q.question, answerFor(q)])) });
        }}
      >
        {questions.map((q) => {
          const type = q.multiSelect ? 'checkbox' : 'radio';
          const chosen = picked[q.question] ?? [];
          return (
            <fieldset key={q.question} disabled={!canAct} className="flex flex-col gap-1">
              <legend className="selectable mb-1 text-[13px] text-soft">{q.question}</legend>
              {(q.options ?? []).map((o) => (
                <label key={o.label} className="flex items-start gap-2 rounded-md border border-line2 px-2.5 py-1.5 has-checked:border-accent-deep has-checked:bg-accent-bg">
                  <input type={type} name={q.question} className="mt-0.5 flex-none accent-accent" checked={chosen.includes(o.label)} onChange={() => toggle(q, o.label)} />
                  <span className="min-w-0">
                    <span className="block text-soft">{o.label}</span>
                    {o.description && <span className="block text-xs text-dim">{o.description}</span>}
                  </span>
                </label>
              ))}
              <label className="flex items-center gap-2 rounded-md border border-line2 px-2.5 py-1.5 has-checked:border-accent-deep">
                <input type={type} name={q.question} className="flex-none accent-accent" checked={chosen.includes(OTHER)} onChange={() => toggle(q, OTHER)} />
                <Input
                  aria-label={t('req.ownAnswer')}
                  placeholder={t('req.ownAnswer')}
                  value={other[q.question] ?? ''}
                  onFocus={() => !chosen.includes(OTHER) && toggle(q, OTHER)}
                  onChange={(e) => setDraft({ ...draft, other: { ...other, [q.question]: e.target.value } })}
                  className="border-0 bg-transparent p-0"
                />
              </label>
            </fieldset>
          );
        })}
        {item.decision !== null && <Resolved decision={item.decision} />}
        {canAct && (
          <div>
            <Button type="submit" variant="primary" disabled={!complete || busy}>
              {t('req.answer')}
            </Button>
          </div>
        )}
      </form>
    </CardShell>
  );
}

function Plan({ item, tabId }: { item: Extract<RequestItem, { type: 'plan' }>; tabId: string | null }) {
  const { busy, respond } = useRespond(tabId, item.requestId);
  const [rejecting, setRejecting] = useState(false);
  const [message, setMessage] = useCardDraft(tabId, item, '');
  const canAct = !!tabId && item.decision === null;
  return (
    <CardShell pending={canAct} title={t('req.planTitle')}>
      <div className="mb-3 max-h-96 overflow-auto rounded-md border border-line2 bg-bg p-3">
        <Markdown text={item.plan} small />
      </div>
      {item.decision !== null && <Resolved decision={item.decision} />}
      {canAct &&
        (rejecting ? (
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void respond({ kind: 'plan', approve: false, message: message.trim() || undefined });
            }}
          >
            <Textarea autoFocus rows={2} value={message} onChange={(e) => setMessage(e.target.value)} placeholder={t('req.planFix')} />
            <div className="flex gap-2">
              <Button type="submit" disabled={busy}>
                {t('req.planReturn')}
              </Button>
              <Button variant="ghost" onClick={() => setRejecting(false)}>
                {t('common.back')}
              </Button>
            </div>
          </form>
        ) : (
          <div className="flex gap-2">
            <Button variant="primary" disabled={busy} onClick={() => respond({ kind: 'plan', approve: true })}>
              {t('req.planApprove')}
            </Button>
            <Button disabled={busy} onClick={() => setRejecting(true)}>
              {t('req.planRework')}
            </Button>
          </div>
        ))}
    </CardShell>
  );
}

export function RequestCard({ item, tabId }: { item: RequestItem; tabId: string | null }) {
  if (item.type === 'permission') return item.tool === KIT_APPLY_TOOL ? <KitPlanCard item={item} tabId={tabId} /> : <Permission item={item} tabId={tabId} />;
  if (item.type === 'question') return <QuestionForm item={item} tabId={tabId} />;
  return <Plan item={item} tabId={tabId} />;
}
