// The model and language choice end to end on the server, with the fake engine behind CLAUDE_OS_VOICE_ENGINE.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { VoiceStatus } from '../../shared/voice.ts';
import { pcmToBase64, toPcm16 } from '../../web/src/work/voice/pcm.ts';
import { makeKit, type TestKit } from '../memory/testkit.ts';
import { createApprovals } from '../tools/approvals.ts';
import { createSettings, type Settings } from '../tools/settings.ts';
import { SAMPLE_RATE } from './audio.ts';
import { registerVoice } from './index.ts';
import { promptLanguage, voiceOptions } from './options.ts';

process.env.CLAUDE_OS_VOICE_ENGINE = join(import.meta.dirname, 'fixtures/fake-engine.ts');
process.env.CLAUDE_OS_VOICE_FAKE_STEP_MS = '5';

let kit: TestKit;
let settings: Settings;
const profile = { name: 'Test', language: 'ru', projectsDir: '/tmp', questionLevel: 'balanced' as const };
// A burst between pauses: a steady tone alone reads as hum, not speech.
const quiet = new Float32Array(SAMPLE_RATE);
const speech = pcmToBase64(toPcm16([quiet, Float32Array.from({ length: SAMPLE_RATE }, (_, i) => 0.3 * Math.sin(i / 8)), quiet]));

async function call<T>(method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object): Promise<T> {
  const res = await kit.ctx.app.inject({ method, url, payload });
  assert.equal(res.statusCode, 200, res.body);
  return res.json() as T;
}

async function install(): Promise<VoiceStatus> {
  await call('POST', '/api/voice/enable');
  for (let i = 0; i < 200; i++) {
    const s = await call<VoiceStatus>('GET', '/api/voice');
    if (s.state === 'ready') return s;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail('the model did not install');
}

describe('voice model and language settings', () => {
  beforeEach(() => {
    kit = makeKit();
    mkdirSync(kit.paths.config, { recursive: true });
    settings = createSettings(kit.ctx, createApprovals(kit.ctx), async () => ({ ides: [], obsidianInstalled: false, obsidianExe: null }));
    kit.ctx.settings = settings;
  });
  afterEach(() => kit.close());

  it('defaults follow the profile, a patch is validated and stored, a hand-edited file falls back', () => {
    const file = join(kit.paths.config, 'settings.json');
    assert.deepEqual(settings.view().voice, { model: 'whisper-small', language: 'en' });
    writeFileSync(file, JSON.stringify({ profile }));
    assert.deepEqual(settings.view().voice, { model: 'whisper-small', language: 'ru' }, 'the profile language when unset');
    assert.deepEqual(settings.setVoice({ model: 'whisper-large-v3-turbo-russian' }).voice, { model: 'whisper-large-v3-turbo-russian', language: 'ru' });
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).voice, { model: 'whisper-large-v3-turbo-russian' }, 'the language is not stored until picked');
    assert.equal(settings.setVoice({ language: 'auto' }).voice.language, 'auto');
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).profile.name, 'Test', 'other keys survive');
    assert.throws(() => settings.setVoice({ model: 'whisper-huge' as never }), /model: one of/);
    assert.throws(() => settings.setVoice({ language: 'xx' as never }), /language: one of/);
    assert.ok(kit.topics.includes('voice'), 'the voice status refetches');
    writeFileSync(file, JSON.stringify({ profile: { ...profile, language: 'eo' }, voice: { model: 7, language: 'klingon' } }));
    assert.deepEqual(settings.view().voice, { model: 'whisper-small', language: 'en' });
    assert.deepEqual(voiceOptions({ language: 'uk' }, 'ru'), { model: 'whisper-small', language: 'uk' });
  });

  it('the jargon prompt is Russian for Russian speech and for detection under a Russian profile', () => {
    assert.equal(promptLanguage('ru', 'en'), 'ru');
    assert.equal(promptLanguage('auto', 'ru'), 'ru');
    assert.equal(promptLanguage('auto', 'en'), 'en');
    assert.equal(promptLanguage('uk', 'ru'), 'en');
  });

  it('the engine gets the chosen model and language; each model installs and is removed on its own', async () => {
    registerVoice(kit.ctx);
    writeFileSync(join(kit.paths.config, 'settings.json'), JSON.stringify({ profile }));
    const small = await install();
    assert.deepEqual(small.installed, ['whisper-small']);
    assert.ok(existsSync(join(kit.paths.data, 'voice/installed')), 'whisper-small keeps its old marker');
    let res = await call<{ text: string }>('POST', '/api/voice/transcribe', { pcm: speech });
    assert.match(res.text, /\[whisper-small ru ru\]$/);

    settings.setVoice({ model: 'whisper-large-v3-turbo', language: 'auto' });
    const turbo = await call<VoiceStatus>('GET', '/api/voice');
    assert.equal(turbo.state, 'off', 'a model not downloaded yet');
    assert.equal(turbo.modelBytes, 1_087_527_940);
    const refused = await kit.ctx.app.inject({ method: 'POST', url: '/api/voice/transcribe', payload: { pcm: speech } });
    assert.equal(refused.statusCode, 409);
    assert.deepEqual((await install()).installed, ['whisper-small', 'whisper-large-v3-turbo']);
    res = await call<{ text: string }>('POST', '/api/voice/transcribe', { pcm: speech });
    assert.match(res.text, /\[whisper-large-v3-turbo auto ru\]$/);

    const removed = await call<VoiceStatus>('DELETE', '/api/voice/model');
    assert.deepEqual(removed.installed, ['whisper-small']);
    assert.ok(existsSync(join(kit.paths.data, 'voice/model/onnx-community/whisper-small/model.onnx')), 'the other model stays');
    assert.ok(!existsSync(join(kit.paths.data, 'voice/model/onnx-community/whisper-large-v3-turbo')));
    settings.setVoice({ model: 'whisper-small' });
    assert.deepEqual((await call<VoiceStatus>('DELETE', '/api/voice/model')).installed, []);
    assert.ok(!existsSync(join(kit.paths.data, 'voice')), 'the folder goes with the last model');
  });
});
