import * as Popover from '@radix-ui/react-popover';
import { FileText, Info, Maximize, Minus, Plus, Search, X } from 'lucide-react';
import { useEffect, useMemo, useState, type RefObject } from 'react';
import { ErrorState, Spinner } from '@/components/states';
import { IconButton } from '@/components/ui';
import type { Query } from '@/lib/api';
import { fmtInt, shortPath } from '@/lib/format';
import { t, tn } from '@/lib/i18n';
import { useApp } from '@/lib/store';
import type { MemoryGraph } from '@/lib/types';
import { Snippet, useMemorySearch } from '@/lib/useMemorySearch';
import type { Universe } from './universe/Universe';

/** The instrument line over the map: what is here and how to find it. Search lights the matching stars. */
export function UniverseHud({
  graph,
  universe,
  onHighlight,
}: {
  graph: Query<MemoryGraph>;
  universe: RefObject<Universe | null>;
  onHighlight: (ids: Set<string> | null) => void;
}) {
  const [query, setQuery] = useState('');
  const openNote = useApp((s) => s.openNote);
  const data = graph.data;
  const count = data?.nodes.length ?? 0;

  const matches = useMemorySearch(query, 20);

  useEffect(() => onHighlight(matches ? new Set(matches.map((n) => n.id)) : null), [matches, onHighlight]);
  useEffect(() => () => onHighlight(null), [onHighlight]); // gone to the trash mid-search: the stars go out with it

  const groups = useMemo(() => new Set(data?.nodes.map((n) => n.project)).size, [data]);

  return (
    <div className="flex w-full max-w-[520px] flex-col items-center gap-2">
      <div className="glass flex w-full items-center gap-3 rounded-full py-1 pr-1 pl-4">
        {data ? (
          <div className="flex flex-none items-baseline gap-1.5 whitespace-nowrap">
            <b className="text-[15px] leading-none font-semibold tracking-[-.01em]">{fmtInt(count)}</b>
            <small className="text-xs text-muted">{t('universe.inMemory', { notes: tn('unit.note', count) })}</small>
            {groups > 0 && <small className="hidden text-xs text-dim min-[1440px]:inline">· {fmtInt(groups)} {tn('unit.constellation', groups)}</small>}
          </div>
        ) : graph.error ? (
          <span className="text-xs text-muted">{t('universe.noData')}</span>
        ) : (
          <div className="flex flex-none items-center gap-2 text-xs text-muted">
            <Spinner size={12} />
            {t('universe.reading')}
          </div>
        )}
        {count > 0 && (
          <div className="relative min-w-0 flex-1">
            <Search size={13} className="pointer-events-none absolute top-1.75 left-2.5 text-dim" />
            <input
              aria-label={t('universe.searchAria')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
              placeholder={t('universe.searchPlaceholder')}
              className="h-7 w-full rounded-full border border-transparent bg-white/[.07] pr-7 pl-7.5 text-xs text-fg transition-colors duration-150 outline-none placeholder:text-dim hover:bg-white/10 focus:border-accent-deep focus:bg-white/10"
            />
            {query && (
              <button type="button" aria-label={t('common.clear')} onClick={() => setQuery('')} className="press absolute top-1.25 right-1.5 flex size-4.5 items-center justify-center rounded-full text-dim hover:bg-white/10 hover:text-fg">
                <X size={11} />
              </button>
            )}
          </div>
        )}
      </div>

      {matches && (
        <div className="glass-strong enter-fade max-h-[42vh] w-full overflow-auto rounded-xl p-1.5">
          <div className="px-2 py-1 text-[11px] text-muted">{matches.length === 0 ? t('common.nothingFound') : t('universe.found', { n: fmtInt(matches.length) })}</div>
          {matches.map((n) => (
            <button
              key={n.id}
              type="button"
              onClick={() => {
                openNote(n.id);
                universe.current?.flyTo(n.project);
              }}
              className="press flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-raised"
            >
              <FileText size={13} className="flex-none text-dim" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px]">{n.name}</span>
                <span className="block truncate text-[11px] text-dim"><Snippet text={n.snippet} /></span>
              </span>
              <span className="max-w-40 flex-none truncate text-[11px] text-dim">{n.project ?? t('universe.globalGroup')}</span>
            </button>
          ))}
        </div>
      )}

    </div>
  );
}

/** What the map has to say about itself stays on the screen whatever happened to the widget above. */
export function UniverseStatus({ graph, unsupported }: { graph: Query<MemoryGraph>; unsupported: boolean }) {
  const data = graph.data;
  const count = data?.nodes.length ?? 0;
  return (
    <>
      {unsupported && <div role="status" className="glass rounded-xl px-4 py-3 text-center text-[13px] text-soft">{t('universe.noWebgl')}</div>}
      {graph.error && !data && <ErrorState className="glass-strong w-80 rounded-xl" message={t('universe.unavailable', { error: graph.error })} onRetry={graph.refetch} />}
      {data && count === 0 && (
        <div className="glass mt-[18vh] w-96 rounded-2xl p-5 text-center text-[13px] text-muted">
          {t('universe.empty')}
          {!data.vaultExists && (
            <div className="mt-2 text-xs text-dim">
              {t('universe.noVault')} <span className="font-mono">{shortPath(data.vaultPath)}</span>
            </div>
          )}
        </div>
      )}
    </>
  );
}

/** Zoom, reset and the legend. Reset also answers double click on empty space. */
export function ViewControls({ graph, universe }: { graph: Query<MemoryGraph>; universe: RefObject<Universe | null> }) {
  const data = graph.data;
  const hasVault = data?.nodes.some((n) => n.connected);
  const hasReadOnly = data?.nodes.some((n) => !n.connected);
  return (
    <div className="glass flex flex-col items-center gap-0.5 rounded-xl p-1">
      <IconButton label={t('universe.zoomIn')} onClick={() => universe.current?.zoomBy(0.72)}><Plus size={14} /></IconButton>
      <IconButton label={t('universe.zoomOut')} onClick={() => universe.current?.zoomBy(1.38)}><Minus size={14} /></IconButton>
      <IconButton label={t('universe.reset')} onClick={() => universe.current?.resetView()}><Maximize size={13} /></IconButton>
      <Popover.Root>
        <Popover.Trigger asChild>
          <IconButton label={t('universe.legend')}><Info size={13} /></IconButton>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content side="left" align="end" sideOffset={8} className="popover enter-pop z-50 w-72 rounded-xl p-3 text-xs outline-none">
            <h3 className="mb-2 text-[13px] font-medium">{t('universe.legend')}</h3>
            <ul className="flex flex-col gap-1.5 text-muted">
              <li>{t('universe.legendColor')}</li>
              <li className="flex items-center gap-2"><i className="size-2 flex-none rounded-full bg-[#7fd4ff]" /> {t('universe.legendActive')}</li>
              <li className="flex items-center gap-2"><i className="size-2 flex-none rounded-full bg-[#7fd4ff] opacity-50" /> {t('universe.legendInactive')}</li>
              <li className="flex items-center gap-2"><i className="h-0.5 w-3 flex-none bg-white/85" /> {t('universe.legendLinks')}</li>
              <li className="flex items-center gap-2"><i className="h-px w-3 flex-none bg-white/30" /> {t('universe.legendSkeleton')}</li>
              <li>{t('universe.legendStars')}</li>
              <li>{t('universe.legendOrbits')}</li>
              {hasVault && hasReadOnly && <li>{t('universe.legendReadOnly')}</li>}
              <li>{t('universe.legendDust')}</li>
            </ul>
            <p className="mt-2.5 border-t border-line2 pt-2 text-dim">{t('universe.hints')}</p>
            {!!data?.unresolved && <p className="mt-1.5 text-dim">{t('universe.unresolved', { n: fmtInt(data.unresolved) })}</p>}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}

/** The count in the widget's title when the pill itself is folded away. */
export function NotesCount({ graph }: { graph: Query<MemoryGraph> }) {
  return graph.data ? <span className="flex-none text-[11.5px] text-muted">{fmtInt(graph.data.nodes.length)}</span> : null;
}
