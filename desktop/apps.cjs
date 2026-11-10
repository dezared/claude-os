// The running Windows apps for the bottom bar, through PowerShell: no native modules.
// One process while the bar is on screen, sleeping between looks; killed the moment the bar is gone.
// It answers commands on stdin as well: starting PowerShell and compiling its Win32 calls takes seconds, a click must not wait for that.
// The last list and the icons live in a file, so the bar is full the moment it appears. PowerShell corrects it a second later.
// Anything going wrong leaves an empty list: the bar simply has no icons.
const fs = require('node:fs');

const INTERVAL_MS = 3000;
const KEEP_ICONS = 64;
const HIDDEN = ['TextInputHost', 'ShellExperienceHost', 'StartMenuExperienceHost', 'SearchHost', 'SearchApp', 'LockApp'];

const encode = (script) => Buffer.from(script, 'utf16le').toString('base64');
const args = (script) => ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encode(script)];

// The list goes out first, with nothing heavy loaded. Stdin closing means the app is gone, and so does its pid disappearing.
// [Console]::In would not do: its ReadLineAsync blocks. The Win32 type compiles in the first idle moment, or at the first click if that comes sooner.
// Windows lets a process take the foreground only right after input: the Alt press is the usual way to count as that.
function listScript(parentPid) {
  return `$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$hidden = @(${HIDDEN.map((n) => `'${n}'`).join(',')})
$win = $false
$drawing = $false
function Look {
  $apps = @(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -and $_.Id -ne ${parentPid} -and $hidden -notcontains $_.ProcessName } | ForEach-Object {
    [pscustomobject]@{ id = [int64]$_.MainWindowHandle; title = $_.MainWindowTitle; path = $_.Path }
  })
  [Console]::Out.WriteLine((ConvertTo-Json -Compress -InputObject $apps))
}
function Win32 {
  if ($script:win) { return }
  Add-Type -Namespace ClaudeOS -Name Win -MemberDefinition '[DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h); [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h); [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int c); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);'
  $script:shell = New-Object -ComObject WScript.Shell
  $script:win = $true
}
function Activate($id) {
  Win32
  $h = [IntPtr][int64]$id
  if (-not [ClaudeOS.Win]::IsWindow($h)) { return }
  if ([ClaudeOS.Win]::IsIconic($h)) { [void][ClaudeOS.Win]::ShowWindowAsync($h, 9) }
  $script:shell.SendKeys('%')
  [void][ClaudeOS.Win]::SetForegroundWindow($h)
}
function Icon($path) {
  if (-not $script:drawing) {
    Add-Type -AssemblyName System.Drawing
    $script:drawing = $true
  }
  try {
    $bitmap = [Drawing.Icon]::ExtractAssociatedIcon($path).ToBitmap()
    $stream = New-Object IO.MemoryStream
    $bitmap.Save($stream, [Drawing.Imaging.ImageFormat]::Png)
    $icon = [Convert]::ToBase64String($stream.ToArray())
    $bitmap.Dispose()
    $stream.Dispose()
    [Console]::Out.WriteLine((ConvertTo-Json -Compress -InputObject ([pscustomobject]@{ path = $path; icon = $icon })))
  } catch {}
}
$in = New-Object IO.StreamReader([Console]::OpenStandardInput(), [Text.Encoding]::UTF8)
$next = $in.ReadLineAsync()
Look
$due = [Environment]::TickCount + ${INTERVAL_MS}
while ($true) {
  $wait = if ($win) { [Math]::Max(0, $due - [Environment]::TickCount) } else { 100 }
  if ($next.Wait($wait)) {
    if ($next.IsFaulted -or $null -eq $next.Result) { break }
    $line = $next.Result
    $next = $in.ReadLineAsync()
    if ($line.StartsWith('a ')) { Activate $line.Substring(2) }
    elseif ($line.StartsWith('i ')) { Icon $line.Substring(2) }
  } elseif (-not $win) { Win32 }
  if ([Environment]::TickCount - $due -ge 0) {
    if (-not (Get-Process -Id ${parentPid})) { break }
    Look
    $due = [Environment]::TickCount + ${INTERVAL_MS}
  }
}`;
}

/** One list line into rows. null: not a list, ignore the line. */
function parseApps(line) {
  let raw;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (!Array.isArray(raw)) return null;
  const rows = [];
  for (const a of raw) {
    if (!Number.isSafeInteger(a?.id) || a.id <= 0 || typeof a.title !== 'string') continue;
    rows.push({ id: a.id, title: a.title, path: typeof a.path === 'string' ? a.path : null });
  }
  return rows;
}

/** One icon line. null: not an icon. */
function parseIcon(line) {
  let raw;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  return typeof raw?.path === 'string' && typeof raw.icon === 'string' && raw.icon ? { path: raw.path, icon: `data:image/png;base64,${raw.icon}` } : null;
}

function createAppsWatcher({ spawn, parentPid, onApps, cacheFile }) {
  const icons = new Map();
  const asked = new Set();
  let child = null;
  let rows = [];
  let apps = [];
  let shown = '';
  let loaded = false;

  const view = () => rows.map((r) => ({ id: r.id, title: r.title, icon: (r.path && icons.get(r.path)) || null }));

  const load = () => {
    if (loaded) return;
    loaded = true;
    if (!cacheFile) return;
    try {
      const saved = JSON.parse(fs.readFileSync(cacheFile(), 'utf8'));
      for (const [path, icon] of saved.icons) if (typeof path === 'string' && typeof icon === 'string') icons.set(path, icon);
      rows = parseApps(JSON.stringify(saved.rows)) ?? [];
      apps = view();
      shown = key(apps);
    } catch {}
  };

  const key = (list) => JSON.stringify(list.map((a) => [a.id, a.title, Boolean(a.icon)]));

  const publish = () => {
    apps = view();
    // Titles and windows rarely change: a look that finds nothing new costs the page nothing.
    const next = key(apps);
    if (next === shown) return;
    shown = next;
    onApps(apps);
    if (cacheFile) fs.writeFile(cacheFile(), JSON.stringify({ rows, icons: [...icons].slice(-KEEP_ICONS) }), () => {});
  };

  const start = () => {
    if (child) return;
    load();
    asked.clear();
    let current;
    try {
      current = spawn('powershell.exe', args(listScript(parentPid)), { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    } catch {
      rows = [];
      return publish();
    }
    child = current;
    current.stdin.on('error', () => {});
    const take = (line) => {
      if (child !== current) return;
      const icon = parseIcon(line);
      if (icon) {
        icons.set(icon.path, icon.icon);
        return publish();
      }
      const next = parseApps(line);
      if (!next) return;
      rows = next;
      publish();
      for (const { path } of rows) {
        if (!path || icons.has(path) || asked.has(path)) continue;
        asked.add(path);
        current.stdin.write(`i ${path}\n`);
      }
    };
    let buffer = '';
    current.stdout.setEncoding('utf8');
    current.stdout.on('data', (chunk) => {
      buffer += chunk;
      for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        take(line);
      }
    });
    const gone = () => {
      if (child !== current) return;
      child = null;
      rows = [];
      publish();
    };
    current.on('error', gone);
    current.on('exit', gone);
  };

  const stop = () => {
    const current = child;
    child = null;
    current?.kill();
  };

  const activate = (id) => {
    if (!child || !apps.some((a) => a.id === id)) return;
    child.stdin.write(`a ${id}\n`);
  };

  const currentApps = () => {
    load();
    return apps;
  };

  return { start, stop, activate, current: currentApps };
}

module.exports = { createAppsWatcher, listScript, parseApps, parseIcon };
