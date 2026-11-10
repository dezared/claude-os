import { Folder } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ErrorState } from './states';
import { Button, Dialog, Input } from './ui';
import { api } from '@/lib/api';
import { cn } from '@/lib/format';
import { t } from '@/lib/i18n';
import { toast, useApp } from '@/lib/store';
import type { Project } from '@/lib/types';

export function ConnectFolderDialog() {
  const open = useApp((s) => s.connectOpen);
  const setOpen = useApp((s) => s.setConnectOpen);
  const [path, setPath] = useState('');
  const [dirs, setDirs] = useState<string[]>([]);
  const [active, setActive] = useState(-1);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPath('');
    setDirs([]);
    setError(null);
  }, [open]);

  useEffect(() => {
    if (!open || !path.trim()) {
      setDirs([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      api<string[]>(`/api/fs/dirs?path=${encodeURIComponent(path.trim())}`)
        .then((list) => {
          if (cancelled) return;
          setDirs(list.filter((d) => d !== path.trim()));
          setActive(-1);
        })
        .catch(() => !cancelled && setDirs([]));
    }, 90);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [path, open]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!path.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const p = await api<Project>('/api/projects/connect', { method: 'POST', body: { path: path.trim() } });
      toast(t('connect.done', { name: p.name }));
      setOpen(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const pick = (d: string) => setPath(`${d}/`);

  return (
    <Dialog open={open} onOpenChange={setOpen} title={t('connect.title')} description={t('connect.desc')} width={560}>
      <form onSubmit={submit} className="flex flex-col gap-3">
        {error && <ErrorState message={error} />}
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted">{t('connect.path')}</span>
          <Input
            autoFocus
            value={path}
            spellCheck={false}
            placeholder="/home/…"
            className="font-mono text-xs"
            role="combobox"
            aria-expanded={dirs.length > 0}
            aria-controls="connect-dirs"
            onChange={(e) => setPath(e.target.value)}
            onKeyDown={(e) => {
              if (dirs.length === 0) return;
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((a) => (a + 1) % dirs.length);
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((a) => (a - 1 + dirs.length) % dirs.length);
              } else if (e.key === 'Tab' && !e.shiftKey) {
                e.preventDefault();
                pick(dirs[Math.max(0, active)]);
              } else if (e.key === 'Enter' && active >= 0) {
                e.preventDefault();
                pick(dirs[active]);
              }
            }}
          />
        </label>
        {dirs.length > 0 && (
          <div id="connect-dirs" role="listbox" className="max-h-52 overflow-auto rounded-lg bg-white/[.035] p-1">
            {dirs.map((d, i) => (
              <button
                key={d}
                type="button"
                role="option"
                aria-selected={i === active}
                tabIndex={-1}
                onClick={() => pick(d)}
                className={cn('flex w-full items-center gap-2 rounded-md px-2 py-1 text-left font-mono text-xs', i === active ? 'bg-raised text-fg' : 'text-muted hover:bg-raised hover:text-fg')}
              >
                <Folder size={12} className="flex-none text-dim" />
                <span className="min-w-0 truncate">{d}</span>
              </button>
            ))}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button onClick={() => setOpen(false)}>{t('common.cancel')}</Button>
          <Button type="submit" variant="primary" disabled={busy || !path.trim()}>{t('connect.submit')}</Button>
        </div>
      </form>
    </Dialog>
  );
}
