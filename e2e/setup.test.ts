// First-run setup: the modal over Home on a fresh install, its checks, the setup tab with the fake Claude,
// Later, Continue and Try again, and no modal on an install that finished setup. The real server, the fake CLI, no tokens.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { Profile, SetupState, Tab } from '../shared/contract.ts';
import { startServer, waitUntil, type TestServer } from '../server/chat/fixtures/harness.ts';

let browser: Browser;
let work: string;
let fresh: TestServer;
let accountFile: string;
let projectsDir: string;
const errors: string[] = [];

const RESETS = Date.now() + 2 * 3_600_000;
const LOGGED_OUT = { error: 'Not logged in' };
const LOGGED_IN = { account: { subscriptionType: 'pro' }, usage: { rate_limits: { five_hour: { utilization: 95, resets_at: new Date(RESETS).toISOString() } } } };
const login = (state: object) => writeFileSync(accountFile, JSON.stringify(state));
const answers = () => ({ name: 'Ann Tester', language: 'en', projectsDir, questionLevel: 'balanced' });

const setupOf = async (srv: TestServer) => (await srv.api<{ setup: SetupState; profile: Profile | null }>('GET', '/api/setup')).body;
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Set up Claude OS' });
const row = (page: Page, label: string) => dialog(page).getByRole('listitem').filter({ hasText: label });
const homeBox = (page: Page) => page.getByRole('textbox', { name: 'Start a new project, run something…' });

async function newContext(): Promise<BrowserContext> {
  const ctx = await browser.newContext({ locale: 'en-US', viewport: { width: 1600, height: 1000 }, reducedMotion: 'reduce' });
  ctx.setDefaultTimeout(30_000);
  return ctx;
}

// Home in a page, once the setup state has arrived: whatever the modal will do, it has done it.
async function openHome(srv: TestServer, ctx?: BrowserContext): Promise<Page> {
  const page = await (ctx ?? (await newContext())).newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  const token = readFileSync(join(srv.dataDir, 'token'), 'utf8').trim();
  const seen = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/setup');
  await page.goto(`http://127.0.0.1:${srv.port}/auth?token=${token}`);
  await seen;
  return page;
}

async function reloadHome(page: Page): Promise<void> {
  await page.evaluate(() => localStorage.setItem('claude-os.view', JSON.stringify({ kind: 'home' })));
  const seen = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/setup');
  await page.reload();
  await seen;
}

async function assertNoModal(page: Page): Promise<void> {
  await homeBox(page).waitFor(); // hidden from the accessibility tree while a modal is open
  await page.waitForTimeout(400);
  assert.equal(await page.getByRole('dialog').count(), 0, 'no setup modal');
}

before(async () => {
  work = mkdtempSync(join(tmpdir(), 'claude-os-setup-e2e-'));
  accountFile = join(work, 'account.json');
  projectsDir = join(work, 'projects');
  mkdirSync(projectsDir);
  login(LOGGED_OUT);
  fresh = await startServer({ FAKE_CLAUDE_ACCOUNT: accountFile, FAKE_CLAUDE_SETUP: JSON.stringify(answers()) }, { freshInstall: true });
  browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
});

after(async () => {
  await browser?.close();
  await fresh?.destroy();
  rmSync(work, { recursive: true, force: true });
  assert.deepEqual(errors, []);
});

test('fresh install shows the setup modal', async () => {
  assert.equal((await setupOf(fresh)).setup.completedAt, null);
  const page = await openHome(fresh);
  await dialog(page).waitFor();
  await row(page, 'Claude Code installed').waitFor();
  await dialog(page).getByRole('button', { name: 'Later' }).waitFor();
  await page.context().close();
});

test('Later hides it until the next app start', async () => {
  const ctx = await newContext();
  const page = await openHome(fresh, ctx);
  await dialog(page).getByRole('button', { name: 'Later' }).click();
  await assertNoModal(page);
  await reloadHome(page);
  await assertNoModal(page);
  await ctx.close();

  const next = await openHome(fresh);
  await dialog(next).waitFor();
  await next.context().close();
});

test('checks render with fixes and Check again re-runs them', async () => {
  login(LOGGED_OUT);
  const page = await openHome(fresh);
  const loginRow = row(page, 'Logged in');
  await loginRow.and(page.locator('[data-status="fail"]')).waitFor();
  await loginRow.getByText('Run claude in a terminal and log in, then check again.').waitFor();
  await row(page, 'Subscription or API key').getByText('Not checked: fix the item above first.').waitFor();
  assert.equal(await row(page, 'Node.js').getAttribute('data-status'), 'ok');
  assert.ok(await dialog(page).getByRole('button', { name: 'Start setup' }).isDisabled(), 'a failed check blocks the start');

  login(LOGGED_IN);
  await dialog(page).getByRole('button', { name: 'Check again' }).click();
  await loginRow.and(page.locator('[data-status="ok"]')).waitFor();
  await dialog(page).getByRole('button', { name: 'Start setup' }).and(page.locator(':enabled')).waitFor();
  // The limit warns but does not block: the percent and the reset time in local time.
  const limits = row(page, 'Usage limits');
  assert.equal(await limits.getAttribute('data-status'), 'warn');
  const time = await page.evaluate((ms) => new Date(ms).toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' }), RESETS);
  await limits.getByText(new RegExp(`95% used, resets at .*${time}`)).waitFor();
  await page.context().close();
});

test('setup completes and the modal does not return', async () => {
  login(LOGGED_IN);
  const page = await openHome(fresh);
  await dialog(page).getByRole('button', { name: 'Start setup' }).click();
  // The setup tab is open and the fake Claude called save_profile and complete_setup in it.
  await page.getByText('MCP_RESULT').waitFor();
  await waitUntil(async () => (await setupOf(fresh)).setup.completedAt !== null, 'setup completed');
  const { setup, profile } = await setupOf(fresh);
  assert.equal(setup.step, 'done');
  assert.deepEqual(profile, answers());
  const tabs = (await fresh.api<Tab[]>('GET', '/api/tabs')).body;
  assert.ok(tabs.some((x) => x.id === setup.tabId), 'the tab with the onboarding stays open');

  await reloadHome(page);
  await assertNoModal(page);
  await page.context().close();
});

test('a finished setup shows no modal; the menu runs it again', async () => {
  const owner = await startServer(); // the harness seeds a finished setup, as on the owner's install
  try {
    assert.notEqual((await setupOf(owner)).setup.completedAt, null);
    const page = await openHome(owner);
    await assertNoModal(page);
    await reloadHome(page);
    await assertNoModal(page);

    await page.getByRole('button', { name: 'Menu' }).click();
    await page.getByRole('menuitem', { name: 'Run setup again' }).click();
    await dialog(page).getByRole('button', { name: 'Start setup' }).waitFor();
    assert.deepEqual((await setupOf(owner)).setup, { step: 'checks', completedAt: null, tabId: null });
    await page.context().close();
  } finally {
    await owner.destroy();
  }
});

test('interrupted setup shows Continue; a failed run shows the reason and Try again', async () => {
  login(LOGGED_IN);
  const config = join(work, 'config-interrupted');
  mkdirSync(config);
  writeFileSync(join(config, 'settings.json'), JSON.stringify({ setup: { step: 'onboarding', completedAt: null, tabId: 'closed-tab' } }));
  const srv = await startServer({ CLAUDE_OS_CONFIG: config, FAKE_CLAUDE_ACCOUNT: accountFile, FAKE_CLAUDE_SETUP: 'fail' }, { freshInstall: true });
  try {
    const page = await openHome(srv);
    await dialog(page).getByRole('button', { name: 'Continue setup' }).click();
    await page.getByText('Fake setup failure').first().waitFor();
    const { setup } = await setupOf(srv);
    assert.equal(setup.step, 'onboarding');
    assert.notEqual(setup.tabId, 'closed-tab', 'the closed tab is replaced by a new one');

    await reloadHome(page);
    await dialog(page).getByText('The setup run stopped: Fake setup failure').waitFor();
    await dialog(page).getByRole('button', { name: 'Try again' }).click();
    await page.getByText('echo: Continue the setup from where you stopped.').waitFor();
    const setupTabs = (await srv.api<Tab[]>('GET', '/api/tabs')).body.filter((x) => x.cwd.endsWith('/setup'));
    assert.deepEqual(setupTabs.map((x) => x.id), [setup.tabId], 'the same tab carries on');
    await page.context().close();
  } finally {
    await srv.destroy();
  }
});
