import { Shapes } from 'lucide-react';
import { useEffect, useState } from 'react';
import { create } from 'zustand';
import type { MenuItem } from '@/home/ActionMenu';
import { api, setCached, useApi } from '@/lib/api';
import { spendNote } from '@/lib/account';
import { cn } from '@/lib/format';
import { t } from '@/lib/i18n';
import { toastError } from '@/lib/store';
import type { IconLibrary, Project, ProjectIcons } from '@/lib/types';
import { ClaudeMark } from './ClaudeMark';
import { askForIcons } from './ProjectIcon';
import { Button, Dialog, Input } from './ui';

const useTarget = create<{ project: Project | null }>(() => ({ project: null }));

export function iconMenuItem(project: Project): MenuItem {
  return { id: 'project.icon', label: t('icons.pick'), icon: Shapes, onSelect: () => useTarget.setState({ project }) };
}

const SEARCH_DELAY_MS = 150;

/** Mounted once. Opened by `iconMenuItem`: a search over the free libraries, picked per project. */
export function IconPicker() {
  const project = useTarget((s) => s.project);
  const close = () => useTarget.setState({ project: null });
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const icons = useApi<ProjectIcons>(project ? '/api/project-icons' : null, ['projects']);
  const library = useApi<IconLibrary>(project ? `/api/project-icons/library?q=${encodeURIComponent(query)}` : null);

  useEffect(() => {
    setText('');
    setQuery('');
  }, [project]);
  useEffect(() => {
    const timer = setTimeout(() => setQuery(text), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [text]);

  if (!project) return null;
  const current = icons.data?.chosen[project.key];

  const choose = async (icon: string | null) => {
    try {
      const next = await api<ProjectIcons>(`/api/project-icons/${encodeURIComponent(project.key)}`, { method: 'PUT', body: { icon } });
      setCached<ProjectIcons>('/api/project-icons', () => next);
      close();
    } catch (e) {
      toastError(e);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && close()} title={t('icons.pickTitle', { name: project.name })} description={t('icons.pickHint')} width={560}>
      <div className="flex flex-col gap-3">
        <Input autoFocus value={text} aria-label={t('icons.search')} placeholder={t('icons.search')} onChange={(e) => setText(e.target.value)} />
        <div role="group" aria-label={t('icons.pickAria')} className="grid min-h-40 grid-cols-[repeat(auto-fill,minmax(44px,1fr))] content-start gap-1">
          {library.data?.items.map((item) => (
            <button
              key={item.name}
              type="button"
              aria-label={item.name}
              aria-pressed={item.name === current}
              title={item.name}
              onClick={() => void choose(item.name)}
              className={cn('press flex h-11 items-center justify-center rounded-lg hover:bg-raised', item.name === current && 'bg-white/[.13]')}
            >
              <img alt="" className="size-5" src={`data:image/svg+xml;utf8,${encodeURIComponent(item.svg)}`} />
            </button>
          ))}
          {library.data?.items.length === 0 && <p className="col-span-full py-6 text-center text-xs text-muted">{t('icons.nothing')}</p>}
        </div>
        {library.data && library.data.total > library.data.items.length && <p className="text-xs text-dim">{t('icons.narrow', { n: library.data.total })}</p>}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button
            size="sm"
            title={spendNote()}
            disabled={!icons.data}
            onClick={() => {
              if (icons.data) askForIcons(icons.data.dir, [project], {});
              close();
            }}
          >
            <ClaudeMark size={12} />{t('icons.byClaude')}
          </Button>
          {current && <Button size="sm" variant="ghost" onClick={() => void choose(null)}>{t('icons.reset')}</Button>}
        </div>
      </div>
    </Dialog>
  );
}
