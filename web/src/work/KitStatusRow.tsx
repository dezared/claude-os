import { spendNote } from '@/lib/account';
import { LayoutTemplate } from 'lucide-react';
import { ClaudeMark } from '@/components/ClaudeMark';
import { Button } from '@/components/ui';
import { t } from '@/lib/i18n';
import { kitStatusText, runKitTask, useKitStatus } from '@/lib/projectKit';

/** The kit's status and the button that starts the project-kit microtask; nothing while no kit plugin is enabled. */
export function KitStatusRow({ project, root }: { project: string; root: string }) {
  const status = kitStatusText(useKitStatus().data, project);
  if (status === null) return null;
  return (
    <div>
      <Button className="w-full" title={spendNote()} onClick={() => runKitTask(project, root)}>
        <LayoutTemplate size={13} />{t('kit.menu')}<span className="text-dim">{status}</span><ClaudeMark size={11} />
      </Button>
      <p className="mt-1 text-[11px] leading-[1.4] text-dim">{t('kit.hint')}</p>
    </div>
  );
}
