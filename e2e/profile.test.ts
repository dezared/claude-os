// One language setting: profile.language drives the UI (its catalog or en), the picker writes the profile,
// and Settings has a Profile section. The real server with the fake CLI and throwaway directories, no tokens.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright';
import type { Profile, SettingsView } from '../shared/contract.ts';
import { startServer, waitUntil, type TestServer } from '../server/chat/fixtures/harness.ts';

let srv: TestServer;
let browser: Browser;
let plugins: string;
let projectsDir: string;
const errors: string[] = [];

const ruHome = 'Начни новый проект, запусти что-то…';
const enHome = 'Start a new project, run something…';
const profile = async () => (await srv.api<SettingsView>('GET', '/api/settings')).body.profile;
const putProfile = async (patch: Partial<Profile>) => {
  const res = await srv.api<SettingsView>('PUT', '/api/settings/profile', patch);
  assert.equal(res.status, 200, JSON.stringify(res.body));
};

// A fresh browser profile: nothing in localStorage, the given browser language.
async function open(locale: string, view?: object): Promise<Page> {
  const ctx = await browser.newContext({ locale, viewport: { width: 1600, height: 1000 }, reducedMotion: 'reduce' });
  ctx.setDefaultTimeout(30_000);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  const token = readFileSync(join(srv.dataDir, 'token'), 'utf8').trim();
  await page.goto(`http://127.0.0.1:${srv.port}/auth?token=${token}`);
  if (view) {
    await page.evaluate((v) => localStorage.setItem('claude-os.view', JSON.stringify(v)), view);
    await page.reload();
  }
  return page;
}

const homeBox = (page: Page, text: string) => page.getByRole('textbox', { name: text }).waitFor();
// Every PUT of the profile the page sends, from now on.
const profilePuts = (page: Page) => {
  const puts: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'PUT' && r.url().endsWith('/api/settings/profile')) puts.push(r.postData() ?? '');
  });
  return puts;
};
const toSettings = async (page: Page) => {
  await page.evaluate(() => localStorage.setItem('claude-os.view', JSON.stringify({ kind: 'settings', section: 'general' })));
  await page.reload();
};
const uiLang = (page: Page) => page.evaluate(() => document.documentElement.lang);

before(async () => {
  plugins = mkdtempSync(join(tmpdir(), 'claude-os-plugins-'));
  srv = await startServer({ CLAUDE_OS_PLUGINS: plugins });
  projectsDir = join(srv.dir, 'projects');
  mkdirSync(projectsDir);
  browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
});

after(async () => {
  await browser?.close();
  await srv?.destroy();
  rmSync(plugins, { recursive: true, force: true });
  assert.deepEqual(errors, []);
});

// First: it needs the server without a profile.
test('before a profile the stored language and the picker are local; then the profile wins', async () => {
  assert.equal(await profile(), null);
  const page = await open('en-US');
  await page.evaluate(() => localStorage.setItem('claude-os.lang', 'ru'));
  await page.reload();
  await homeBox(page, ruHome);
  assert.equal(await profile(), null, 'nothing is written before setup: the first profile needs every field');

  const puts = profilePuts(page);
  await toSettings(page);
  await page.getByRole('radio', { name: 'EN' }).click();
  await page.getByRole('heading', { name: 'Settings' }).waitFor();
  assert.deepEqual(puts, [], 'before a profile the picker changes the UI only');
  assert.equal(await profile(), null);

  await putProfile({ name: 'Ann', language: 'ru', projectsDir, questionLevel: 'balanced' });
  await page.evaluate(() => localStorage.setItem('claude-os.view', JSON.stringify({ kind: 'home' })));
  await page.reload();
  await homeBox(page, ruHome);
  assert.equal(await page.evaluate(() => localStorage.getItem('claude-os.lang')), 'ru', 'the stored value follows the profile');
  assert.equal((await profile())?.language, 'ru', 'localStorage never writes over the profile');
  await page.context().close();
});

test('profile language sets the UI; the language picker writes the profile', async () => {
  await putProfile({ language: 'ru' });
  const page = await open('en-US');
  await homeBox(page, ruHome);
  assert.equal(await uiLang(page), 'ru');

  await putProfile({ language: 'en' });
  await page.reload();
  await homeBox(page, enHome);

  const puts = profilePuts(page);
  await toSettings(page);
  await page.getByText('Claude replies in this language too.').waitFor();
  await page.getByRole('radio', { name: 'EN', checked: true }).click();
  await page.waitForTimeout(300);
  assert.deepEqual(puts, [], 'the selected option sends nothing');
  await page.getByRole('radio', { name: 'RU' }).click();
  await page.getByRole('heading', { name: 'Настройки' }).waitFor();
  await waitUntil(async () => (await profile())?.language === 'ru', 'profile language ru');
  await page.context().close();
});

test('unknown language renders en and keeps profile', async () => {
  await putProfile({ language: 'de' });
  const page = await open('ru-RU');
  await homeBox(page, enHome);
  assert.equal(await uiLang(page), 'en');
  await toSettings(page);
  await page.getByRole('radio', { name: 'EN' }).waitFor();
  assert.equal(await page.getByRole('radiogroup', { name: 'Language' }).getByRole('radio', { checked: true }).count(), 0, 'no catalog: nothing selected');
  assert.equal((await profile())?.language, 'de');
  await page.getByRole('radio', { name: 'EN' }).click();
  await waitUntil(async () => (await profile())?.language === 'en', 'a click on EN is a deliberate choice');
  await page.context().close();
});

test('profile section edits the name, language, projects folder and question level', async () => {
  await putProfile({ name: 'Ann', language: 'en', questionLevel: 'balanced' });
  const page = await open('en-US', { kind: 'settings', section: 'profile' });
  const name = page.getByRole('textbox', { name: 'Name' });
  assert.equal(await name.inputValue(), 'Ann');
  assert.equal(await name.getAttribute('maxlength'), '60');
  await name.fill('Anna');
  await name.press('Enter');
  await waitUntil(async () => (await profile())?.name === 'Anna', 'name saved');

  await page.getByRole('radio', { name: 'Thorough' }).click();
  await waitUntil(async () => (await profile())?.questionLevel === 'thorough', 'question level saved');

  const folder = page.getByRole('textbox', { name: 'Projects folder' });
  await folder.fill(join(srv.dir, 'missing'));
  await folder.press('Enter');
  await page.getByText('no such writable folder', { exact: true }).waitFor();
  assert.equal((await profile())?.projectsDir, projectsDir, 'a refused folder is not stored');

  const lang = page.getByRole('textbox', { name: 'Reply language' });
  await lang.fill('ru');
  await lang.press('Enter');
  await page.getByRole('heading', { name: 'Профиль' }).waitFor();
  assert.equal((await profile())?.language, 'ru');
  await page.context().close();
});
