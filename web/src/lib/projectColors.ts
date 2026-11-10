import { useMemo } from 'react';
import { chosenColors, makePalette } from '@/home/universe/colors';
import { useApi } from './api';
import type { MemoryGraph, Project } from './types';

/** The same colours the galaxy gives projects: same inputs, same palette. */
export function useProjectColors() {
  const projects = useApi<Project[]>('/api/projects', ['projects']);
  const graph = useApi<MemoryGraph>('/api/memory/graph', ['memory']);
  return useMemo(() => {
    const coreKey = graph.data?.coreProject ?? null;
    const noted = new Set(graph.data?.nodes.map((n) => n.project));
    if (coreKey) noted.add(coreKey);
    const mapped = (projects.data ?? []).filter((p) => noted.has(p.key) || p.liveCount > 0 || p.pinned).map((p) => p.key);
    const palette = makePalette([...mapped, ...[...noted].filter((k): k is string => k !== null)], coreKey, chosenColors(projects.data));
    const list = projects.data ?? [];
    return {
      projects: list,
      color: (key: string | null) => palette.css(key),
      keyOf: (name: string) => list.find((p) => p.name === name)?.key ?? null,
      nameOf: (key: string | null) => list.find((p) => p.key === key)?.name ?? key ?? '—',
    };
  }, [projects.data, graph.data]);
}
