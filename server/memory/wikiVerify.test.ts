import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LintCtx } from './lint.ts';
import { factTokens, readMap, rewriteLinks, verifyBatch, type MapEntry } from './wikiVerify.ts';

const lintCtx = (file: string): LintCtx => ({
  path: `.wiki-migration/p/run/1/out/${file}`,
  project: 'p',
  names: new Map(),
  tags: ['db'],
  resolves: () => true,
});

const note = (name: string, body = 'Generate migrations with the diff tool, then review them.\n', tags = '[db]') =>
  `---\nname: ${name}\ndescription: How are migrations made and reviewed\nmetadata:\n  type: feedback\n  tags: ${tags}\n---\n${body}`;

const old = (body: string) => `---\nname: project\ndescription: Old aggregate\ntype: project\n---\n${body}`;

const entry = (o: Partial<MapEntry> & { old: string }): MapEntry => ({ new: [], primary: null, dropped: [], ...o });

const run = (a: { inputs: { file: string; text: string }[]; map: MapEntry[]; out: Record<string, string>; taken?: string[] }) =>
  verifyBatch({ inputs: a.inputs, map: a.map, out: new Map(Object.entries(a.out)), lintCtx, taken: new Set(a.taken ?? []) });

test('every input must be mapped once', () => {
  const r = run({
    inputs: [
      { file: 'a.md', text: old('Alpha.\n') },
      { file: 'b.md', text: old('Beta.\n') },
      { file: 'c.md', text: old('Gamma.\n') },
    ],
    map: [
      entry({ old: 'a.md', new: ['alpha-fact.md'], primary: 'alpha-fact.md' }),
      entry({ old: 'a.md', new: ['alpha-fact.md'], primary: 'alpha-fact.md' }),
      entry({ old: 'b.md', new: ['alpha-fact.md'], primary: 'alpha-fact.md' }),
      entry({ old: 'zzz.md', new: ['alpha-fact.md'], primary: 'alpha-fact.md' }),
    ],
    out: { 'alpha-fact.md': note('alpha-fact') },
  });
  assert.equal(r.errors.length, 3, r.errors.join('\n'));
  assert.match(r.errors.join('\n'), /a\.md is mapped 2 times/);
  assert.match(r.errors.join('\n'), /c\.md is missing from map\.json/);
  assert.match(r.errors.join('\n'), /zzz\.md is not an input/);
});

test('an old note dropped whole needs a reason', () => {
  const inputs = [{ file: 'a.md', text: old('Alpha.\n') }];
  assert.match(run({ inputs, map: [entry({ old: 'a.md' })], out: {} }).errors.join('\n'), /a\.md has no new notes and no dropped reason/);
  const ok = run({ inputs, map: [entry({ old: 'a.md', dropped: [{ what: 'Alpha', why: 'stale' }] })], out: {} });
  assert.deepEqual(ok, { errors: [], warnings: [] });
});

test('new files must exist and pass lint', () => {
  const r = run({
    inputs: [{ file: 'a.md', text: old('Alpha.\n') }],
    map: [entry({ old: 'a.md', new: ['alpha-fact.md', 'gone.md', 'bad-tags.md'], primary: 'alpha-fact.md' })],
    out: {
      'alpha-fact.md': note('alpha-fact', `${'Long body. '.repeat(160)}\n`),
      'bad-tags.md': note('bad-tags', undefined, '[]'),
      'stray.md': note('stray'),
    },
  });
  const errors = r.errors.join('\n');
  assert.match(errors, /gone\.md is listed for a\.md but absent from out\//);
  assert.match(errors, /bad-tags\.md: metadata\.tags has 0/);
  assert.match(errors, /stray\.md is in out\/ but no map\.json entry lists it/);
  assert.equal(r.errors.length, 3, errors);
  assert.equal(r.warnings.length, 1, r.warnings.join('\n'));
  assert.match(r.warnings[0], /alpha-fact\.md: body is \d+ chars; aim for 1500/);
});

test('primary must be one of new', () => {
  const inputs = [
    { file: 'a.md', text: old('Alpha.\n') },
    { file: 'b.md', text: old('Beta.\n') },
  ];
  const r = run({
    inputs,
    map: [
      entry({ old: 'a.md', new: ['alpha-fact.md'], primary: 'other.md' }),
      entry({ old: 'b.md', primary: 'alpha-fact.md', dropped: [{ what: 'Beta', why: 'stale' }] }),
    ],
    out: { 'alpha-fact.md': note('alpha-fact') },
  });
  assert.match(r.errors.join('\n'), /a\.md: primary "other\.md" is not one of its new notes/);
  assert.match(r.errors.join('\n'), /b\.md: primary must be null when it has no new notes/);
  assert.equal(r.errors.length, 2, r.errors.join('\n'));
});

test('names collide with the vault and within the batch', () => {
  const r = run({
    inputs: [{ file: 'a.md', text: old('Alpha.\n') }],
    map: [entry({ old: 'a.md', new: ['db-review.md', 'alpha_fact.md', 'alpha-fact.md'], primary: 'alpha-fact.md' })],
    out: { 'db-review.md': note('db-review'), 'alpha_fact.md': note('alpha-fact'), 'alpha-fact.md': note('alpha-fact') },
    taken: ['DB_Review'],
  });
  const errors = r.errors.join('\n');
  assert.match(errors, /db-review\.md: name "db-review" is taken in the vault/);
  assert.match(errors, /alpha_fact\.md, alpha-fact\.md: same name "alpha-fact" twice in the batch/);
  assert.equal(r.errors.length, 2, errors);
});

test('a merged note listed by two old notes is no collision', () => {
  const r = run({
    inputs: [
      { file: 'a.md', text: old('Alpha.\n') },
      { file: 'b.md', text: old('Beta.\n') },
    ],
    map: [
      entry({ old: 'a.md', new: ['alpha-fact.md'], primary: 'alpha-fact.md' }),
      entry({ old: 'b.md', new: ['alpha-fact.md'], primary: 'alpha-fact.md' }),
    ],
    out: { 'alpha-fact.md': note('alpha-fact') },
  });
  assert.deepEqual(r, { errors: [], warnings: [] });
});

test('fact tokens: code spans, urls, paths and numbers, deduplicated', () => {
  const text = [
    'Run `npm run build` (see https://example.com/docs/a_b?x=1.) before 2026-11-09.',
    'Config lives in server/memory/lint.ts, and `npm run build` again; 7 is short, 120 is not, v12 is a word.',
  ].join('\n');
  assert.deepEqual(factTokens(text).sort(), ['09', '11', '120', '2026', 'https://example.com/docs/a_b?x=1', 'npm run build', 'server/memory/lint.ts'].sort());
});

test('missing fact tokens are warnings, dropped ones are not', () => {
  const body = 'Use `doctrine:migrations:diff` and see docs/db.md; the limit is 120 rows, deploy at https://ci.example.com/job.\n';
  const r = run({
    inputs: [{ file: 'a.md', text: old(body) }],
    map: [
      entry({
        old: 'a.md',
        new: ['alpha-fact.md'],
        primary: 'alpha-fact.md',
        dropped: [{ what: 'the CI link https://ci.example.com/job', why: 'stale' }],
      }),
    ],
    out: { 'alpha-fact.md': note('alpha-fact', 'Generate with `doctrine:migrations:diff`; the limit is 1200 rows.\n') },
  });
  assert.deepEqual(r.errors, []);
  assert.equal(r.warnings.length, 1, r.warnings.join('\n'));
  assert.match(r.warnings[0], /^a\.md: /);
  assert.match(r.warnings[0], /`docs\/db\.md`/);
  assert.match(r.warnings[0], /`120`/);
  assert.doesNotMatch(r.warnings[0], /doctrine|ci\.example/);
});

test('fact tokens skip the old frontmatter stamps', () => {
  const text = `---\nname: a\ndescription: Kept 42 times\nmetadata:\n  type: project\n  originSessionId: 0b5c2f1e-1111\n  modified: 2026-11-09T10:00:00.000Z\n---\nAlpha.\n`;
  const r = run({
    inputs: [{ file: 'a.md', text }],
    map: [entry({ old: 'a.md', new: ['alpha-fact.md'], primary: 'alpha-fact.md' })],
    out: { 'alpha-fact.md': note('alpha-fact') },
  });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings.length, 1);
  assert.match(r.warnings[0], /`42`/);
  assert.doesNotMatch(r.warnings[0], /2026|1111/);
});

test('bad map.json is one error', () => {
  for (const text of ['{', '{"old": "a.md"}', '[{"old": "a.md", "new": "x.md", "primary": null, "dropped": []}]', '[{"old": "a.md", "new": [], "primary": null, "dropped": [{"what": "x"}]}]']) {
    const r = readMap(text);
    assert.deepEqual(r.entries, [], text);
    assert.equal(typeof r.error, 'string', text);
    assert.match(r.error!, /^map\.json/, text);
  }
  const ok = readMap('[{"old": "a.md", "new": ["x.md"], "primary": "x.md"}]');
  assert.deepEqual(ok, { entries: [{ old: 'a.md', new: ['x.md'], primary: 'x.md', dropped: [] }], error: null });
});

test('rewriteLinks keeps alias and section and touches only renamed names', () => {
  const renames = new Map([['old-name', 'new-name']]);
  const text = [
    'See [[Old_Name]], [[old-name|the rule]], [[old-name#Why]] and [[old-name#Why|why]].',
    'Path form [[notes/old-name.md]]; others stay: [[other]], [[old-name-2]].',
    'Code stays: `[[old-name]]`',
    '```',
    '[[old-name]]',
    '```',
    '',
  ].join('\n');
  const expected = [
    'See [[new-name]], [[new-name|the rule]], [[new-name#Why]] and [[new-name#Why|why]].',
    'Path form [[new-name]]; others stay: [[other]], [[old-name-2]].',
    'Code stays: `[[old-name]]`',
    '```',
    '[[old-name]]',
    '```',
    '',
  ].join('\n');
  assert.equal(rewriteLinks(text, renames), expected);
  assert.equal(rewriteLinks('no links', renames), 'no links');
});
