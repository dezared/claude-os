// Everything that depends on where the server runs. A later stage runs without WSL: only this module should change.
import { execFile, execFileSync } from 'node:child_process';
import { accessSync, constants, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { safely, toWslUnc, wslDistro } from '../memory/util.ts';

const run = promisify(execFile);

export type PlatformKind = 'wsl' | 'windows' | 'linux' | 'mac';

let cached: PlatformKind | null = null;
export function platformKind(): PlatformKind {
  if (cached) return cached;
  if (process.platform === 'win32') cached = 'windows';
  else if (process.platform === 'darwin') cached = 'mac';
  else if (process.env.WSL_DISTRO_NAME || /microsoft/i.test(safely(() => readFileSync('/proc/version', 'utf8'), ''))) cached = 'wsl';
  else cached = 'linux';
  return cached;
}

/** A plain shell at the folder: the user types in it. No Claude, no resume. */
export function shellArgv(kind: PlatformKind, cwd: string, distro = wslDistro()): { bin: string; args: string[]; cwd?: string } {
  if (kind === 'wsl') return { bin: 'wt.exe', args: ['wsl.exe', '-d', distro, '--cd', cwd] };
  if (kind === 'windows') return { bin: 'wt.exe', args: ['-d', cwd] };
  if (kind === 'mac') return { bin: 'open', args: ['-a', 'Terminal', cwd] };
  return { bin: 'x-terminal-emulator', args: [], cwd };
}

export function resumeArgv(kind: PlatformKind, cwd: string, claudeBin: string, sessionId: string | null, fork = false, distro = wslDistro()): { bin: string; args: string[] } {
  const claude = [claudeBin, ...(sessionId ? ['--resume', sessionId, ...(fork ? ['--fork-session'] : [])] : [])];
  // Absolute path: `wsl.exe --` starts a non-login shell, ~/.local/bin may be missing from its PATH.
  if (kind === 'wsl') return { bin: 'wt.exe', args: ['wsl.exe', '-d', distro, '--cd', cwd, '--', ...claude] };
  if (kind === 'windows') return { bin: 'wt.exe', args: ['-d', cwd, ...claude] };
  return { bin: claudeBin, args: claude.slice(1) };
}

/** A path as a Windows program understands it. */
export function toWindowsPath(path: string): string {
  return safely(() => execFileSync('wslpath', ['-w', path], { encoding: 'utf8', timeout: 5000 }).trim(), '') || toWslUnc(path);
}

/** The system file manager at a path: a folder opens, a file is shown selected in its folder where the system can do that. */
export function revealArgv(kind: PlatformKind, path: string, dir: boolean): { bin: string; args: string[] } {
  if (kind === 'wsl' || kind === 'windows') {
    const target = kind === 'wsl' ? toWindowsPath(path) : path;
    return { bin: 'explorer.exe', args: [dir ? target : `/select,${target}`] };
  }
  if (kind === 'mac') return { bin: 'open', args: dir ? [path] : ['-R', path] };
  return { bin: 'xdg-open', args: [dir ? path : dirname(path)] };
}

/** A Windows executable as WSL can start it. */
export function toLinuxPath(path: string): string {
  return safely(() => execFileSync('wslpath', ['-u', path], { encoding: 'utf8', timeout: 5000 }).trim(), '') || path;
}

const WINDOWS_PATH = String.raw`[A-Za-z]:[\\/]|\\\\wsl(?:\.localhost|\$)\\`;
// A quoted path may hold spaces ("Copy as path" in Explorer quotes everything), a bare one ends at the first space.
const FOREIGN_PATH = new RegExp(String.raw`(?<![\w\\/])(?:"((?:${WINDOWS_PATH})[^"\n]*)"|((?:${WINDOWS_PATH})[^\s"]*))`, 'g');

/** One path copied on the Windows side as this server's system opens it. Mac and Linux have nothing else to mean, it stays as it is. */
export function toServerPath(path: string, kind: PlatformKind = platformKind()): string {
  if (kind !== 'wsl') return path;
  const inside = /^\\\\wsl(?:\.localhost|\$)\\[^\\]+(\\.*)?$/i.exec(path);
  if (inside) return (inside[1] ?? '\\').replaceAll('\\', '/');
  const drive = /^([A-Za-z]):[\\/](.*)$/s.exec(path);
  return drive ? `/mnt/${drive[1].toLowerCase()}/${drive[2].replaceAll('\\', '/')}` : path;
}

/** The same for every path in a message. Only where the path really changes: a path with a space then gets its quotes kept. */
export function withServerPaths(text: string, kind: PlatformKind = platformKind()): string {
  if (kind !== 'wsl') return text;
  return text.replace(FOREIGN_PATH, (all, quoted: string | undefined, bare: string | undefined) => {
    const path = toServerPath((quoted ?? bare)!, kind);
    return /\s/.test(path) ? `"${path}"` : path;
  });
}

export function findOnPath(names: string[], path = process.env.PATH ?? ''): { name: string; path: string }[] {
  const out: { name: string; path: string }[] = [];
  for (const name of names) {
    for (const dir of path.split(':').filter(Boolean)) {
      const full = join(dir, name);
      if (safely(() => (accessSync(full, constants.X_OK), true), false)) {
        out.push({ name, path: full });
        break;
      }
    }
  }
  return out;
}

export interface WindowsScan {
  where: Record<string, string[]>;
  appPaths: Record<string, string>;
  uninstall: { n: string; l: string | null; i: string | null }[];
  vswhere: { name: string; path: string }[];
  files: string[]; // existing executables in the known dirs and JetBrains Toolbox
  obsidianHandler: { exe: string; exists: boolean } | null; // who answers obsidian:// links; a stale entry can outlive the app
}

// Read only. The executable names come from the catalog in ide.ts, never from a request.
export function windowsScanScript(exeNames: string[], knownFiles: string[]): string {
  const list = (a: string[]) => a.map((s) => `'${s.replaceAll("'", "''")}'`).join(',');
  return `
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$names = @(${list(exeNames)})
$known = @(${list(knownFiles)})
$hives = 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion','HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion','HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion'
$where = @{}
foreach ($n in $names) { $hit = @(where.exe $n 2>$null) | Where-Object { $_ }; if ($hit) { $where[$n] = @($hit) } }
$appPaths = @{}
foreach ($h in $hives) { foreach ($n in $names) { $v = (Get-ItemProperty -LiteralPath "$h\\App Paths\\$n").'(default)'; if ($v -and -not $appPaths[$n]) { $appPaths[$n] = $v.Trim('"') } } }
$uninstall = @()
foreach ($h in $hives) { Get-ItemProperty "$h\\Uninstall\\*" | Where-Object { $_.DisplayName } | ForEach-Object { $uninstall += @{ n = [string]$_.DisplayName; l = [string]$_.InstallLocation; i = [string]$_.DisplayIcon } } }
$vs = @()
$vswhere = Join-Path \${env:ProgramFiles(x86)} 'Microsoft Visual Studio\\Installer\\vswhere.exe'
if (Test-Path $vswhere) { $vs = @(& $vswhere -all -prerelease -format json | ConvertFrom-Json | ForEach-Object { @{ name = [string]$_.displayName; path = [string]$_.productPath } }) }
$files = @()
foreach ($k in $known) { $p = [Environment]::ExpandEnvironmentVariables($k); if (Test-Path -LiteralPath $p) { $files += $p } }
$roots = @("$env:LOCALAPPDATA\\JetBrains\\Toolbox\\apps", "$env:LOCALAPPDATA\\Programs", "$env:ProgramFiles\\JetBrains")
foreach ($r in $roots) { if (Test-Path $r) { Get-ChildItem -Path $r -Recurse -Depth 5 -File -Filter '*64.exe' | Where-Object { $names -contains $_.Name } | ForEach-Object { $files += $_.FullName } } }
$handler = (Get-ItemProperty -LiteralPath 'Registry::HKEY_CLASSES_ROOT\\obsidian\\shell\\open\\command').'(default)'
$obsidianHandler = $null
if ($handler -and $handler -match '^"?([^"]+?\.exe)') { $obsidianHandler = @{ exe = $Matches[1]; exists = (Test-Path -LiteralPath $Matches[1]) } }
@{ where = $where; appPaths = $appPaths; uninstall = $uninstall; vswhere = $vs; files = $files; obsidianHandler = $obsidianHandler } | ConvertTo-Json -Depth 4 -Compress
`;
}

export async function scanObsidianWindows(knownFiles: string[]): Promise<Pick<WindowsScan, 'files' | 'obsidianHandler'>> {
  const list = knownFiles.map((s) => `'${s.replaceAll("'", "''")}'`).join(',');
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$files = @()
foreach ($k in @(${list})) { $p = [Environment]::ExpandEnvironmentVariables($k); if (Test-Path -LiteralPath $p) { $files += $p } }
$handler = (Get-ItemProperty -LiteralPath 'Registry::HKEY_CLASSES_ROOT\\obsidian\\shell\\open\\command').'(default)'
$obsidianHandler = $null
if ($handler -and $handler -match '^"?([^"]+?\\.exe)') { $obsidianHandler = @{ exe = $Matches[1]; exists = (Test-Path -LiteralPath $Matches[1]) } }
@{ files = $files; obsidianHandler = $obsidianHandler } | ConvertTo-Json -Depth 3 -Compress
`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { timeout: 20_000, maxBuffer: 1024 * 1024, encoding: 'utf8' });
  const raw = JSON.parse(stdout.slice(stdout.indexOf('{'))) as { files?: string | string[]; obsidianHandler?: { exe: string; exists: boolean } | null };
  return { files: [raw.files ?? []].flat(), obsidianHandler: raw.obsidianHandler ?? null };
}

export async function scanWindows(exeNames: string[], knownFiles: string[]): Promise<WindowsScan> {
  const encoded = Buffer.from(windowsScanScript(exeNames, knownFiles), 'utf16le').toString('base64');
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { timeout: 60_000, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' });
  const raw = JSON.parse(stdout.slice(stdout.indexOf('{'))) as Partial<WindowsScan>;
  return { where: raw.where ?? {}, appPaths: raw.appPaths ?? {}, uninstall: raw.uninstall ?? [], vswhere: [raw.vswhere ?? []].flat(), files: [raw.files ?? []].flat(), obsidianHandler: raw.obsidianHandler ?? null };
}
