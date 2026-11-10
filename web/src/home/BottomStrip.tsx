import { Puzzle, Sparkles, Webhook, type LucideIcon } from 'lucide-react';
import type { Query } from '@/lib/api';
import { cn, fmtInt } from '@/lib/format';
import { useApp } from '@/lib/store';
import type { Overview } from '@/lib/types';
import { t } from '@/lib/i18n';

function Counter({ icon: Icon, tone, label, value, onClick }: { icon: LucideIcon; tone: string; label: string; value: number | undefined; onClick?: () => void }) {
  const body = (
    <>
      <small className="block text-[11px] whitespace-nowrap text-muted">{label}</small>
      <b className="flex items-center gap-1.5 text-[17px] leading-[1.3] font-semibold tracking-[-.01em]">
        <Icon size={12} className={cn('flex-none', tone)} />
        {value === undefined ? '–' : fmtInt(value)}
      </b>
    </>
  );
  const cell = 'block flex-auto rounded-lg px-1.5 py-1.5 text-left';
  return onClick ? (
    <button type="button" onClick={onClick} className={cn(cell, 'press hover:bg-raised focus-visible:-outline-offset-2')}>
      {body}
    </button>
  ) : (
    <div className={cell}>{body}</div>
  );
}

export function BottomStrip({ overview }: { overview: Query<Overview> }) {
  const go = useApp((s) => s.go);
  const o = overview.data;
  return (
    <footer className="contents">
      <div className="home-foot-left glass group relative flex items-stretch rounded-2xl p-1">
        <Counter icon={Sparkles} tone="text-[#e6c07b]" label={t('strip.skills')} value={o?.skills} onClick={() => go({ kind: 'tools', pane: 'skills' })} />
        <Counter icon={Puzzle} tone="text-[#8da9c9]" label={t('strip.plugins')} value={o?.plugins} />
        <Counter icon={Webhook} tone="text-[#8fb8a0]" label={t('strip.hooks')} value={o?.hooks} />
      </div>
    </footer>
  );
}
