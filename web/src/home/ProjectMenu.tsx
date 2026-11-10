import { ArrowRightLeft, Code2, CopyPlus, EyeOff, History, LayoutTemplate, Locate, MapPinPlus, Plus, SquareTerminal, Trash2 } from 'lucide-react';
import { claudeItems } from '@/components/ContextMenu';
import { iconMenuItem } from '@/components/IconPicker';
import { api } from '@/lib/api';
import { t } from '@/lib/i18n';
import { kitMenuLabel, runKitTask } from '@/lib/projectKit';
import { toast, toastError } from '@/lib/store';
import { createTab } from '@/lib/tabs';
import type { Project } from '@/lib/types';
import type { MenuItem } from './ActionMenu';
import { setOnMap } from './universe/menu';

// Hidden while no kit plugin is enabled.
function kitItems(project: Project): MenuItem[] {
  const label = kitMenuLabel(project.key);
  return label ? [{ id: 'kit', label, icon: LayoutTemplate, onSelect: () => runKitTask(project.key, project.root) }] : [];
}

/** Everything one can do with a project: the right-click menu of its row, its popover and its badge. The row itself only opens it. */
export function projectItems(
  project: Project,
  { onSessions, onFly, mapped, onMigrate, onRemove }: { onSessions?: () => void; onFly?: () => void; mapped?: boolean; onMigrate: () => void; onRemove: () => void },
): MenuItem[] {
  const canMigrate = project.memoryCount > 0 && (!project.memoryConnected || project.memoryDrift > 0);
  return [
    { id: 'new', label: t('project.newSession'), icon: Plus, onSelect: () => void createTab({ project: project.key }) },
    ...(project.liveCount > 0 && onSessions ? [{ id: 'sessions', label: t('projects.menuSessions', { n: project.liveCount }), icon: History, onSelect: onSessions }] : []),
    ...(onFly ? [{ id: 'map', label: t('projects.menuMap'), icon: Locate, onSelect: onFly }] : []),
    ...(mapped === undefined ? [] : [{ id: 'map.toggle', label: t(mapped ? 'projects.mapRemove' : 'projects.mapAdd'), icon: mapped ? EyeOff : MapPinPlus, onSelect: () => setOnMap(project.key, !mapped) }]),
    {
      id: 'terminal',
      label: t('projects.menuTerminal'),
      icon: SquareTerminal,
      apart: true,
      onSelect: () => void api('/api/actions/builtin:shell/run', { method: 'POST', body: { project: project.key, cwd: project.root } }).catch(toastError),
    },
    // Without an `ide` the server opens the project's own choice and says so when there is none.
    { id: 'ide', label: t('git.openIde'), icon: Code2, onSelect: () => void api('/api/ides/open', { method: 'POST', body: { project: project.key, cwd: project.root } }).catch(toastError) },
    {
      id: 'path',
      label: t('projects.menuCopyPath'),
      icon: CopyPlus,
      title: project.root,
      onSelect: () => void navigator.clipboard.writeText(project.root).then(() => toast(t('projects.pathCopied')), toastError),
    },
    ...kitItems(project),
    iconMenuItem(project),
    ...claudeItems({ kind: 'project', name: project.name, context: `Project folder: ${project.root}`, project: project.key }).map((item, i) => ({ ...item, apart: i === 0 })),
    ...(canMigrate ? [{ id: 'migrate', label: t('projects.menuMigrate'), icon: ArrowRightLeft, apart: true, onSelect: onMigrate }] : []),
    { id: 'remove', label: t('project.remove'), icon: Trash2, danger: true, apart: true, onSelect: onRemove },
  ];
}
