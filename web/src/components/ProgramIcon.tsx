import { SquareTerminal } from 'lucide-react';
import { siAndroidstudio, siClion, siCursor, siDatagrip, siGoland, siIntellijidea, siNotepadplusplus, siObsidian, siPhpstorm, siPycharm, siRider, siRubymine, siSublimetext, siWebstorm, siWindsurf, siZedindustries } from 'simple-icons';
import { cn } from '@/lib/format';

const GLYPHS: Record<string, { path: string; color: string }> = {
  cursor: { path: siCursor.path, color: '#e4e4e7' },
  phpstorm: { path: siPhpstorm.path, color: '#b491f5' },
  webstorm: { path: siWebstorm.path, color: '#4fc3e8' },
  pycharm: { path: siPycharm.path, color: '#5fd38a' },
  idea: { path: siIntellijidea.path, color: '#f07fae' },
  rider: { path: siRider.path, color: '#e8b04f' },
  goland: { path: siGoland.path, color: '#6ea8e8' },
  clion: { path: siClion.path, color: '#5fd3b8' },
  rubymine: { path: siRubymine.path, color: '#ef6a6a' },
  datagrip: { path: siDatagrip.path, color: '#b4d455' },
  'android-studio': { path: siAndroidstudio.path, color: '#3ddc84' },
  zed: { path: siZedindustries.path, color: '#6ea8e8' },
  windsurf: { path: siWindsurf.path, color: '#5fd3b8' },
  sublime: { path: siSublimetext.path, color: '#ff9800' },
  notepadpp: { path: siNotepadplusplus.path, color: '#90e59a' },
  obsidian: { path: siObsidian.path, color: '#a78bfa' },
};

// simple-icons carries no Microsoft marks and no RustRover.
const MONOGRAMS: Record<string, { text: string; color: string }> = {
  vscode: { text: 'VS', color: '#6ea8e8' },
  'vscode-insiders': { text: 'VS', color: '#5fb98a' },
  visualstudio: { text: 'VS', color: '#b49ae6' },
  rustrover: { text: 'RR', color: '#e8894f' },
};

/** A flat tile for a program, by its catalog id from the IDE scan. */
export function ProgramIcon({ id, name, size = 18, className }: { id: string; name?: string; size?: number; className?: string }) {
  const glyph = GLYPHS[id];
  const mono = MONOGRAMS[id];
  const tile = cn('inline-flex flex-none items-center justify-center rounded-[5px] bg-white/[.075]', className);
  const box = { width: size, height: size };
  if (glyph) {
    return (
      <span className={tile} style={box} aria-hidden>
        <svg viewBox="0 0 24 24" width={size * 0.68} height={size * 0.68} fill={glyph.color}><path d={glyph.path} /></svg>
      </span>
    );
  }
  if (id === 'terminal') return <span className={tile} style={box} aria-hidden><SquareTerminal size={size * 0.7} className="text-soft" /></span>;
  const text = mono?.text ?? (name ?? id).replace(/[^\p{L}\p{N}]/gu, '').slice(0, 2).toUpperCase();
  return (
    <span className={tile} style={{ ...box, color: mono?.color ?? 'var(--color-soft)', fontSize: size * 0.46, fontWeight: 600, letterSpacing: '-.02em' }} aria-hidden>{text}</span>
  );
}
