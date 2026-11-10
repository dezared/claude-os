import { useProjectColors } from '@/lib/projectColors';
import type { Project } from '@/lib/types';
import { ProjectIcon } from './ProjectIcon';
import { Select, type SelectOption } from './ui';

/** Every choice of a project in the app: icon, name and colour as in the list on the left. `extra` goes first: "all", "no project"; plain folders last. */
export function ProjectSelect({
  projects,
  extra = [],
  label,
  value,
  onChange,
  ariaLabel,
  className,
  disabled,
}: {
  projects: Project[];
  extra?: SelectOption[];
  label?: (p: Project) => string;
  value: string | null;
  onChange: (value: string | null) => void;
  ariaLabel: string;
  className?: string;
  disabled?: boolean;
}) {
  const { color } = useProjectColors();
  const options: SelectOption[] = [
    ...extra,
    ...[...projects].sort((a, b) => Number(a.folder) - Number(b.folder)).map((p) => {
      const name = label?.(p) ?? p.name;
      return {
        value: p.key,
        label: name,
        content: (
          <span className="flex min-w-0 items-center gap-1.5">
            <ProjectIcon project={p.key} name={p.name} color={color(p.key)} size={14} />
            <span className="max-w-80 min-w-0 truncate">{name}</span>
            <i data-project-color className="block size-1.5 flex-none rounded-full" style={{ background: color(p.key) }} />
          </span>
        ),
      };
    }),
  ];
  return <Select value={value} onChange={onChange} options={options} ariaLabel={ariaLabel} className={className} disabled={disabled} />;
}
