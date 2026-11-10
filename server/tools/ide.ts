import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { basename } from 'node:path';
import type { IdeEntry, IdeFamily, ProjectIde } from '../../shared/contract.ts';
import { httpError, safely, sha256, wslDistro } from '../memory/util.ts';
import { findOnPath, platformKind, scanObsidianWindows, scanWindows, toLinuxPath, toWindowsPath, type PlatformKind, type WindowsScan } from './platform.ts';

interface CatalogItem {
  id: string;
  name: string;
  family: IdeFamily;
  exe: string[]; // Windows executable names
  linux: string[]; // names on a Linux PATH
  uninstall?: RegExp; // DisplayName in the registry
  known?: string[]; // known install paths, with %VARS%
}

const jb = (id: string, name: string, exe: string, linux: string): CatalogItem => ({
  id, name, family: 'jetbrains', exe: [exe], linux: [linux, `${linux}.sh`], uninstall: new RegExp(`^${name}\\b`, 'i'),
});

export const CATALOG: CatalogItem[] = [
  { id: 'vscode', name: 'VS Code', family: 'vscode', exe: ['Code.exe'], linux: ['code'], uninstall: /^Microsoft Visual Studio Code(?! Insiders)/i, known: ['%LOCALAPPDATA%\\Programs\\Microsoft VS Code\\Code.exe', '%ProgramFiles%\\Microsoft VS Code\\Code.exe'] },
  { id: 'vscode-insiders', name: 'VS Code Insiders', family: 'vscode', exe: ['Code - Insiders.exe'], linux: ['code-insiders'], uninstall: /^Microsoft Visual Studio Code Insiders/i, known: ['%LOCALAPPDATA%\\Programs\\Microsoft VS Code Insiders\\Code - Insiders.exe'] },
  { id: 'cursor', name: 'Cursor', family: 'vscode', exe: ['Cursor.exe'], linux: ['cursor'], uninstall: /^Cursor\b/i, known: ['%LOCALAPPDATA%\\Programs\\cursor\\Cursor.exe'] },
  { id: 'windsurf', name: 'Windsurf', family: 'vscode', exe: ['Windsurf.exe'], linux: ['windsurf'], uninstall: /^Windsurf\b/i, known: ['%LOCALAPPDATA%\\Programs\\Windsurf\\Windsurf.exe'] },
  { id: 'visualstudio', name: 'Visual Studio', family: 'visualstudio', exe: ['devenv.exe'], linux: [] },
  jb('phpstorm', 'PhpStorm', 'phpstorm64.exe', 'phpstorm'),
  jb('idea', 'IntelliJ IDEA', 'idea64.exe', 'idea'),
  jb('webstorm', 'WebStorm', 'webstorm64.exe', 'webstorm'),
  jb('pycharm', 'PyCharm', 'pycharm64.exe', 'pycharm'),
  jb('rider', 'Rider', 'rider64.exe', 'rider'),
  jb('goland', 'GoLand', 'goland64.exe', 'goland'),
  jb('clion', 'CLion', 'clion64.exe', 'clion'),
  jb('rubymine', 'RubyMine', 'rubymine64.exe', 'rubymine'),
  jb('datagrip', 'DataGrip', 'datagrip64.exe', 'datagrip'),
  jb('rustrover', 'RustRover', 'rustrover64.exe', 'rustrover'),
  { id: 'android-studio', name: 'Android Studio', family: 'jetbrains', exe: ['studio64.exe'], linux: ['studio', 'studio.sh'], uninstall: /^Android Studio/i, known: ['%ProgramFiles%\\Android\\Android Studio\\bin\\studio64.exe'] },
  { id: 'zed', name: 'Zed', family: 'plain', exe: ['Zed.exe'], linux: ['zed'], uninstall: /^Zed\b/i, known: ['%LOCALAPPDATA%\\Programs\\Zed\\Zed.exe'] },
  { id: 'sublime', name: 'Sublime Text', family: 'plain', exe: ['sublime_text.exe'], linux: ['subl'], uninstall: /^Sublime Text/i, known: ['%ProgramFiles%\\Sublime Text\\sublime_text.exe', '%ProgramFiles%\\Sublime Text 3\\sublime_text.exe'] },
  { id: 'notepadpp', name: 'Notepad++', family: 'plain', exe: ['notepad++.exe'], linux: [], uninstall: /^Notepad\+\+/i, known: ['%ProgramFiles%\\Notepad++\\notepad++.exe', '%ProgramFiles(x86)%\\Notepad++\\notepad++.exe'] },
];

const OBSIDIAN_KNOWN = ['%LOCALAPPDATA%\\Programs\\Obsidian\\Obsidian.exe', '%LOCALAPPDATA%\\Obsidian\\Obsidian.exe', '%ProgramFiles%\\Obsidian\\Obsidian.exe'];

const entry = (c: CatalogItem, exe: string, side: IdeEntry['side'], source: string, name = c.name): IdeEntry => ({
  id: `${c.id}-${sha256(exe.toLowerCase()).slice(0, 6)}`, catalogId: c.id, name, family: c.family, exe, side, source, approved: true,
});

const winBase = (p: string) => p.slice(Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/')) + 1);

// Pure: the same scan always gives the same list. Tested on fixtures.
export function resolveWindowsIdes(scan: WindowsScan): IdeEntry[] {
  const out = new Map<string, IdeEntry>();
  const add = (c: CatalogItem, exe: string, source: string, name?: string) => {
    const key = exe.toLowerCase();
    if (exe && !out.has(key)) out.set(key, entry(c, exe, 'windows', source, name));
  };
  for (const c of CATALOG) {
    const isExe = (p: string) => c.exe.some((e) => winBase(p).toLowerCase() === e.toLowerCase());
    for (const e of c.exe) {
      for (const hit of scan.where[e] ?? []) if (isExe(hit)) add(c, hit, 'path');
      const app = scan.appPaths[e];
      if (app && isExe(app)) add(c, app, 'app_paths');
    }
    if (c.uninstall) {
      for (const u of scan.uninstall) {
        if (!c.uninstall.test(u.n)) continue;
        const icon = (u.i ?? '').replace(/^"|"?,\s*-?\d+$|"$/g, '');
        if (icon && isExe(icon)) add(c, icon, 'uninstall');
        else if (u.l) for (const e of c.exe) if (scan.files.some((f) => f.toLowerCase().startsWith(u.l!.toLowerCase()) && winBase(f).toLowerCase() === e.toLowerCase())) add(c, scan.files.find((f) => f.toLowerCase().startsWith(u.l!.toLowerCase()) && winBase(f).toLowerCase() === e.toLowerCase())!, 'uninstall');
      }
    }
    for (const f of scan.files) if (isExe(f)) add(c, f, /Toolbox/i.test(f) ? 'toolbox' : 'known');
    if (c.id === 'visualstudio') for (const v of scan.vswhere) if (v.path) add(c, v.path, 'vswhere', v.name || c.name);
  }
  return [...out.values()];
}

export function resolveLinuxIdes(hits: { name: string; path: string }[], windows: IdeEntry[]): IdeEntry[] {
  const out: IdeEntry[] = [];
  for (const c of CATALOG) {
    for (const hit of hits) {
      if (!c.linux.includes(hit.name) || out.some((e) => e.catalogId === c.id)) continue;
      // A Windows install on the WSL PATH. Only the VS Code family ships a wrapper that speaks WSL.
      if (hit.path.startsWith('/mnt/') && c.family !== 'vscode') continue;
      out.push(entry(c, hit.path, 'linux', 'path'));
    }
  }
  const wrapped = new Set(out.map((e) => e.catalogId));
  return [...out, ...windows.filter((w) => !(w.family === 'vscode' && wrapped.has(w.catalogId)))];
}

// A registered obsidian:// handler counts only if its program is still there.
export function obsidianState(scan: Pick<WindowsScan, 'files' | 'obsidianHandler'>): { installed: boolean; exe: string | null } {
  const exe = scan.files.find((f) => /obsidian\.exe$/i.test(f)) ?? (scan.obsidianHandler?.exists ? scan.obsidianHandler.exe : null);
  return { installed: exe !== null, exe };
}

export interface IdeScan { ides: IdeEntry[]; obsidianInstalled: boolean | null; obsidianExe: string | null; }

export async function scanIdes(kind: PlatformKind = platformKind()): Promise<IdeScan> {
  const linuxHits = kind === 'windows' ? [] : findOnPath(CATALOG.flatMap((c) => c.linux));
  if (kind !== 'wsl' && kind !== 'windows') {
    const found = findOnPath(['obsidian'])[0]?.path ?? null;
    return { ides: resolveLinuxIdes(linuxHits, []), obsidianInstalled: found !== null, obsidianExe: found };
  }
  const known = CATALOG.flatMap((c) => c.known ?? []);
  const scan = await scanWindows(CATALOG.flatMap((c) => c.exe), [...known, ...OBSIDIAN_KNOWN]);
  const { installed, exe } = obsidianState(scan);
  return { ides: resolveLinuxIdes(linuxHits, resolveWindowsIdes(scan)), obsidianInstalled: installed, obsidianExe: exe };
}

/** Obsidian alone: fast enough to repeat while the notice is on screen. Same rule as the full scan. */
export async function probeObsidian(kind: PlatformKind = platformKind()): Promise<{ installed: boolean; exe: string | null }> {
  if (kind !== 'wsl' && kind !== 'windows') {
    const exe = findOnPath(['obsidian'])[0]?.path ?? null;
    return { installed: exe !== null, exe };
  }
  return obsidianState(await scanObsidianWindows(OBSIDIAN_KNOWN));
}

// First rule with an installed candidate wins. The fallback is any editor that is there.
const MARKERS: { match: RegExp; ides: string[] }[] = [
  { match: /^composer\.json$/, ides: ['phpstorm', 'vscode', 'cursor'] },
  { match: /\.(sln|slnx|csproj|vbproj|fsproj|vcxproj)$/i, ides: ['visualstudio', 'rider', 'vscode'] },
  { match: /^(pom\.xml|build\.gradle(\.kts)?|settings\.gradle(\.kts)?)$/, ides: ['idea', 'android-studio', 'vscode'] },
  { match: /^go\.mod$/, ides: ['goland', 'vscode', 'cursor'] },
  { match: /^Cargo\.toml$/, ides: ['rustrover', 'clion', 'vscode', 'cursor', 'zed'] },
  { match: /^(pyproject\.toml|requirements\.txt|setup\.py|Pipfile)$/, ides: ['pycharm', 'vscode', 'cursor'] },
  { match: /^Gemfile$/, ides: ['rubymine', 'vscode', 'cursor'] },
  { match: /^CMakeLists\.txt$/, ides: ['clion', 'visualstudio', 'vscode'] },
  { match: /^package\.json$/, ides: ['vscode', 'cursor', 'windsurf', 'webstorm', 'zed'] },
];
const FALLBACK = ['vscode', 'cursor', 'windsurf', 'zed', 'sublime', 'idea', 'notepadpp'];

export function chooseIde(fileNames: string[], installed: IdeEntry[]): { ide: IdeEntry | null; marker: string | null } {
  const first = (ids: string[]) => ids.map((id) => installed.find((e) => e.catalogId === id)).find(Boolean) ?? null;
  for (const rule of MARKERS) {
    const marker = fileNames.find((f) => rule.match.test(f));
    if (!marker) continue;
    const ide = first(rule.ides);
    if (ide) return { ide, marker };
  }
  return { ide: first(FALLBACK) ?? installed[0] ?? null, marker: null };
}

export function projectIde(root: string, list: IdeEntry[], chosen: string | null | undefined): ProjectIde {
  const usable = list.filter((e) => e.approved);
  const manual = chosen ? usable.find((e) => e.id === chosen) ?? null : null;
  const auto = manual ? { ide: manual, marker: null } : chooseIde(safely(() => readdirSync(root), []), usable);
  return { chosen: auto.ide, auto: !manual, marker: auto.marker, others: usable.filter((e) => e.id !== auto.ide?.id) };
}

export function ideArgv(e: Pick<IdeEntry, 'exe' | 'side' | 'family'>, target: string, opts: { kind: PlatformKind; distro?: string; toWin?: (p: string) => string; toLinux?: (p: string) => string; isFile?: boolean }): { bin: string; args: string[] } {
  if (e.side === 'linux' || opts.kind !== 'wsl') return { bin: e.exe, args: [target] };
  const bin = (opts.toLinux ?? toLinuxPath)(e.exe);
  if (e.family === 'vscode') {
    const uri = `vscode-remote://wsl+${opts.distro ?? wslDistro()}${encodeURI(target)}`;
    return { bin, args: [opts.isFile ? '--file-uri' : '--folder-uri', uri] };
  }
  return { bin, args: [(opts.toWin ?? toWindowsPath)(target)] };
}

export function launchDetached(bin: string, args: string[], cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { detached: true, stdio: 'ignore', ...(cwd ? { cwd } : {}) });
    child.once('error', (err) => reject(httpError(500, `failed to start ${basename(bin)}: ${err.message}`)));
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}
