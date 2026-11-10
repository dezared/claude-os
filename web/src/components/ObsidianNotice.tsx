import { spendNote } from '@/lib/account';
import { BookOpen, ChevronDown, ExternalLink, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, setCached, useApi } from '@/lib/api';
import { t } from '@/lib/i18n';
import { runMicrotask } from '@/lib/microtask';
import { toastError } from '@/lib/store';
import type { SettingsView } from '@/lib/types';
import { ClaudeMark } from './ClaudeMark';
import { Button, IconButton } from './ui';

export const OBSIDIAN_DOWNLOAD = 'https://obsidian.md/download';
const RECHECK_MS = 30_000;

/** While the notice is up: on focus, the moment one comes back from an installer, and slowly otherwise. */
function useObsidianRecheck(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const check = () => {
      if (document.visibilityState !== 'visible') return;
      api<SettingsView>('/api/settings/obsidian/recheck', { method: 'POST' }).then((next) => {
        setCached<SettingsView>('/api/settings', () => next);
      }).catch(() => {});
    };
    window.addEventListener('focus', check);
    const timer = setInterval(check, RECHECK_MS);
    return () => {
      window.removeEventListener('focus', check);
      clearInterval(timer);
    };
  }, [active]);
}

/** A note at the edge, never a modal. Stays away for good after one dismissal. */
export function ObsidianNotice() {
  const settings = useApi<SettingsView>('/api/settings', ['settings']);
  const [detail, setDetail] = useState(false);
  const s = settings.data;
  const visible = !!s && s.obsidian.installed === false && !s.obsidian.dismissed;
  useObsidianRecheck(visible);
  if (!visible) return null;
  const vault = s.obsidian.vaultWindows;

  const dismiss = async () => {
    try {
      const next = await api<SettingsView>('/api/settings/obsidian/dismiss', { method: 'POST' });
      setCached<SettingsView>('/api/settings', () => next);
    } catch (e) {
      toastError(e);
    }
  };

  return (
    <aside aria-label={t('obsidian.aria')} style={{ pointerEvents: 'auto' }} className="enter-fade flex-none border-b border-line2 bg-[#121216] px-4 py-1 text-xs">
      <div className="flex items-center gap-3">
        <BookOpen size={13} className="flex-none text-dim" />
        <span className="flex-none text-soft">{t('obsidian.title')}</span>
        <button type="button" aria-expanded={detail} onClick={() => setDetail(!detail)} className="press inline-flex flex-none items-center gap-1 rounded text-dim hover:text-fg">
          {t('obsidian.detail')}<ChevronDown size={11} className={detail ? 'rotate-180' : ''} />
        </button>
        <span className="ml-auto flex flex-none items-center gap-2">
          <a href={OBSIDIAN_DOWNLOAD} target="_blank" rel="noreferrer" className="press inline-flex items-center gap-1.5 rounded-md border border-line px-2 py-0.5 text-soft no-underline hover:border-white/20 hover:text-fg">
            <ExternalLink size={11} />{t('obsidian.download')}
          </a>
          <Button size="sm" title={spendNote()} onClick={() => runMicrotask({ id: 'obsidian-install', vars: { vault } })}>
            <ClaudeMark size={11} />{t('obsidian.viaClaude')}
          </Button>
          <IconButton label={t('common.hide')} className="size-6" onClick={dismiss}><X size={12} /></IconButton>
        </span>
      </div>
      {detail && (
        <p className="enter-fade pt-1 pb-0.5 pl-6 text-dim">
          {t('obsidian.howTo')} <code className="selectable font-mono wrap-anywhere text-soft">{vault}</code>
        </p>
      )}
    </aside>
  );
}
