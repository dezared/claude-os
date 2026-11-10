import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findViolations, type Violation } from './check-shippable.ts';

const brief = (list: Violation[]) => list.map(({ path, line, rule }) => ({ path, line, rule }));

test('flags Cyrillic outside the allowlist', () => {
  const found = findViolations([{ path: 'server/x.ts', text: 'a\nconst s = "Привет";' }], []);
  assert.deepEqual(brief(found), [{ path: 'server/x.ts', line: 2, rule: 'cyrillic' }]);
});

test('allows Cyrillic in the ru catalog and tests', () => {
  const files = ['web/src/lib/locales/ru.ts', 'server/a.test.ts', 'e2e/b.ts'].map((path) => ({ path, text: 'Привет' }));
  assert.deepEqual(findViolations(files, []), []);
});

// Home paths are split so this file never contains one.
const HOME = '/ho' + 'me/alice/x';

test('flags home paths', () => {
  const text = [
    `'${HOME}'`,
    "'C:\\Us" + "ers\\alice\\x'",
    "'_proj" + "ects/_self'",
    "'/Us" + "ers/alice/x'",
    "'C:/Us" + "ers/alice/x'",
  ].join('\n');
  const found = findViolations([{ path: 'server/x.ts', text }], []);
  assert.deepEqual(brief(found), [1, 2, 3, 4, 5].map((line) => ({ path: 'server/x.ts', line, rule: 'home-path' })));
});

test('a home folder inside the repo is not a home path', () => {
  const text = "import { Home } from '@/home/Home';\nimport x from '../web/src/home/x.ts';\nconst f = './home/a';";
  assert.deepEqual(findViolations([{ path: 'web/src/x.ts', text }], []), []);
});

test('a Windows home seen from WSL is a home path', () => {
  const found = findViolations([{ path: 'server/x.ts', text: "'/mnt/c/Us" + "ers/alice/x'" }], []);
  assert.deepEqual(brief(found), [{ path: 'server/x.ts', line: 1, rule: 'home-path' }]);
});

test('flags private words case-insensitively', () => {
  const found = findViolations([{ path: 'server/x.ts', text: 'by иван' }], ['Иван']);
  assert.deepEqual(found.map((v) => v.rule).sort(), ['cyrillic', 'private-word']);
});

test('a private word matches whole words only', () => {
  const words = (text: string, list: string[]) => findViolations([{ path: 'server/a.test.ts', text }], list).map((v) => v.rule);
  assert.deepEqual(words('const annotation = 1;', ['Ann']), []);
  assert.deepEqual(words('// by Ann.', ['ann']), ['private-word']);
  assert.deepEqual(words('Иваново', ['Иван']), [], 'a Cyrillic word inside a longer one');
  assert.deepEqual(words('(Иван)', ['Иван']), ['private-word']);
  assert.deepEqual(words('Ann2', ['ann']), [], 'a digit continues the word');
  assert.deepEqual(words('a.b+c', ['a.b+c']), ['private-word'], 'regex characters are literal');
});

test('allows plugin localization fields', () => {
  const path = 'plugins/p/plugin.json';
  assert.deepEqual(findViolations([{ path, text: '{\n  "descriptionRu": "Описание"\n}' }], []), []);
  const found = findViolations([{ path, text: '{\n  "description": "Описание"\n}' }], []);
  assert.deepEqual(brief(found), [{ path, line: 2, rule: 'cyrillic' }]);
  const list = '{\n  "featuresRu": [\n    "Первое",\n    "Второе"\n  ],\n  "features": [\n    "Третье"\n  ]\n}';
  assert.deepEqual(brief(findViolations([{ path, text: list }], [])), [{ path, line: 7, rule: 'cyrillic' }]);
});

test('allows Cyrillic in plugin end-to-end tools', () => {
  assert.deepEqual(findViolations([{ path: 'plugins/p/tools/e2e.mjs', text: 'Привет' }], []), []);
  assert.equal(findViolations([{ path: 'plugins/p/tools/build.mjs', text: 'Привет' }], []).length, 1);
});

test('a trailing shippable-allow comment skips Cyrillic only', () => {
  const marked = (text: string) => brief(findViolations([{ path: 'server/x.ts', text }], ['Иван']));
  assert.deepEqual(marked('const legacy = "Задачи"; // shippable-allow: old data key'), []);
  assert.deepEqual(marked('legacy: Задачи # shippable-allow: old data key'), []);
  assert.deepEqual(marked('const s = "shippable-allow: x" + "Задачи";'), [{ path: 'server/x.ts', line: 1, rule: 'cyrillic' }]);
  assert.deepEqual(marked(`const p = '${HOME}'; // shippable-allow: test`), [{ path: 'server/x.ts', line: 1, rule: 'home-path' }]);
  assert.deepEqual(marked('const n = "Иван"; // shippable-allow: test'), [{ path: 'server/x.ts', line: 1, rule: 'private-word' }]);
});

test('placeholder homes in tests and fixtures are allowed, private words are not', () => {
  const paths = ['server/a.test.ts', 'e2e/fixture-server.ts', 'server/chat/fixtures/fake.mjs'];
  assert.deepEqual(findViolations(paths.map((path) => ({ path, text: `'${HOME}'\n'C:\\Us` + `ers\\u\\x'` })), []), []);
  const own = "'/x/_proj" + "ects/_self/y'";
  assert.deepEqual(brief(findViolations(paths.map((path) => ({ path, text: own })), [])), paths.map((path) => ({ path, line: 1, rule: 'home-path' })), 'the owner\'s folder is never a placeholder');
  assert.equal(findViolations([{ path: 'web/fixtures/a.ts', text: `'${HOME}'` }], []).length, 1, 'only the server fixtures');
  const found = findViolations(paths.map((path) => ({ path, text: 'by Иван' })), ['Иван']);
  assert.deepEqual(brief(found), paths.map((path) => ({ path, line: 1, rule: 'private-word' })));
  assert.deepEqual(brief(findViolations([{ path: 'server/a.ts', text: `'${HOME}'` }], [])), [{ path: 'server/a.ts', line: 1, rule: 'home-path' }]);
});

test('allows the localized keys of a microtask and a knowledge file', () => {
  const text = '---\ntitle: Do it\ntitle_ru: Сделать\n---\nСделай это';
  for (const path of ['root/microtasks/x.md', 'root/document-knowledge/x.md']) assert.deepEqual(brief(findViolations([{ path, text }], [])), [{ path, line: 5, rule: 'cyrillic' }]);
  const body = '---\ntitle: Do it\n---\ntitle_ru: Сделать';
  assert.deepEqual(brief(findViolations([{ path: 'root/microtasks/x.md', text: body }], [])), [{ path: 'root/microtasks/x.md', line: 4, rule: 'cyrillic' }], 'only inside the leading frontmatter');
  assert.equal(findViolations([{ path: 'root/other.md', text: 'title_ru: Сделать' }], []).length, 1, 'only in microtasks');
});
