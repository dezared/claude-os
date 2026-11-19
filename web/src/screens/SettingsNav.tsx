import { BookOpen, CircleUser, FolderCog, Info, LayoutGrid, Mic, Search, Settings, SlidersHorizontal, SquareTerminal, UserRound, X, type LucideIcon } from 'lucide-react';
import { useState } from 'react';
import { Fold, Pop } from '@/components/Motion';
import { cn } from '@/lib/format';
import { t, type Key } from '@/lib/i18n';
import { useApp, type SettingsSection } from '@/lib/store';

/** The sections in the order of the sidebar: the tile colour of each, and the rows inside it that search also finds. */
export const SECTIONS: { id: SettingsSection; label: Key; icon: LucideIcon; tone: string; terms: Key[] }[] = [
  { id: 'general', label: 'set.general', icon: SlidersHorizontal, tone: '#8e8e93', terms: ['set.appearance', 'settings.theme', 'set.accent', 'settings.language', 'set.sky', 'universe.crossLinks', 'universe.nesting', 'desktop.closeSetting', 'desktop.notifySetting', 'desktop.fullscreenSetting'] },
  { id: 'profile', label: 'settings.profile.title', icon: UserRound, tone: '#0a84ff', terms: ['settings.profile.name', 'settings.profile.language', 'settings.profile.questionLevel'] },
  { id: 'widgets', label: 'set.widgets', icon: LayoutGrid, tone: '#a35ee8', terms: ['widget.onScreen', 'widget.trash'] },
  { id: 'ides', label: 'set.ides', icon: SquareTerminal, tone: '#5e5ce6', terms: ['settings.approve'] },
  { id: 'projects', label: 'set.projects', icon: FolderCog, tone: '#f59e0b', terms: ['newTab.model', 'newTab.effort', 'settings.ide', 'set.map', 'set.mapLimit', 'icons.title'] },
  { id: 'claude', label: 'set.claude', icon: CircleUser, tone: '#d97757', terms: ['limits.plan', 'set.billing', 'set.doctor', 'limits.session', 'limits.weekly'] },
  { id: 'notes', label: 'set.notes', icon: BookOpen, tone: '#8b5cf6', terms: ['set.vault', 'set.vaultPanel', 'semantic.title'] },
  { id: 'voice', label: 'set.voice', icon: Mic, tone: '#ff375f', terms: ['voice.model', 'voice.folder', 'voice.language'] },
  { id: 'about', label: 'set.about', icon: Info, tone: '#636366', terms: ['set.platform', 'set.iconsCredit'] },
];

const matches = (s: (typeof SECTIONS)[number], q: string) => [s.label, ...s.terms].some((k) => t(k).toLowerCase().includes(q));

/** The sidebar of the settings: a search over sections and the rows inside them, then the sections as coloured tiles. */
export function SettingsNav({ section }: { section: SettingsSection }) {
  const go = useApp((s) => s.go);
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const found = SECTIONS.filter((s) => !q || matches(s, q));
  return (
    <nav aria-label={t('set.nav')} className="flex min-h-0 flex-col overflow-auto border-r border-line2 p-2.5">
      <h1 className="flex items-center gap-2 px-1.5 pt-0.5 pb-2.5 text-sm font-medium"><Settings size={15} className="text-dim" />{t('settings.title')}</h1>
      <div className="relative mb-2.5">
        <Search size={13} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-dim" />
        <input
          type="search"
          aria-label={t('set.search')}
          placeholder={t('set.search')}
          value={query}
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && found[0]) go({ kind: 'settings', section: found[0].id });
            else if (e.key === 'Escape') setQuery('');
          }}
          className="w-full rounded-lg bg-fg/[.06] py-1.5 pr-7 pl-8 text-[13px] text-fg outline-none transition-shadow duration-150 placeholder:text-dim focus:shadow-[0_0_0_2px_var(--color-accent-bg),inset_0_0_0_1px_var(--color-accent)] [&::-webkit-search-cancel-button]:hidden"
        />
        <Pop show={query !== ''} className="absolute top-1/2 right-1.5 -translate-y-1/2">
          <button type="button" aria-label={t('common.clear')} onClick={() => setQuery('')} className="press grid size-4.5 place-items-center rounded-full bg-fg/15 text-bg hover:bg-fg/25"><X size={10} strokeWidth={3} /></button>
        </Pop>
      </div>
      {SECTIONS.map((x) => (
        <Fold key={x.id} show={found.includes(x)}>
          <button
            type="button"
            aria-current={section === x.id ? 'page' : undefined}
            onClick={() => go({ kind: 'settings', section: x.id })}
            className={cn('press mb-0.5 flex w-full items-center gap-2.5 rounded-lg px-1.5 py-1 text-left text-[13px] transition-colors duration-150', section === x.id ? 'bg-fg/[.1] text-fg' : 'text-soft hover:bg-fg/[.05]')}
          >
            <span aria-hidden className="grid size-[22px] flex-none place-items-center rounded-[6px] text-white shadow-[inset_0_0_0_.5px_rgba(0,0,0,.15),inset_0_1px_0_rgba(255,255,255,.22)]" style={{ background: x.tone }}>
              <x.icon size={13} strokeWidth={2.2} />
            </span>
            <span className="truncate">{t(x.label)}</span>
          </button>
        </Fold>
      ))}
      <Fold show={found.length === 0}>
        <p className="px-2 py-3 text-center text-xs text-dim">{t('set.searchEmpty')}</p>
      </Fold>
    </nav>
  );
}
