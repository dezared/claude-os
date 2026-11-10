// Windows side, approved by the owner of this install: the app in %LOCALAPPDATA%\ClaudeOS and a desktop shortcut. No autostart.
// Usage: node desktop/windows.mjs install | uninstall
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const mode = process.argv[2];
const quote = (s) => `'${s.replaceAll("'", "''")}'`;
const source = execFileSync('wslpath', ['-w', join(import.meta.dirname, 'build/ClaudeOS')]).toString().trim();

const common = `
$ErrorActionPreference = 'Stop'
$dest = Join-Path $env:LOCALAPPDATA 'ClaudeOS'
$link = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Claude OS.lnk'
Get-Process ClaudeOS -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 500
`;

const scripts = {
  install: `${common}
robocopy ${quote(source)} $dest /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy $LASTEXITCODE" }
$s = (New-Object -ComObject WScript.Shell).CreateShortcut($link)
$s.TargetPath = Join-Path $dest 'ClaudeOS.exe'
$s.WorkingDirectory = $dest
$s.IconLocation = (Join-Path $dest 'ClaudeOS.exe') + ',0'
$s.Description = 'Claude OS'
$s.Save()
Write-Output "installed $dest"
Write-Output "shortcut $link"
`,
  uninstall: `${common}
if (Test-Path $link) { Remove-Item $link }
if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
$profileDir = Join-Path $env:APPDATA 'Claude OS'
if (Test-Path $profileDir) { Remove-Item $profileDir -Recurse -Force }
Write-Output "removed $dest and the shortcut"
`,
};

if (!scripts[mode]) {
  console.error('usage: node desktop/windows.mjs install | uninstall');
  process.exit(2);
}
process.stdout.write(execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', scripts[mode]], { cwd: '/mnt/c/Windows' }).toString());
