import { Feather, Flame, Gauge, Rocket, Zap, type LucideIcon } from 'lucide-react';
import { t } from './i18n';

const LEVELS: { value: string; icon: LucideIcon; iconClass: string }[] = [
  { value: 'low', icon: Feather, iconClass: 'text-[#6ec1a6]' },
  { value: 'medium', icon: Gauge, iconClass: 'text-[#6aa9e9]' },
  { value: 'high', icon: Flame, iconClass: 'text-[#e8b04b]' },
  { value: 'xhigh', icon: Zap, iconClass: 'text-[#e8804b]' },
  { value: 'max', icon: Rocket, iconClass: 'text-[#e0565b]' },
];

// Levels accepted by `claude --effort`. The contract's /api/models lists models only.
export function efforts(): { value: string | null; label: string; icon?: LucideIcon; iconClass?: string }[] {
  return [
    { value: null, label: t('newTab.fromSettings') },
    ...LEVELS.map((l) => ({ ...l, label: l.value })),
  ];
}

export function effortLevel(value: string | null) {
  return LEVELS.find((l) => l.value === value);
}

interface Model { id: string; label: string }

/** claude-opus-4-8 -> opus, 408. An alias (opus, sonnet) says it in its label, "Opus 5.5". */
function generation(m: Model): { family: string; rank: number } | null {
  const parts = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{6,})?/.exec(m.id) ?? /^([A-Za-z]+) (\d+)(?:\.(\d+))?$/.exec(m.label);
  return parts ? { family: parts[1].toLowerCase(), rank: Number(parts[2]) * 100 + Number(parts[3] ?? 0) } : null;
}

/** The newest listed version of each family is the latest generation; what cannot be read (the CLI's "default") is not called old. */
export function modelGroups(models: Model[]): { label: string; options: { value: string; label: string }[] }[] {
  const newest = new Map<string, number>();
  for (const m of models) {
    const g = generation(m);
    if (g) newest.set(g.family, Math.max(newest.get(g.family) ?? 0, g.rank));
  }
  const isOld = (m: Model) => {
    const g = generation(m);
    return g !== null && g.rank < (newest.get(g.family) ?? 0);
  };
  const option = (m: Model) => ({ value: m.id, label: m.label });
  return [
    { label: t('models.latest'), options: models.filter((m) => !isOld(m)).map(option) },
    { label: t('models.previous'), options: models.filter(isOld).map(option) },
  ].filter((g) => g.options.length > 0);
}
