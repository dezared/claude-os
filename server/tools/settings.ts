// config/settings.json: IDE list, per-project defaults, dismissed notices, the user's profile and setup state. Claude can edit it too: nothing in it
// that launches a program counts until data/approved-commands.json says so.
import { accessSync, constants, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { HOME_SLOTS, type HomeLayout, type HomeSlot, type IdeEntry, type Profile, type ProjectIde, type ProjectSettings, type QuestionLevel, type SettingsView, type SetupState, type UniverseOptions, type UniverseTheme } from '../../shared/contract.ts';
import type { Ctx } from '../context.ts';
import { httpError, safely } from '../memory/util.ts';
import type { Approvals } from './approvals.ts';
import { ideArgv, launchDetached, probeObsidian, projectIde, scanIdes, type IdeScan } from './ide.ts';
import { platformKind, toLinuxPath, toWindowsPath } from './platform.ts';
import { readJson } from './shared.ts';
import { QUESTION_LEVELS } from '../chat/profile.ts';
import { validateCwd, validatePath } from './actions.ts';

interface RawSettings {
  ides?: { scannedAt?: number; list?: IdeEntry[]; obsidian?: { installed?: boolean | null; exe?: string | null } };
  obsidianDismissed?: boolean;
  projects?: Record<string, ProjectSettings>;
  universe?: unknown;
  [other: string]: unknown;
}

const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const MODEL = /^[A-Za-z0-9][\w.:\-\[\]]*$/;
const ideCommand = (exe: string) => `ide:${exe}`;
const THEMES: UniverseTheme[] = ['default', 'ember', 'aurora', 'mono'];
const HEX = /^#[0-9a-f]{6}$/i;
const COLOR_KEYS = ['bg', 'inner', 'outer'] as const;
export const UNIVERSE_LIMIT = { default: 100, min: 1, max: 200 };

// Claude can write this file by hand: whatever does not fit falls back to the default instead of breaking the map.
function universeOptions(raw: unknown): UniverseOptions {
  const u = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const given = (u.colors && typeof u.colors === 'object' ? u.colors : {}) as Record<string, unknown>;
  const colors: UniverseOptions['colors'] = {};
  for (const key of COLOR_KEYS) if (typeof given[key] === 'string' && HEX.test(given[key])) colors[key] = given[key];
  const limit = Number.isInteger(u.limit) ? Math.min(UNIVERSE_LIMIT.max, Math.max(UNIVERSE_LIMIT.min, u.limit as number)) : UNIVERSE_LIMIT.default;
  return { limit, theme: THEMES.includes(u.theme as UniverseTheme) ? (u.theme as UniverseTheme) : 'default', colors, crossLinks: u.crossLinks === true, nesting: u.nesting === true };
}

const LEVELS = Object.keys(QUESTION_LEVELS) as QuestionLevel[];
const SETUP_STEPS: SetupState['step'][] = ['checks', 'onboarding', 'done'];

// The reason a profile field does not fit, null when it does. The folder is checked on disk only when a request sets it.
function profileError(p: Record<string, unknown>, onDisk: boolean): string | null {
  if (typeof p.name !== 'string' || !p.name.trim() || p.name.trim().length > 60) return 'name: 1 to 60 characters';
  if (/\p{Cc}/u.test(p.name)) return 'name: no control characters';
  if (typeof p.language !== 'string' || !/^[a-z]{2,3}$/.test(p.language)) return 'language: an ISO 639 code like en';
  if (!LEVELS.includes(p.questionLevel as QuestionLevel)) return `questionLevel: one of ${LEVELS.join(', ')}`;
  if (typeof p.projectsDir !== 'string' || !isAbsolute(p.projectsDir)) return 'projectsDir: an absolute path';
  if (onDisk) {
    try {
      if (!statSync(p.projectsDir).isDirectory()) return 'projectsDir: not a folder';
      accessSync(p.projectsDir, constants.W_OK);
    } catch {
      return 'projectsDir: no such writable folder';
    }
  }
  return null;
}

function profileOf(raw: unknown): Profile | null {
  const p = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  if (profileError(p, false)) return null;
  return { name: (p.name as string).trim(), language: p.language as string, projectsDir: p.projectsDir as string, questionLevel: p.questionLevel as QuestionLevel };
}

function setupOf(raw: unknown): SetupState {
  const s = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    step: SETUP_STEPS.includes(s.step as SetupState['step']) ? (s.step as SetupState['step']) : 'checks',
    completedAt: Number.isFinite(s.completedAt) ? (s.completedAt as number) : null,
    tabId: typeof s.tabId === 'string' ? s.tabId : null,
  };
}

// The same for the home layout: what is not listed here stands where it stands by default. One id, one place.
function homeLayout(raw: unknown): HomeLayout {
  const h = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const given = (h.slots && typeof h.slots === 'object' ? h.slots : {}) as Record<string, unknown>;
  const seen = new Set<string>();
  const slots: HomeLayout['slots'] = {};
  for (const slot of HOME_SLOTS) {
    const list = given[slot];
    if (Array.isArray(list)) slots[slot] = list.filter((id): id is string => typeof id === 'string' && !seen.has(id) && !!seen.add(id));
  }
  const ids = (list: unknown) => (Array.isArray(list) ? [...new Set(list.filter((id): id is string => typeof id === 'string'))] : []);
  const collapsed = ids(h.collapsed);
  const removed = ids(h.removed);
  const heights = Object.entries(h.heights && typeof h.heights === 'object' ? h.heights : {}).filter((e): e is [string, number] => Number.isFinite(e[1]) && e[1] >= 64);
  return { slots, hidden: ids(h.hidden), ...(collapsed.length ? { collapsed } : {}), ...(heights.length ? { heights: Object.fromEntries(heights) } : {}), ...(removed.length ? { removed } : {}) };
}

export function createSettings(ctx: Ctx, approvals: Approvals, scan: () => Promise<IdeScan> = scanIdes, probe: () => Promise<{ installed: boolean; exe: string | null }> = probeObsidian) {
  const file = join(ctx.paths.config, 'settings.json');
  let scanning: Promise<void> | null = null;
  let probing: Promise<void> | null = null;
  let scanError: string | null = null;
  let vaultWindows: string | null = null;

  const read = (): RawSettings => readJson<RawSettings>(file) ?? {};
  function write(next: RawSettings): void {
    mkdirSync(ctx.paths.config, { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
    renameSync(tmp, file);
    ctx.invalidate('settings');
  }

  function ides(raw: RawSettings): IdeEntry[] {
    const list = Array.isArray(raw.ides?.list) ? raw.ides.list : [];
    return list.filter((e) => e && typeof e.exe === 'string' && typeof e.id === 'string')
      .map((e) => ({ ...e, approved: approvals.isApproved(ideCommand(e.exe)) }));
  }

  // Scan results are trusted because the scanner found them here: it is the approval. Entries it did not write keep waiting.
  function runScan(): Promise<void> {
    scanning ??= (async () => {
      scanError = null;
      ctx.invalidate('settings');
      try {
        const result = await scan();
        for (const e of result.ides) approvals.approve(ideCommand(e.exe), `ide:${e.id}`);
        const raw = read();
        const foreign = ides(raw).filter((e) => e.source === 'manual' && !result.ides.some((f) => f.exe === e.exe));
        write({ ...raw, ides: { scannedAt: Date.now(), list: [...result.ides, ...foreign], obsidian: { installed: result.obsidianInstalled, exe: result.obsidianExe } } });
      } catch (err) {
        scanError = (err as Error).message.split('\n')[0];
        ctx.app.log.warn(err);
      }
    })().finally(() => {
      scanning = null;
      ctx.invalidate('settings');
    });
    return scanning;
  }

  function view(): SettingsView {
    const raw = read();
    // The first look at the settings is the first launch.
    if (!raw.ides?.scannedAt && !scanning && !scanError) void runScan();
    vaultWindows ??= platformKind() === 'wsl' ? toWindowsPath(ctx.paths.vault) : ctx.paths.vault;
    return {
      platform: platformKind(),
      ides: ides(raw),
      scannedAt: raw.ides?.scannedAt ?? null,
      scanning: scanning !== null,
      scanError,
      obsidian: { installed: raw.ides?.obsidian?.installed ?? null, exe: raw.ides?.obsidian?.exe ?? null, dismissed: raw.obsidianDismissed === true, vaultWindows },
      projects: raw.projects ?? {},
      universe: universeOptions(raw.universe),
      home: homeLayout(raw.home),
      profile: profileOf(raw.profile),
      setup: setupOf(raw.setup),
    };
  }

  function setProject(key: string, patch: ProjectSettings): SettingsView {
    if (!/^[^/\\]+$/.test(key)) throw httpError(400, 'bad project key');
    const raw = read();
    const next: ProjectSettings = { ...raw.projects?.[key] };
    if (patch.model !== undefined) {
      if (patch.model !== null && !MODEL.test(patch.model)) throw httpError(400, 'bad model');
      next.model = patch.model;
    }
    if (patch.effort !== undefined) {
      if (patch.effort !== null && !EFFORTS.has(patch.effort)) throw httpError(400, 'bad effort');
      next.effort = patch.effort;
    }
    if (patch.ide !== undefined) {
      if (patch.ide !== null && !ides(raw).some((e) => e.id === patch.ide && e.approved)) throw httpError(400, 'unknown ide');
      next.ide = patch.ide;
    }
    write({ ...raw, projects: { ...raw.projects, [key]: next } });
    return view();
  }

  function setUniverse(patch: Partial<UniverseOptions>): SettingsView {
    if (patch.limit !== undefined && (!Number.isInteger(patch.limit) || patch.limit < UNIVERSE_LIMIT.min || patch.limit > UNIVERSE_LIMIT.max)) throw httpError(400, 'bad limit');
    if (patch.theme !== undefined && !THEMES.includes(patch.theme)) throw httpError(400, 'bad theme');
    if (patch.colors !== undefined && !Object.values(patch.colors ?? {}).every((c) => typeof c === 'string' && HEX.test(c))) throw httpError(400, 'bad colour');
    const raw = read();
    write({ ...raw, universe: universeOptions({ ...universeOptions(raw.universe), ...patch }) });
    return view();
  }

  function setHome(body: Partial<HomeLayout>): SettingsView {
    const slots = body?.slots;
    if (!slots || typeof slots !== 'object' || !Object.keys(slots).every((s) => HOME_SLOTS.includes(s as HomeSlot) && Array.isArray(slots[s as HomeSlot]))) throw httpError(400, 'bad slots');
    if (body.hidden !== undefined && !Array.isArray(body.hidden)) throw httpError(400, 'bad hidden');
    write({ ...read(), home: homeLayout(body) });
    return view();
  }

  const rootOf = (key: string) => safely(() => ctx.journal.listProjects(true), []).find((p) => p.key === key)?.root ?? null;

  function forProject(key: string): ProjectIde {
    const raw = read();
    const root = rootOf(key);
    if (!root) throw httpError(404, 'unknown project');
    return projectIde(root, ides(raw), raw.projects?.[key]?.ide);
  }

  async function open(body: { ide?: unknown; project?: unknown; cwd?: unknown; file?: unknown }): Promise<void> {
    const raw = read();
    const cwd = body.cwd !== undefined ? validateCwd(body.cwd) : null;
    const key = typeof body.project === 'string' ? body.project : null;
    const target = typeof body.file === 'string' ? validatePath(body.file) : cwd ?? (key ? validateCwd(rootOf(key)) : null);
    if (!target) throw httpError(400, 'cwd, project or file is required');
    const entry = typeof body.ide === 'string'
      ? ides(raw).find((e) => e.id === body.ide) ?? null
      : projectIde(key ? rootOf(key) ?? target : target, ides(raw), key ? raw.projects?.[key]?.ide : null).chosen;
    if (!entry) throw httpError(404, 'no IDE found: run the scan in Settings');
    if (!entry.approved) throw httpError(409, 'this IDE entry was not found by the scan and is waiting for approval in Settings');
    const { bin, args } = ideArgv(entry, target, { kind: platformKind(), isFile: typeof body.file === 'string' });
    await launchDetached(bin, args);
    ctx.audit('ide.open', entry.id, target);
  }

  function approve(id: string): SettingsView {
    const e = ides(read()).find((x) => x.id === id);
    if (!e) throw httpError(404, 'unknown ide');
    approvals.approve(ideCommand(e.exe), `ide:${id}`);
    ctx.invalidate('settings');
    return view();
  }

  function dismissObsidian(): SettingsView {
    write({ ...read(), obsidianDismissed: true });
    return view();
  }

  // Repeated while the notice is on screen: an install must take the notice away without a restart.
  async function recheckObsidian(): Promise<SettingsView> {
    probing ??= probe().then((state) => {
      const raw = read();
      if (raw.ides?.obsidian?.installed !== state.installed || raw.ides?.obsidian?.exe !== state.exe) {
        write({ ...raw, ides: { ...raw.ides, obsidian: { installed: state.installed, exe: state.exe } } });
      }
    }).catch((err: Error) => {
      ctx.app.log.warn(err);
    }).finally(() => {
      probing = null;
    });
    await probing;
    return view();
  }

  // Obsidian answers obsidian:// only for vaults it already lists; say so instead of its own bare error.
  function obsidianKnowsVault(bin: string): boolean {
    const list = readJson<{ vaults?: Record<string, { path?: string }> }>(join(dirname(dirname(dirname(dirname(bin)))), 'Roaming', 'obsidian', 'obsidian.json'));
    if (!list?.vaults) return true; // no list where it should be: not ours to judge
    const norm = (p: string) => p.replaceAll('/', '\\').replace(/^\\\\wsl\$\\/i, '\\\\wsl.localhost\\').replace(/\\+$/, '').toLowerCase();
    const wanted = norm(platformKind() === 'wsl' ? toWindowsPath(ctx.paths.vault) : ctx.paths.vault);
    return Object.values(list.vaults).some((v) => typeof v?.path === 'string' && norm(v.path) === wanted);
  }

  // The exe itself, not the link handler: the handler is only registered once Obsidian has run, and a dead link fails silently.
  async function openObsidian(url: unknown): Promise<void> {
    if (typeof url !== 'string' || !url.startsWith('obsidian://open?path=')) throw httpError(400, 'bad obsidian url');
    const exe = read().ides?.obsidian?.exe;
    if (!exe) throw httpError(404, 'Obsidian was not found');
    const bin = platformKind() === 'wsl' ? toLinuxPath(exe) : exe;
    if (!obsidianKnowsVault(bin)) throw httpError(409, 'vault is not open in Obsidian');
    await launchDetached(bin, [url]);
    ctx.audit('obsidian.open', 'obsidian', url);
  }

  // The first profile needs every field, later a patch is enough.
  function setProfile(patch: Partial<Profile>): SettingsView {
    const raw = read();
    const next = { ...profileOf(raw.profile), ...patch };
    const error = profileError(next, patch.projectsDir !== undefined);
    if (error) throw httpError(400, error);
    write({ ...raw, profile: profileOf(next) });
    return view();
  }

  function saveSetup(patch: Partial<SetupState>): void {
    const raw = read();
    write({ ...raw, setup: setupOf({ ...setupOf(raw.setup), ...patch }) });
  }

  function projectDefaults(key: string): { model: string | null; effort: string | null } {
    const p = read().projects?.[key];
    return { model: typeof p?.model === 'string' ? p.model : null, effort: typeof p?.effort === 'string' ? p.effort : null };
  }

  return { view, setProject, setUniverse, setHome, setProfile, forProject, open, approve, dismissObsidian, recheckObsidian, openObsidian, projectDefaults, profile: () => profileOf(read().profile), setup: () => setupOf(read().setup), saveSetup, scan: async () => { await runScan(); return view(); } };
}

export type Settings = ReturnType<typeof createSettings>;
