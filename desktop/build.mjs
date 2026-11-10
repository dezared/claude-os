// Builds the Windows app from WSL into desktop/build/ClaudeOS. Nothing outside the repo is written.
import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { downloadArtifact } from '@electron/get';

const here = import.meta.dirname;
const repo = resolve(here, '..');
const out = join(here, 'build/ClaudeOS');
const version = '45.2.2';

const zip = await downloadArtifact({ version, platform: 'win32', arch: 'x64', artifactName: 'electron' });
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
execFileSync('unzip', ['-q', zip, '-d', out]);
renameSync(join(out, 'electron.exe'), join(out, 'ClaudeOS.exe'));
rmSync(join(out, 'resources/default_app.asar'), { force: true });

const app = join(out, 'resources/app');
mkdirSync(app, { recursive: true });
for (const file of ['main.cjs', 'preload.cjs', 'apps.cjs']) copyFileSync(join(here, file), join(app, file));
copyFileSync(join(here, 'icon.ico'), join(app, 'icon.ico'));
writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'claude-os', productName: 'Claude OS', version: '0.1.0', main: 'main.cjs' }));
writeFileSync(join(app, 'install.json'), JSON.stringify({
  distro: process.env.WSL_DISTRO_NAME ?? 'Ubuntu-22.04',
  node: process.execPath,
  serve: join(repo, 'desktop/serve.mjs'),
}, null, 2));

// rcedit is a Windows program: run it through interop to give the exe its icon and name.
const rcedit = join(repo, 'node_modules/rcedit/bin/rcedit-x64.exe');
if (existsSync(rcedit)) {
  const win = (p) => execFileSync('wslpath', ['-w', p]).toString().trim();
  execFileSync(rcedit, [
    win(join(out, 'ClaudeOS.exe')),
    '--set-icon', win(join(here, 'icon.ico')),
    '--set-version-string', 'FileDescription', 'Claude OS',
    '--set-version-string', 'ProductName', 'Claude OS',
  ], { cwd: '/mnt/c/Windows' });
}
console.log(`built ${out}`);
