// /secret: the field's mask, the store under data/, and the tools that write a value without showing it.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { parseEnv } from 'node:util';
import { editField, hasSecretLine, maskField, SECRET_MARKER, secretLines, secretMarker, splitSecret } from '../../shared/secrets.ts';
import { deleteSecret, migrateSecrets, saveSecret, saveTabSecret, secretEnv, secretNames, secretRules, sessionDataOptions, secretsDir, secretValue } from './secrets.ts';
import { keepOutOfGit, secretTools, upsertEnvLine } from './secretTools.ts';

const dir = mkdtempSync(join(tmpdir(), 'claude-os-secrets-'));
after(() => rmSync(dir, { recursive: true, force: true }));

// Types the characters one by one at the end of the field, as the composer's onChange sees them.
function type(chars: string, start = { raw: '', shown: '' }) {
  let { raw, shown } = start;
  for (const ch of chars) {
    const next = shown + ch;
    raw = editField(raw, shown, next, next.length) ?? raw;
    shown = maskField(raw);
  }
  return { raw, shown };
}

describe('the field mask', () => {
  it('shows dots for the value and never the value', () => {
    const { raw, shown } = type('/secret ghp_abc123');
    assert.equal(raw, '/secret ghp_abc123');
    assert.equal(shown, '/secret ••••••••••');
    assert.ok(!shown.includes('abc'));
  });

  it('keeps an uppercase name readable once its = is typed, the value masked', () => {
    const { raw, shown } = type('/secret API_KEY=s3cr3t');
    assert.equal(shown, '/secret API_KEY=••••••');
    assert.deepEqual(splitSecret(raw.slice('/secret '.length)), { name: 'API_KEY', value: 's3cr3t' });
  });

  it('an uppercase first word is no name without =: it may be the value itself', () => {
    assert.equal(type('/secret AKIAXYZ').shown, '/secret •••••••');
    assert.deepEqual(splitSecret('AKIAXYZ'), { name: null, value: 'AKIAXYZ' });
    assert.equal(type('/secret AKIAXYZ rest').shown, `/secret ${'•'.repeat('AKIAXYZ rest'.length)}`);
    assert.deepEqual(splitSecret('AKIAXYZ rest'), { name: null, value: 'AKIAXYZ rest' });
  });

  it('applies a deletion in the middle at the caret, not at the end', () => {
    const { raw, shown } = type('/secret abcdef');
    const caret = '/secret ab'.length; // Backspace after "b"
    const after = shown.slice(0, caret - 1) + shown.slice(caret);
    assert.equal(editField(raw, shown, after, caret - 1), '/secret acdef');
  });

  it('applies an insertion and a paste over a selection at the caret', () => {
    const { raw, shown } = type('/secret abcdef');
    const at = '/secret abc'.length;
    assert.equal(editField(raw, shown, `${shown.slice(0, at)}X${shown.slice(at)}`, at + 1), '/secret abcXdef');
    const pasted = `${shown.slice(0, at - 1)}PQ${shown.slice(at + 1)}`; // "cd" selected and replaced
    assert.equal(editField(raw, shown, pasted, at + 1), '/secret abPQef');
  });

  it('a whole command pasted into an empty field is masked at once', () => {
    const raw = editField('', '', '/secret tok_1', 13);
    assert.equal(raw, '/secret tok_1');
    assert.equal(maskField(raw), '/secret •••••');
  });

  it('breaking the prefix keeps the dots, the value does not come back as plain text', () => {
    const { raw, shown } = type('/secret abc');
    const after = shown.slice(0, 7) + shown.slice(8); // the space after /secret deleted
    assert.equal(editField(raw, shown, after, 7), '/secret•••');
  });

  it('an undo that puts text back with the caret before it is taken as it is', () => {
    // Chrome's undo restores the text selected, so the caret sits at its start, not after it.
    assert.equal(editField('лог ', 'лог ', 'лог [Вставка #1]', 'лог '.length), 'лог [Вставка #1]');
  });

  it('text that is no /secret command is left alone', () => {
    assert.equal(maskField('hello /secret x'), 'hello /secret x');
    assert.equal(type('hello').raw, 'hello');
  });

  it('masks a /secret line anywhere in the text, only its value, the other lines stay readable', () => {
    const { raw, shown } = type('first line\nsecond\n/secret API_KEY=s3cr3t\nthird /secret x\n/secret tok');
    assert.equal(shown, 'first line\nsecond\n/secret API_KEY=••••••\nthird /secret x\n/secret •••');
    assert.equal(raw, 'first line\nsecond\n/secret API_KEY=s3cr3t\nthird /secret x\n/secret tok');
    assert.ok(hasSecretLine(raw) && !hasSecretLine('a /secret b') && !hasSecretLine('/secret'));
    assert.deepEqual(secretLines(raw).map(({ name, value }) => [name, value]), [['API_KEY', 's3cr3t'], [null, 'tok']]);
  });

  it('an edit on a plain line around secret lines lands in place and keeps every value', () => {
    const { raw, shown } = type('hello\n/secret A=one\nmid\n/secret B=two\nend');
    const at = 'hel'.length;
    assert.equal(editField(raw, shown, `${shown.slice(0, at)}X${shown.slice(at)}`, at + 1), 'helXlo\n/secret A=one\nmid\n/secret B=two\nend');
    const mid = shown.indexOf('mid') + 3;
    assert.equal(editField(raw, shown, `${shown.slice(0, mid - 1)}${shown.slice(mid)}`, mid - 1), 'hello\n/secret A=one\nmi\n/secret B=two\nend');
    const inValue = shown.indexOf('B=') + 3; // Backspace after the "t" of "two"
    assert.equal(editField(raw, shown, `${shown.slice(0, inValue - 1)}${shown.slice(inValue)}`, inValue - 1), 'hello\n/secret A=one\nmid\n/secret B=wo\nend');
  });

  it('a new line typed after a value starts plain text; a value cut by a line break keeps its tail as dots', () => {
    const { raw, shown } = type('/secret abc\nnext', type('note\n'));
    assert.equal(shown, 'note\n/secret •••\nnext');
    const cut = 'note\n/secret a'.length;
    const after = `${shown.slice(0, cut)}\n${shown.slice(cut)}`;
    assert.equal(editField(raw, shown, after, cut + 1), 'note\n/secret a\n••\nnext');
  });

  it('breaking one prefix keeps that line dots and the other values intact', () => {
    const { raw, shown } = type('/secret A=one\n/secret two');
    const at = shown.lastIndexOf('/secret ') + 7;
    const after = shown.slice(0, at) + shown.slice(at + 1);
    const next = editField(raw, shown, after, at);
    assert.equal(next, '/secret A=one\n/secret•••');
    assert.equal(maskField(next!), '/secret A=•••\n/secret•••');
  });

  it('a multi-line paste into a value is refused, a paste of whole lines around it is not', () => {
    const { raw, shown } = type('x\n/secret ab');
    const at = shown.length;
    assert.equal(editField(raw, shown, `${shown}KEY\nline two`, at + 'KEY\nline two'.length), null);
    assert.equal(editField(raw, shown, `${shown}KEY\n`, at + 4), 'x\n/secret abKEY\n');
    assert.equal(editField(raw, shown, `a\nb\n${shown}`, 4), 'a\nb\nx\n/secret ab');
  });

  it('the marker names the secret and the chat finds it', () => {
    const text = `before ${secretMarker('API_KEY')} after`;
    assert.deepEqual([...text.matchAll(SECRET_MARKER)].map((m) => m[1]), ['API_KEY']);
  });
});

describe('the store', () => {
  const file = join(dir, 'data', 'secrets');

  it('is one file per scope, readable by its owner only, in a folder only the owner opens', () => {
    saveSecret(file, '/p/a', 'TOKEN', 'one');
    saveSecret(file, '/p/z', 'TOKEN', 'zzz');
    assert.equal(statSync(file).mode & 0o777, 0o700);
    const files = readdirSync(file);
    assert.equal(files.length, 2);
    for (const f of files) assert.equal(statSync(join(file, f)).mode & 0o777, 0o600);
    assert.equal(files.filter((f) => readFileSync(join(file, f), 'utf8').includes('zzz')).length, 1, 'a scope file holds its own scope only');
    deleteSecret(file, '/p/z', 'TOKEN');
  });

  it('moves the old single file into one file per scope', () => {
    const data = join(dir, 'legacy-data');
    mkdirSync(data);
    writeFileSync(join(data, 'secrets.json'), JSON.stringify({ '/p/a': { A: '1' }, proj: { B: '2' } }), { mode: 0o600 });
    migrateSecrets({ paths: { data } } as never);
    assert.deepEqual(readdirSync(data), ['secrets']);
    assert.equal(secretValue(join(data, 'secrets'), '/p/a', 'A'), '1');
    assert.equal(secretValue(join(data, 'secrets'), 'proj', 'B'), '2');
    migrateSecrets({ paths: { data } } as never); // nothing left to move
    assert.equal(readdirSync(join(data, 'secrets')).length, 2);
  });

  it('keeps each project apart and names unnamed values SECRET_<n>', () => {
    assert.equal(saveSecret(file, '/p/a', null, 'two'), 'SECRET_1');
    assert.equal(saveSecret(file, '/p/a', null, 'three'), 'SECRET_2');
    assert.equal(saveSecret(file, '/p/b', null, 'other'), 'SECRET_1');
    assert.deepEqual(secretNames(file, '/p/a'), ['SECRET_1', 'SECRET_2', 'TOKEN']);
    assert.deepEqual(secretEnv(file, '/p/b'), { SECRET_1: 'other' });
    assert.equal(secretValue(file, '/p/b', 'TOKEN'), undefined);
  });

  it('replaces a value under the same name and forgets a deleted one', () => {
    saveSecret(file, '/p/a', 'TOKEN', 'new');
    assert.equal(secretValue(file, '/p/a', 'TOKEN'), 'new');
    assert.equal(deleteSecret(file, '/p/a', 'TOKEN'), true);
    assert.equal(deleteSecret(file, '/p/a', 'TOKEN'), false);
    assert.equal(secretValue(file, '/p/a', 'TOKEN'), undefined);
  });
});

describe('the route', () => {
  const data = join(dir, 'route-data');
  const sent: string[] = [];
  const sentAttachments: unknown[] = [];
  const audits: string[] = [];
  const ctx = {
    paths: { data },
    audit: (action: string, target: string, diff?: string | null) => audits.push(`${action} ${target} ${diff}`),
    chat: { tabInfo: () => ({ cwd: '/w/proj', project: 'proj', kind: 'work' }), get: () => ({ send: (r: { text: string; attachments?: unknown }) => sent.push(r.text) && sentAttachments.push(r.attachments) }) },
    settings: { setup: () => ({ tabId: 'tab-setup' }) },
  } as never;

  it('stores the value, sends only the marker, returns and audits only the name', () => {
    const out = saveTabSecret(ctx, 'tab-1', { name: 'GH_TOKEN', value: ' ghp_hidden ' });
    assert.deepEqual(out, { name: 'GH_TOKEN' });
    assert.deepEqual(sent, [secretMarker('GH_TOKEN')]);
    assert.ok(![...sent, ...audits, JSON.stringify(out)].some((s) => s.includes('ghp_hidden')));
    assert.equal(secretValue(secretsDir(ctx), 'proj', 'GH_TOKEN'), 'ghp_hidden');
  });

  it('a message with /secret lines stores each value and sends the rest with the markers inline, in one turn', () => {
    sent.length = 0;
    const attachments = [{ name: 'a.txt', mediaType: 'text/plain', base64: 'eA==' }];
    const out = saveTabSecret(ctx, 'tab-1', { text: 'deploy it\n/secret DB_PASS= pa55 \nand\n/secret tok_9\nthanks', attachments });
    assert.deepEqual(out, { names: ['DB_PASS', 'SECRET_1'] });
    assert.deepEqual(sent, [`deploy it\n${secretMarker('DB_PASS')}\nand\n${secretMarker('SECRET_1')}\nthanks`]);
    assert.deepEqual(sentAttachments.at(-1), attachments);
    assert.ok(![...sent, ...audits, JSON.stringify(out)].some((s) => s.includes('pa55') || s.includes('tok_9')));
    assert.equal(secretValue(secretsDir(ctx), 'proj', 'DB_PASS'), 'pa55');
    assert.equal(secretValue(secretsDir(ctx), 'proj', 'SECRET_1'), 'tok_9');
  });

  it('a message with a bad /secret line stores nothing and sends nothing', () => {
    sent.length = 0;
    assert.throws(() => saveTabSecret(ctx, 'tab-1', { text: '/secret OK_ONE=v1\n/secret PATH=x' }), (e: Error & { key?: string }) => e.key === 'reservedSecretName');
    assert.throws(() => saveTabSecret(ctx, 'tab-1', { text: 'hi\n/secret OK_ONE=v1\n/secret   ' }), (e: Error & { key?: string }) => e.key === 'emptySecret');
    assert.throws(() => saveTabSecret(ctx, 'tab-1', { text: 'no secret here' }), (e: Error & { key?: string }) => e.key === 'emptySecret');
    assert.deepEqual(sent, []);
    assert.equal(secretValue(secretsDir(ctx), 'proj', 'OK_ONE'), undefined);
  });

  it('refuses a name that would replace the env of the server or the session', () => {
    process.env.SECRETS_TEST_PRESENT = '1';
    for (const name of ['PATH', 'HOME', 'USER', 'SHELL', 'NODE_OPTIONS', 'ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'SECRETS_TEST_PRESENT']) {
      assert.throws(() => saveTabSecret(ctx, 'tab-1', { name, value: 'x' }), (e: Error & { key?: string }) => e.key === 'reservedSecretName', name);
    }
    delete process.env.SECRETS_TEST_PRESENT;
    assert.equal(secretValue(secretsDir(ctx), 'proj', 'PATH'), undefined);
  });

  it('the setup tab has no secret tools, so it refuses to keep one', () => {
    assert.throws(() => saveTabSecret(ctx, 'tab-setup', { value: 'x' }), (e: Error & { key?: string }) => e.key === 'secretInSetup');
  });

  it('refuses an empty value and a name that is not env style', () => {
    assert.throws(() => saveTabSecret(ctx, 'tab-1', { value: '  ' }), (e: Error & { key?: string }) => e.key === 'emptySecret');
    assert.throws(() => saveTabSecret(ctx, 'tab-1', { name: 'bad name', value: 'x' }), (e: Error & { key?: string }) => e.key === 'badSecretName');
  });

  it('a new session of the project gets the values as env, and neither Read nor Bash opens the store', () => {
    saveSecret(secretsDir(ctx), 'proj', 'PATH', '/evil'); // saved before names were checked
    saveSecret(secretsDir(ctx), 'proj', 'NODE_OPTIONS', '--require=/evil.js');
    const options = sessionDataOptions(ctx, { project: 'proj', cwd: '/w/proj' });
    assert.equal(options.env?.GH_TOKEN, 'ghp_hidden');
    assert.equal(options.env?.PATH, process.env.PATH);
    assert.equal(options.env?.NODE_OPTIONS, process.env.NODE_OPTIONS);
    assert.ok(options.disallowedTools?.some((t) => t.startsWith('Read(//') && t.endsWith('/secrets/**)')));
    assert.ok(options.disallowedTools?.includes('Bash(*data/secrets*)'));
    assert.ok(options.disallowedTools?.some((t) => t.startsWith('Bash(*/') && t.endsWith('/secrets*)')));
    assert.deepEqual(secretRules(ctx), options.disallowedTools?.filter((t) => !t.startsWith('Edit(')));
    assert.ok(options.disallowedTools?.some((t) => t.startsWith('Edit(//') && t.endsWith('/**)')), 'data/ stays unwritable');
    assert.equal(sessionDataOptions(ctx, { project: 'other', cwd: '/w/other' }).env, undefined);
  });
});

describe('write_secret', () => {
  it('replaces the KEY line in place, appends a new one, quotes what needs it', () => {
    const env = join(dir, 'env-test', '.env');
    upsertEnvLine(env, 'A', '1');
    writeFileSync(env, '# top\nexport A=old\nB=2\n');
    upsertEnvLine(env, 'A', 'new');
    upsertEnvLine(env, 'C', 'has space "q"');
    assert.equal(readFileSync(env, 'utf8'), '# top\nA=new\nB=2\nC=\'has space "q"\'\n');
  });

  it('round-trips values with quotes, backslashes, $, backticks and newlines through a dotenv reader', () => {
    const env = join(dir, 'env-trip', '.env');
    const values = ['a"b\\c$d`e #f', "it's", "it's\nline two", 'one\ntwo', "it's \\ fine $HOME", '  padded  ', 'plain_word'];
    values.forEach((v, i) => assert.equal(upsertEnvLine(env, `K${i}`, v), true, v));
    const parsed = parseEnv(readFileSync(env, 'utf8'));
    values.forEach((v, i) => assert.equal(parsed[`K${i}`], v, v));
  });

  it('refuses a value no dotenv quoting can carry, and writes nothing', () => {
    const env = join(dir, 'env-refuse', '.env');
    assert.equal(upsertEnvLine(env, 'K', 'it\'s "both"'), false);
    assert.equal(upsertEnvLine(env, 'K', "a'b \\n literal"), false);
    assert.throws(() => readFileSync(env));
  });

  it('a project nested in a parent repository is covered too', () => {
    const repo = mkdtempSync(join(dir, 'parent-'));
    execFileSync('git', ['init', '-q', repo]);
    const project = join(repo, 'sub');
    upsertEnvLine(join(project, '.env'), 'K', 'v');
    assert.equal(keepOutOfGit(project, join(project, '.env')), 'added /.env to .gitignore');
    assert.equal(keepOutOfGit(project, join(project, '.env')), '.env is already git-ignored');
    assert.equal(readFileSync(join(project, '.gitignore'), 'utf8'), '/.env\n');
  });

  it('adds the file to .gitignore in a git repo, once', () => {
    const repo = mkdtempSync(join(dir, 'repo-'));
    execFileSync('git', ['init', '-q', repo]);
    upsertEnvLine(join(repo, '.env'), 'K', 'v');
    assert.equal(keepOutOfGit(repo, join(repo, '.env')), 'added /.env to .gitignore');
    assert.equal(keepOutOfGit(repo, join(repo, '.env')), '.env is already git-ignored');
    assert.equal(readFileSync(join(repo, '.gitignore'), 'utf8'), '/.env\n');
  });

  it('the tool writes the value into the project, answers without it and stays inside the folder', async () => {
    const project = mkdtempSync(join(dir, 'proj-'));
    const ctx = { paths: { data: join(dir, 'tool-data') }, audit: () => {}, chat: { tabInfo: () => ({ cwd: project, project: null, kind: 'work' }) } } as never;
    saveSecret(secretsDir(ctx), project, 'DB_PASS', 'pa55word');
    saveSecret(secretsDir(ctx), project, 'BOTH', `it's "q"`);
    const call = async (name: string, args: unknown) => {
      const found = secretTools(ctx, 'tab').find((t) => t.name === name)!;
      const r = await (found.handler as (a: unknown, extra: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>)(args, {});
      return { text: r.content[0].text, error: r.isError === true };
    };
    assert.deepEqual(await call('list_secrets', {}), { text: JSON.stringify(['BOTH', 'DB_PASS'], null, 1), error: false });
    const refused = await call('write_secret', { name: 'BOTH' });
    assert.equal(refused.error, true);
    assert.match(refused.text, /cannot be written to a dotenv file/);
    const written = await call('write_secret', { name: 'DB_PASS', key: 'PGPASSWORD' });
    assert.equal(written.error, false);
    assert.ok(!written.text.includes('pa55word'));
    assert.equal(readFileSync(join(project, '.env'), 'utf8'), 'PGPASSWORD=pa55word\n');
    assert.equal((await call('write_secret', { name: 'DB_PASS', file: '../outside.env' })).error, true);
    assert.equal((await call('write_secret', { name: 'NOPE' })).error, true);
    assert.equal((await call('delete_secret', { name: 'DB_PASS' })).text, 'deleted');
    assert.deepEqual(secretNames(secretsDir(ctx), project), ['BOTH']);
  });

  it('warns when the file is tracked, says so outside git', () => {
    const repo = mkdtempSync(join(dir, 'tracked-'));
    execFileSync('git', ['init', '-q', repo]);
    writeFileSync(join(repo, '.env'), 'K=v\n');
    execFileSync('git', ['-C', repo, 'add', '.env']);
    assert.match(keepOutOfGit(repo, join(repo, '.env')), /^warning: \.env is tracked/);
    const plain = mkdtempSync(join(dir, 'plain-'));
    assert.equal(keepOutOfGit(plain, join(plain, '.env')), 'not a git repository');
  });
});
