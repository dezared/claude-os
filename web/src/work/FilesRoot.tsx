import { ArrowUp, Undo2 } from 'lucide-react';
import { Fragment, useState } from 'react';
import { IconButton } from '@/components/ui';
import { useApi } from '@/lib/api';
import { cn } from '@/lib/format';
import { t } from '@/lib/i18n';
import type { FileRoot } from '@/lib/types';

const roots = new Map<string, string>();

/** The folder a tab's tree lists from, null for the session's own. Per tab and in memory only: the session never moves. */
export function useTreeRoot(tabId: string): [string | null, (root: string | null) => void] {
  const [root, setRoot] = useState(() => roots.get(tabId) ?? null);
  return [root, (next) => {
    if (next === null) roots.delete(tabId);
    else roots.set(tabId, next);
    setRoot(next);
  }];
}

/** The path the tree is listed from, cut from the left when long; the folders the tab may read are links. */
export function RootBar({ tabId, root, onRoot }: { tabId: string; root: string | null; onRoot: (root: string | null) => void }) {
  const info = useApi<FileRoot>(`/api/tabs/${encodeURIComponent(tabId)}/tree/root${root ? `?root=${encodeURIComponent(root)}` : ''}`).data;
  const back = root && <IconButton label={t('files.toSession')} className="size-6" onClick={() => onRoot(null)}><Undo2 size={12} /></IconButton>;
  if (!info) return <div className="flex h-7 flex-none items-center justify-end border-b border-line2 pr-1">{back}</div>;
  const up = info.parent;
  const go = (path: string) => onRoot(path === info.cwd ? null : path);
  const list = info.crumbs;
  return (
    <div className="flex h-7 flex-none items-center gap-0.5 border-b border-line2 pr-1 pl-1">
      <IconButton label={t('files.up')} className="size-6" disabled={!up} onClick={() => up && go(up)}><ArrowUp size={12} /></IconButton>
      {/* Flex-end overflows to the left: the end of a long path stays in view. */}
      <div role="navigation" aria-label={t('files.rootAria')} data-testid="files-root" title={info.path} className="flex min-w-0 flex-1 justify-end overflow-hidden font-mono text-[11px] whitespace-nowrap">
        {list.map((c, i) => (
          <Fragment key={c.path}>
            {/* The filesystem root or a drive already ends in its separator. */}
            {i > 0 && !/[\\/]$/.test(list[i - 1].name) && <span className="flex-none text-dim">/</span>}
            {i < list.length - 1 && c.reach ? (
              <button type="button" className="press flex-none text-muted hover:text-fg" onClick={() => go(c.path)}>{c.name}</button>
            ) : (
              <span className={cn('flex-none', i === list.length - 1 ? 'text-soft' : 'text-dim')}>{c.name}</span>
            )}
          </Fragment>
        ))}
      </div>
      {back}
    </div>
  );
}
