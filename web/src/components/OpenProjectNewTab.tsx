import { SquarePlus } from 'lucide-react';
import { t } from '@/lib/i18n';
import { createTab } from '@/lib/tabs';
import { IconButton } from './ui';

/** Always a new tab, next to the button that opens the existing one. */
export function OpenProjectNewTab({ project, name, className }: { project: string; name: string; className?: string }) {
  return (
    <IconButton label={t('projects.newTab', { name })} className={className} onClick={() => void createTab({ project })}>
      <SquarePlus size={13} />
    </IconButton>
  );
}
