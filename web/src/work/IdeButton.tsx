import * as Popover from '@radix-ui/react-popover';
import { ChevronDown, Code2, Settings } from 'lucide-react';
import { useState } from 'react';
import { ProgramIcon } from '@/components/ProgramIcon';
import { Button } from '@/components/ui';
import { api, useApi } from '@/lib/api';
import { t } from '@/lib/i18n';
import { toastError, useApp } from '@/lib/store';
import type { IdeEntry, ProjectIde, Tab } from '@/lib/types';

/** The project's IDE as the main button, every other one in the dropdown. */
export function IdeButton({ tab }: { tab: Tab }) {
  const query = useApi<ProjectIde>(tab.project ? `/api/ides/project/${encodeURIComponent(tab.project)}` : null, ['settings']);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!tab.project) return null;
  const data = query.data;

  const launch = async (ide: IdeEntry) => {
    setBusy(true);
    try {
      await api('/api/ides/open', { method: 'POST', body: { ide: ide.id, project: tab.project, cwd: tab.cwd } });
      setOpen(false);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  // Picking another IDE changes the project's IDE; the main button then opens that one.
  const change = async (ide: IdeEntry) => {
    await launch(ide);
    try {
      await api(`/api/settings/project/${encodeURIComponent(tab.project!)}`, { method: 'PUT', body: { ide: ide.id } });
      query.refetch();
    } catch (e) {
      toastError(e);
    }
  };

  const go = useApp.getState().go;

  if (!data?.chosen) {
    return (
      <Button className="flex-none" title={t('ide.noneTitle')} onClick={() => go({ kind: 'settings', section: 'ides' })}>
        <Code2 size={12} />{t('ide.none')}
      </Button>
    );
  }

  return (
    <div className="flex flex-none items-stretch">
      <Button className="rounded-r-none border-r-0" disabled={busy} title={data.auto && data.marker ? t('ide.autoTitle', { marker: data.marker }) : undefined} onClick={() => launch(data.chosen!)}>
        <ProgramIcon id={data.chosen.catalogId} name={data.chosen.name} size={16} />{data.chosen.name}
      </Button>
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          <Button aria-label={t('ide.others')} title={t('ide.others')} className="rounded-l-none px-1.5"><ChevronDown size={12} /></Button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content align="end" sideOffset={6} className="enter-pop popover z-50 w-64 rounded-xl p-1 outline-none">
            {data.others.length === 0 && <p className="px-2.5 py-1.5 text-xs text-dim">{t('ide.onlyOne')}</p>}
            {data.others.map((ide) => (
              <button key={ide.id} type="button" disabled={busy} onClick={() => change(ide)} title={ide.exe} className="press flex w-full min-w-0 items-center gap-2 rounded-md px-2.5 py-1 text-left text-muted hover:bg-raised hover:text-fg">
                <ProgramIcon id={ide.catalogId} name={ide.name} size={16} /><span className="truncate">{ide.name}</span>
              </button>
            ))}
            <div className="mt-1 border-t border-line2 pt-1">
              <button type="button" onClick={() => { setOpen(false); go({ kind: 'settings', section: 'ides' }); }} className="press flex w-full items-center gap-2 rounded-md px-2.5 py-1 text-left text-xs text-dim hover:bg-raised hover:text-fg">
                <Settings size={11} />{t('ide.settings')}
              </button>
            </div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}
