import { Pencil } from 'lucide-react';
import { t } from '@/lib/i18n';
import { runMicrotask } from '@/lib/microtask';
import type { MenuItem } from './ActionMenu';

/** claude.change on a built-in panel. A panel is code of the app: Claude edits it, in a new tab of Claude OS itself by default. */
export function panelChangeItem(name: string, file: string, project: string | null): MenuItem {
  const label = t('custom.panel', { name });
  return { id: 'claude.change', label: t('claude.change'), title: label, icon: Pencil, onSelect: () => runMicrotask({ id: 'panel-change', vars: { panel: name, file }, project, title: label }) };
}
