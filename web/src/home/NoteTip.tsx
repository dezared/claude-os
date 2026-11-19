import { useMemo } from 'react';
import { fmtAgo, fmtInt } from '@/lib/format';
import { has, t, tn } from '@/lib/i18n';
import type { MemoryGraph, MemoryNode } from '@/lib/types';

const RELATED_SHOWN = 3;

/** The hovered note's neighbours on the map, the most linked first. */
function useRelated(node: MemoryNode, graph: Pick<MemoryGraph, 'nodes' | 'edges'> | null): MemoryNode[] {
  return useMemo(() => {
    if (!graph) return [];
    const ids = new Set(graph.edges.flatMap(([a, b]) => (a === node.id ? [b] : b === node.id ? [a] : [])));
    return graph.nodes.filter((n) => ids.has(n.id)).sort((a, b) => b.degree - a.degree || a.title.localeCompare(b.title));
  }, [node, graph]);
}

/** The card of a hovered star: what the note's frontmatter says, laid out to be read at a glance. Internal keys never get here. */
export function NoteTip({ node, graph, projectName }: { node: MemoryNode; graph: Pick<MemoryGraph, 'nodes' | 'edges'> | null; projectName: (key: string | null) => string }) {
  const related = useRelated(node, graph);
  const typeKey = `universe.noteType.${node.type}`;
  const more = related.length - RELATED_SHOWN;
  return (
    <>
      <div className="flex items-start gap-2">
        <b className="min-w-0 flex-1 font-medium wrap-anywhere text-fg">{node.title}</b>
        {node.type && <span data-tip-type className="mt-px flex-none rounded bg-accent-bg px-1.5 py-px text-[10px] font-medium tracking-wide text-accent uppercase">{has(typeKey) ? t(typeKey) : node.type}</span>}
      </div>
      {node.summary && <span className="mt-0.5 block text-[12px] leading-snug wrap-anywhere text-soft">{node.summary}</span>}
      {node.tags.length > 0 && (
        <span className="mt-1.5 flex flex-wrap gap-1">
          {node.tags.map((tag) => (
            <span key={tag} data-tip-tag className="rounded-full border border-line2 px-1.5 text-[10.5px] leading-[16px] text-soft">#{tag}</span>
          ))}
        </span>
      )}
      {related.length > 0 && (
        <span className="mt-1.5 block text-[11px] leading-snug wrap-anywhere text-muted">
          {t('universe.tipRelated')} {related.slice(0, RELATED_SHOWN).map((n) => n.title).join(', ')}
          {more > 0 && ` +${fmtInt(more)}`}
        </span>
      )}
      <small className="mt-1.5 block border-t border-line2 pt-1 text-[11px] text-muted">
        {projectName(node.project)} · {fmtInt(node.degree)} {tn('unit.link', node.degree)} · {t('universe.tipModified', { ago: fmtAgo(node.modified ?? node.mtime) })}
        {!node.connected && ` · ${t('universe.readOnly')}`}
      </small>
    </>
  );
}
