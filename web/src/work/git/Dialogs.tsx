import { Upload, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { ClaudeMark } from '@/components/ClaudeMark';
import { ErrorState, Skeleton } from '@/components/states';
import { Button, Checkbox, Dialog, Field, IconButton, Input, Select } from '@/components/ui';
import { spendNote } from '@/lib/account';
import { api } from '@/lib/api';
import { fmtInt } from '@/lib/format';
import { t } from '@/lib/i18n';
import { toast } from '@/lib/store';
import type { GitPushPreview } from '@/lib/types';

export interface GitOp {
  path: string;
  body?: unknown;
  action: string;
  permission: string;
  /** A checkout the dirty tree can block: offer stash and a second try. */
  checkout?: boolean;
  quiet?: boolean;
}

export type GitFailure = { action: string; permission: string; error: string; retry?: GitOp };

/** Git's words as they are, with the two ways out. */
export function FailureStrip({ failure, busy, onFix, onStashRetry, onHide }: { failure: GitFailure; busy: boolean; onFix: () => void; onStashRetry: () => void; onHide: () => void }) {
  return (
    <div role="alert" className="flex-none border-b border-accent-deep bg-accent-bg px-3 py-2">
      <div className="mb-1 flex items-center justify-between gap-2">
        <code className="min-w-0 truncate font-mono text-[11px] text-soft" title={failure.action}>{failure.action}</code>
        <IconButton label={t('common.hide')} className="-my-1 -mr-1 size-5.5" onClick={onHide}><X size={11} /></IconButton>
      </div>
      <pre className="selectable mb-2 max-h-36 overflow-auto font-mono text-[11px] leading-[1.45] whitespace-pre-wrap wrap-anywhere text-soft">{failure.error}</pre>
      <div className="flex flex-wrap items-center gap-2">
        {failure.retry && <Button size="sm" variant="primary" disabled={busy} onClick={onStashRetry}>{t('git.stashRetry')}</Button>}
        <Button size="sm" title={spendNote()} onClick={onFix}><ClaudeMark size={11} />{t('git.fix')}</Button>
      </div>
    </div>
  );
}

export interface AskRequest { title: string; body: string; action: string; }

export function ConfirmDialog({ ask, onAnswer }: { ask: AskRequest; onAnswer: (yes: boolean) => void }) {
  return (
    <Dialog open onOpenChange={(o) => !o && onAnswer(false)} title={ask.title}>
      <p className="mb-4 text-xs leading-[1.5] wrap-anywhere text-soft">{ask.body}</p>
      <div className="flex justify-end gap-2">
        <Button onClick={() => onAnswer(false)}>{t('common.cancel')}</Button>
        <Button variant="danger" onClick={() => onAnswer(true)}>{ask.action}</Button>
      </div>
    </Dialog>
  );
}

export function BranchNameDialog({ title, hint, initial, action, withCheckout, onClose, onSubmit }: {
  title: string; hint?: string; initial: string; action: string; withCheckout: boolean; onClose: () => void; onSubmit: (name: string, checkout: boolean) => void;
}) {
  const [name, setName] = useState(initial);
  const [checkout, setCheckout] = useState(true);
  const clean = name.trim();
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={title} description={hint} width={420}>
      <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); if (clean) onSubmit(clean, checkout); }}>
        <Field label={t('git.branchName')}>
          <Input autoFocus spellCheck={false} className="font-mono text-xs" value={name} onChange={(e) => setName(e.target.value)} onFocus={(e) => e.target.select()} />
        </Field>
        {withCheckout && <Checkbox checked={checkout} onChange={setCheckout}>{t('git.checkoutAfter')}</Checkbox>}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" variant="primary" disabled={!clean}>{action}</Button>
        </div>
      </form>
    </Dialog>
  );
}

export function PushDialog({ base, onClose, onDone, onFail }: { base: string; onClose: () => void; onDone: () => void; onFail: (f: GitFailure) => void }) {
  const [p, setP] = useState<GitPushPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [publish, setPublish] = useState<string | null>(null);

  // Never from a cache: the server compares what this shows with the branch at the moment of the push.
  const load = useCallback(() => {
    setError(null);
    api<GitPushPreview>(`${base}/push`).then((v) => {
      setP(v);
      setPublish(v.remotes.includes('origin') ? 'origin' : v.remotes[0] ?? null);
    }, (e: Error) => setError(e.message));
  }, [base]);
  useEffect(load, [load]);

  const newBranch = p && !p.upstream && p.branch && publish ? publish : null;
  const target = newBranch ? `${newBranch}/${p!.branch}` : p?.remote && p.remoteBranch ? `${p.remote}/${p.remoteBranch}` : p?.upstream ?? null;

  const push = async () => {
    if (!p) return;
    setBusy(true);
    try {
      const body = { branch: p.branch, remote: p.remote, ahead: p.ahead, ...(newBranch ? { publish: newBranch } : {}) };
      const res = await api<{ output: string }>(`${base}/push`, { method: 'POST', body });
      toast(res.output.split('\n').at(-1) || t('git.pushed'));
      onDone();
    } catch (e) {
      onFail({ action: `git push ${newBranch ?? p.remote ?? ''} ${p.branch ?? ''}`.trim(), permission: t('git.permPush', { branch: p.branch ?? '?', target: target ?? '?', n: p.ahead }), error: (e as Error).message });
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={t('git.pushTitle')}>
      {error && !p ? <ErrorState message={error} onRetry={load} /> : !p ? <Skeleton lines={3} /> : (
        <div className="flex flex-col gap-3">
          <dl className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1 text-xs">
            <dt className="text-dim">{t('git.branch')}</dt><dd className="font-mono text-soft">{p.branch ?? t('git.detached')}</dd>
            <dt className="text-dim">{t('git.remote')}</dt><dd className="font-mono text-soft">{target ?? t('git.noUpstream')}</dd>
            {newBranch && p.remotes.length > 1 && (
              <>
                <dt className="text-dim">{t('git.remoteRepo')}</dt>
                <dd><Select ariaLabel={t('git.remoteRepo')} className="text-xs" value={newBranch} onChange={setPublish} options={p.remotes.map((r) => ({ value: r, label: r }))} /></dd>
              </>
            )}
            <dt className="text-dim">{t('git.commitsCount')}</dt><dd className="text-soft">{fmtInt(newBranch ? p.commits.length : p.ahead)}</dd>
          </dl>
          {newBranch && <p className="text-xs text-soft">{t('git.publishNote', { target: target ?? '' })}</p>}
          {p.behind > 0 && <p className="text-xs text-accent">{t('git.behindWarn', { n: p.behind })}</p>}
          {p.commits.length > 0 && (
            <div className="max-h-40 overflow-auto rounded-md border border-line2 p-1.5">
              {p.commits.map((c) => <div key={c.hash} className="truncate text-xs text-muted"><span className="mr-1.5 font-mono text-dim">{c.short}</span>{c.subject}</div>)}
            </div>
          )}
          <p className="text-[11px] text-dim">{t('git.noForce')}</p>
          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>{t('common.cancel')}</Button>
            <Button variant="primary" disabled={busy} onClick={push}><Upload size={12} />{t('git.pushAction')}</Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
