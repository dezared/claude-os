import { LayoutTemplate } from 'lucide-react';
import { useMemo } from 'react';
import { SWATCHES } from '@/home/universe/colors';
import { useApi } from '@/lib/api';
import { cn } from '@/lib/format';
import { t } from '@/lib/i18n';
import { useApp } from '@/lib/store';
import type { OsPluginsReport } from '../../../shared/contract.ts';
import type { KitContents, KitSetsReport } from '../../../shared/projectKit.ts';

export interface ProjectKit { id: string; name: string; contents: KitContents | null }

const PARTS = ['rules', 'agents', 'skills', 'checks', 'hooks'] as const;

function kitsByProject(kits: KitSetsReport, plugins: OsPluginsReport['rows']): Map<string, ProjectKit> {
  const out = new Map<string, ProjectKit>();
  for (const p of kits.projects) {
    if (!p.kit) continue;
    const id = p.kit.id;
    out.set(p.key, { id, name: plugins.find((r) => r.id === id)?.name ?? id, contents: kits.kits.find((k) => k.id === id)?.contents ?? null });
  }
  return out;
}

/** The kit each project is built on, by project key: a project missing from the map has none; null while loading. */
export function useProjectKits(): Map<string, ProjectKit> | null {
  const kits = useApi<KitSetsReport>('/api/project-kit/kits', ['projectKit', 'osPlugins']);
  const plugins = useApi<OsPluginsReport>('/api/os-plugins', ['osPlugins']);
  return useMemo(() => (kits.data ? kitsByProject(kits.data, plugins.data?.rows ?? []) : null), [kits.data, plugins.data]);
}

/** One colour per kit, stable across reloads: the same kit reads the same in every row. */
export function kitColor(id: string): string {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return SWATCHES[h % SWATCHES.length];
}

/** The tooltip: the kit's name and what it puts into a project, in Markdown the app's tooltip renders. */
function kitTip(kit: ProjectKit): string {
  const c = kit.contents;
  const parts = c ? [c.claudeMd ? '- CLAUDE.md' : '', ...PARTS.filter((k) => c[k].length > 0).map((k) => `- ${t(`kits.part.${k}`)}: ${c[k].length}`)].filter(Boolean) : [];
  return [`**${t('projectsScreen.kitTip', { name: kit.name })}**`, parts.join('\n'), t('projectsScreen.kitOpen')].filter(Boolean).join('\n\n');
}

/** A small coloured mark of the project's kit; a click opens that kit on the kits screen. */
export function KitBadge({ kit, className }: { kit: ProjectKit; className?: string }) {
  return (
    <button
      type="button"
      aria-label={t('projectsScreen.kitTip', { name: kit.name })}
      title={kitTip(kit)}
      onClick={(e) => {
        e.stopPropagation();
        useApp.getState().go({ kind: 'kits', id: kit.id });
      }}
      className={cn('press motion-fade flex size-5 flex-none items-center justify-center rounded-md transition-[background-color,transform] duration-150 hover:scale-110 hover:bg-fg/[.08]', className)}
    >
      <LayoutTemplate size={12} style={{ color: kitColor(kit.id) }} />
    </button>
  );
}
