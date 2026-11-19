import type { CSSProperties, ReactNode } from 'react';
import { cn } from '@/lib/format';

/**
 * One look for every icon that stands for a thing (a project, a folder, a plugin): a rounded tile tinted with the thing's colour
 * and the glyph in that colour, the same padding and stroke at every size. The light theme deepens the colour (`--ink-light`).
 * Styles: .icon-tile in styles.css.
 */
export function IconTile({ ink, size, dim, children }: { ink: string; size: number; dim?: boolean; children: ReactNode }) {
  return (
    <span aria-hidden data-icon-tile className="icon-tile" data-dim={dim || undefined} style={{ '--ink': ink, width: size, height: size } as CSSProperties}>
      {children}
    </span>
  );
}

/** A one-colour library drawing painted with the tile's ink: the mask keeps its shapes, the colour comes from the theme. */
export function MaskGlyph({ svg, className }: { svg: string; className?: string }) {
  return <i className={cn('icon-glyph', className)} style={{ maskImage: `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}")` }} />;
}
