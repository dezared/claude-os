// A view updated batch by batch equals a full rebuild with a cold lint cache, over random writes, deletes and renames.
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { newLintCache } from './noteIndex.ts';
import { createScanner } from './scanner.ts';
import { drain } from './scan.ts';
import { makeKit } from './testkit.ts';
import { buildView, pairKey, viewNoteCache, type View } from './view.ts';
import { updateView } from './viewDelta.ts';

const kit = makeKit();
after(() => kit.close());

function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

const NAMES = ['alpha', 'beta', 'gamma', 'delta', 'eps', 'zeta', 'eta', 'theta'];
const TAGS = ['infra', 'db', 'ui', 'ops', 'billing'];
const sorted = <T>(xs: T[]) => [...xs].sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));

// What a full rebuild and an update must agree on; edge and backlink order is not part of it.
function normal(v: View) {
  const path = (id: string) => v.byId.get(id)?.path ?? id;
  return {
    notes: v.notes.map((n) => n.path),
    byId: sorted([...v.byId].map(([id, n]) => [id, n.path])),
    byName: sorted([...v.byName].map(([k, l]) => [k, l.map((n) => n.path)])),
    edges: sorted(v.edges.map(([a, b]) => pairKey(path(a), path(b)))),
    backlinks: sorted([...v.backlinks].map(([k, l]) => [path(k), sorted(l.map(path))])),
    degree: sorted([...v.degree].map(([k, d]) => [path(k), d])),
    unresolved: v.unresolved,
    drift: sorted([...v.drift]),
    names: sorted([...v.lint.names]),
    tags: sorted([...v.lint.tags].filter(([, t]) => t.length)),
    issues: sorted([...v.lint.issues].map(([k, c]) => [path(k), c])),
    out: sorted([...v.out].map(([k, t]) => [path(k), t.map((x) => (x ? path(x) : null))])),
    linkers: sorted([...v.linkers].filter(([, s]) => s.size).map(([k, s]) => [k, sorted([...s].map(path))])),
    pairs: sorted([...v.pairs]),
  };
}

const { vault, claudeDir } = kit.paths;
const old = join(claudeDir, 'projects', 'old', 'memory');
const VAULT_DIRS = [join(vault, 'projects', 'p1'), join(vault, 'projects', 'p2'), join(vault, 'global')];
let DIRS = [...VAULT_DIRS, old];

function noteText(rand: () => number, name: string): string {
  const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
  const links = Array.from({ length: Math.floor(rand() * 3) }, () => `[[${pick(NAMES)}]]`).join(' ');
  if (rand() < 0.15) return `# ${name}\n\nNo frontmatter. ${links}\n`;
  const tags = [...new Set([pick(TAGS), pick(TAGS)])].join(', ');
  return `---\nname: ${rand() < 0.8 ? name : pick(NAMES)}\ndescription: About ${name} and ${pick(TAGS)}\nmetadata:\n  type: project\n  tags: [${tags}]\n---\nThe ${name} note. ${links}\n`;
}

function write(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

// One random write, delete or rename; returns the paths it touched.
function op(rand: () => number, live: Set<string>): string[] {
  const at = () => join(DIRS[Math.floor(rand() * DIRS.length)], `${NAMES[Math.floor(rand() * NAMES.length)]}${rand() < 0.3 ? '_x' : ''}.md`);
  const some = () => [...live][Math.floor(rand() * live.size)];
  const r = rand();
  if (r < 0.2 && live.size) {
    const p = some();
    rmSync(p);
    live.delete(p);
    return [p];
  }
  if (r < 0.35 && live.size) {
    const from = some();
    const to = at();
    rmSync(from);
    live.delete(from);
    write(to, noteText(rand, NAMES[0]));
    live.add(to);
    return [from, to];
  }
  const p = at();
  write(p, noteText(rand, p.split('/').pop()!.replace(/(_x)?\.md$/, '')));
  live.add(p);
  return [p];
}

const deps = (lintCache = newLintCache()) => ({
  paths: kit.paths,
  keyForDir: (dir: string) => (dir === 'old' ? 'p1' : null),
  connectedDir: (key: string) => (key === 'p1' ? join(vault, 'projects', 'p1') : null),
  viewNote: viewNoteCache(),
  lintCache,
});

const runAll = (jobs: (() => void)[]) => {
  while (jobs.length) jobs.pop()!();
};

test('a view updated by random batches equals a full rebuild after every batch', async () => {
  // With old-place notes every note is placed again; without them only the changed ones are.
  for (const [seed, withOld] of [[1, true], [7, true], [42, true], [3, false], [11, false]] as const) {
    DIRS = withOld ? [...VAULT_DIRS, old] : VAULT_DIRS;
    for (const d of [...VAULT_DIRS, old]) rmSync(d, { recursive: true, force: true });
    const rand = rng(seed);
    const live = new Set<string>();
    for (let i = 0; i < 12; i++) op(rand, live);
    const scanner = createScanner({ vault, claudeProjects: join(claudeDir, 'projects') }, null);
    await scanner.ready;
    const kept = deps();
    let view = drain(buildView(kept, scanner.current()));
    runAll(view.lint.pending);
    for (let batch = 0; batch < 60; batch++) {
      // Some ops are read by the scanner before the view sees them: one update then spans several versions.
      for (let i = 1 + Math.floor(rand() * 4); i > 0; i--) {
        scanner.mark(op(rand, live));
        if (rand() < 0.3) scanner.current();
      }
      const scan = scanner.current();
      const changed = scanner.changedSince(view.version);
      assert.ok(changed, 'the scanner knows what changed');
      const update = updateView(kept, view, scan, { changes: changed, fileAt: scanner.file, oldPlace: scanner.oldPlace(), budgetMs: rand() < 0.5 ? 0 : Infinity });
      runAll(update.jobs);
      view = update.view;
      const full = drain(buildView(deps(), scan));
      runAll(full.lint.pending);
      assert.deepEqual(normal(view), normal(full), `seed ${seed}, batch ${batch}`);
    }
    await scanner.close();
  }
});
