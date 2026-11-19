import { Folder, X } from 'lucide-react';
import { spendNote } from '@/lib/account';
import { api, setCached, useApi } from '@/lib/api';
import { t } from '@/lib/i18n';
import { runMicrotask } from '@/lib/microtask';
import { toastError } from '@/lib/store';
import type { Project, ProjectIcons } from '@/lib/types';
import { ClaudeMark } from './ClaudeMark';
import { IconTile, MaskGlyph } from './IconTile';
import { Button, IconButton } from './ui';

const useIcons = () => useApi<ProjectIcons>('/api/project-icons', ['projects']);

/** The chosen library icon in the project's colour, a custom SVG, a folder or a monogram: all in the same tile. An img can run nothing and load nothing. */
export function ProjectIcon({ project, name, color, size = 16, dim, folder }: { project: string | null; name: string; color: string; size?: number; dim?: boolean; folder?: boolean }) {
  const data = useIcons().data;
  const key = project ?? '';
  const svg = data?.icons[key];
  const letter = name.replace(/^[^\p{L}\p{N}]+/u, '').slice(0, 1).toUpperCase() || '·';
  return (
    <IconTile ink={color} size={size} dim={dim}>
      {folder ? <Folder /> : svg && data?.chosen[key] ? <MaskGlyph svg={svg} /> : svg ? <img alt="" src={`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`} /> : <b style={{ fontSize: size * 0.56 }}>{letter}</b>}
    </IconTile>
  );
}

export function askForIcons(dir: string, projects: Project[], existing: Record<string, string>) {
  const missing = projects.filter((p) => !p.misc && !existing[p.key]);
  runMicrotask({ id: 'project-icons', vars: { dir, projects: missing.map((p) => `- ${p.key}: ${p.root}`).join('\n') || 'none' } });
}

/** One line, once: nothing is sent until the dialog's button. */
export function ProjectIconsOffer() {
  const icons = useIcons();
  const projects = useApi<Project[]>('/api/projects', ['projects']);
  const data = icons.data;
  if (!data || data.offerDismissed || Object.keys(data.icons).length > 0) return null;
  const list = (projects.data ?? []).filter((p) => !p.misc);
  if (list.length === 0) return null;

  const dismiss = async () => {
    try {
      const next = await api<ProjectIcons>('/api/project-icons/dismiss-offer', { method: 'POST' });
      setCached<ProjectIcons>('/api/project-icons', () => next);
    } catch (e) {
      toastError(e);
    }
  };

  return (
    <aside aria-label={t('icons.offerAria')} style={{ pointerEvents: 'auto' }} className="enter-fade flex flex-none items-center gap-3 border-b border-line2 bg-panel px-4 py-1 text-xs">
      <ClaudeMark size={12} />
      <span className="min-w-0 truncate text-muted">{t('icons.offer', { n: list.length })}</span>
      <span className="ml-auto flex flex-none items-center gap-2">
        <Button size="sm" title={spendNote()} onClick={() => { void dismiss(); askForIcons(data.dir, list, data.icons); }}>{t('icons.offerAction')}</Button>
        <IconButton label={t('common.hide')} className="size-6" onClick={dismiss}><X size={12} /></IconButton>
      </span>
    </aside>
  );
}
