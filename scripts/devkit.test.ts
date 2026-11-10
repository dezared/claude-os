import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const read = (path: string) => readFileSync(join(REPO, path), 'utf8');
const lineCount = (text: string) => text.split('\n').length - (text.endsWith('\n') ? 1 : 0);

// The leading `---` block of a markdown file, or '' when there is none.
function frontmatter(text: string): string {
  if (!text.startsWith('---\n')) return '';
  const end = text.indexOf('\n---', 4);
  return end < 0 ? '' : text.slice(4, end);
}

const field = (fm: string, key: string) => fm.match(new RegExp(`^${key}:[ \\t]*(.*)$`, 'm'))?.[1].trim() ?? null;
const pathList = (fm: string) => [...fm.matchAll(/^\s+-\s+"([^"]+)"$/gm)].map((m) => m[1]);

const RULES = '.claude/rules';

test('claude md is at most 60 lines', () => {
  assert.ok(lineCount(read('CLAUDE.md')) <= 60);
});

test('unconditional rules are at most 50 lines', () => {
  const rules = readdirSync(join(REPO, RULES)).filter((n) => n.endsWith('.md')).sort();
  const unconditional = rules.filter((n) => field(frontmatter(read(`${RULES}/${n}`)), 'paths') === null);
  assert.deepEqual(unconditional, ['00-workflow.md', '10-code-standard.md', '20-mistakes.md']);
  const total = unconditional.reduce((sum, n) => sum + lineCount(read(`${RULES}/${n}`)), 0);
  assert.ok(total <= 50, `unconditional rules have ${total} lines`);
});

test('path-scoped rules declare paths', () => {
  const expected: Record<string, string[]> = {
    'prompts.md': ['root/**', 'service/**', 'setup/**', 'server/chat/profile.ts', 'server/chat/rootMcp.ts', 'server/tools/documents.ts'],
    'server.md': ['server/**', 'shared/**'],
    'web.md': ['web/src/**'],
    'tests.md': ['**/*.test.ts', 'e2e/**'],
  };
  for (const [name, paths] of Object.entries(expected)) {
    const fm = frontmatter(read(`${RULES}/${name}`));
    assert.equal(field(fm, 'paths'), '', `${name} has no paths: key`);
    assert.deepEqual(pathList(fm), paths, name);
  }
});

test('agent names match file names and skills are not model-invocable', () => {
  const agents = readdirSync(join(REPO, '.claude/agents')).filter((n) => n.endsWith('.md')).sort();
  assert.deepEqual(agents, ['reviewer.md', 'scout.md', 'test-runner.md']);
  for (const file of agents) assert.equal(field(frontmatter(read(`.claude/agents/${file}`)), 'name'), file.slice(0, -3));

  const skills = readdirSync(join(REPO, '.claude/skills')).sort();
  assert.deepEqual(skills, ['compound', 'feature', 'handoff', 'promote', 'spec', 'split-file', 'techdebt']);
  for (const dir of skills) {
    const text = read(`.claude/skills/${dir}/SKILL.md`);
    const fm = frontmatter(text);
    assert.equal(field(fm, 'name'), dir);
    assert.equal(field(fm, 'disable-model-invocation'), 'true', dir);
    assert.ok(lineCount(text) <= 40, `${dir} has ${lineCount(text)} lines`);
  }
});

// An agent's `tools:` takes tool names: a `Bash(...)` specifier there does not restrict Bash, so command limits live in the prompt.
test('agent tools are plain tool names', () => {
  for (const file of readdirSync(join(REPO, '.claude/agents')).filter((n) => n.endsWith('.md'))) {
    const tools = field(frontmatter(read(`.claude/agents/${file}`)), 'tools') ?? '';
    assert.doesNotMatch(tools, /\(/, file);
  }
});

test('settings deny edits to the hooks and both settings files', () => {
  const { deny } = (JSON.parse(read('.claude/settings.json')) as { permissions: { deny: string[] } }).permissions;
  for (const rule of ['Edit(./.claude/hooks/**)', 'Edit(./.claude/settings.json)', 'Edit(./.claude/settings.local.json)']) {
    assert.ok(deny.includes(rule), rule);
  }
});
