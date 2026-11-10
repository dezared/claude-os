import assert from 'node:assert/strict';
import { test } from 'node:test';
import { insertAtCaret, insertItems, meterLevel, micProblem, pcmToBase64, splitItems, toPcm16 } from '../../web/src/work/voice/pcm.ts';
import { cleanTranscript, decodePcm16, SAMPLE_RATE, splitAtPauses, trimSilence } from './audio.ts';

const tone = (sec: number, amp = 0.3) => Float32Array.from({ length: Math.round(sec * SAMPLE_RATE) }, (_, i) => amp * Math.sin(i / 8));
const join = (...parts: Float32Array[]) => {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const quiet = (sec: number) => new Float32Array(Math.round(sec * SAMPLE_RATE));

test('pcm survives the trip from float chunks through base64 to the server', () => {
  const sent = toPcm16([Float32Array.from([0, 0.5, -0.5]), Float32Array.from([1, -1, 2, -2])]);
  assert.deepEqual([...sent], [0, 16383, -16383, 32767, -32767, 32767, -32767]);
  const got = decodePcm16(pcmToBase64(sent));
  assert.equal(got.length, 7);
  assert.ok(Math.abs(got[1] - 0.5) < 0.001);
  assert.ok(Math.abs(got[4] + 1) < 0.001);
});

test('base64 holds a recording too long for a single String.fromCharCode', () => {
  const pcm = new Int16Array(SAMPLE_RATE * 10).fill(1234);
  const got = decodePcm16(pcmToBase64(pcm));
  assert.equal(got.length, pcm.length);
  assert.equal(Math.round(got[got.length - 1] * 32768), 1234);
});

test('silence and clicks do not count as speech', () => {
  assert.equal(trimSilence(quiet(3)), null);
  assert.equal(trimSilence(new Float32Array(0)), null);
  assert.equal(trimSilence(join(quiet(2), tone(0.05), quiet(2))), null);
  // Steady hum: the threshold follows the noise floor.
  assert.equal(trimSilence(tone(3, 0.02)), null);
});

test('speech keeps its margins, the silence around it goes', () => {
  const trimmed = trimSilence(join(quiet(3), tone(1), quiet(3)));
  assert.ok(trimmed);
  const sec = trimmed.length / SAMPLE_RATE;
  assert.ok(sec > 1.3 && sec < 1.7, `kept ${sec}s`);
});

test('long audio is cut at a pause and loses nothing', () => {
  const pcm = join(tone(25), quiet(0.5), tone(25), quiet(0.5), tone(10));
  const parts = splitAtPauses(pcm);
  assert.equal(parts.length, 3);
  assert.equal(parts.reduce((n, p) => n + p.length, 0), pcm.length);
  assert.ok(parts[0].length / SAMPLE_RATE >= 25 && parts[0].length / SAMPLE_RATE <= 25.5);
  for (const p of parts) assert.ok(p.length / SAMPLE_RATE <= 28);
});

test('short audio stays whole; audio with no pause is still cut within the window', () => {
  assert.equal(splitAtPauses(tone(5)).length, 1);
  const parts = splitAtPauses(tone(70));
  assert.ok(parts.length >= 3);
  for (const p of parts) assert.ok(p.length / SAMPLE_RATE <= 28);
});

test('invented credits go, real speech about subtitles stays', () => {
  assert.equal(cleanTranscript('Редактор субтитров А.Синецкая Корректор А.Егорова'), '');
  assert.equal(cleanTranscript('Субтитры субтитры субтитры'), '');
  assert.equal(cleanTranscript(' Субтитры сделал DimaTorzok '), '');
  assert.equal(cleanTranscript('Субтитры надо поправить в плеере'), 'Субтитры надо поправить в плеере');
  assert.equal(cleanTranscript('Корректор нужно обновить'), 'Корректор нужно обновить');
});

test('a stuck decoder loses its repeats, English words stay as spoken', () => {
  assert.equal(cleanTranscript('запустил, запускай, запускай, запускай, запускай, запускай'), 'запустил, запускай');
  assert.equal(cleanTranscript('Сделай pull request в ветку main и запусти Docker.'), 'Сделай pull request в ветку main и запусти Docker.');
  assert.equal(cleanTranscript('да да, конечно'), 'да да, конечно');
});

test('the text lands at the caret with spaces only where needed', () => {
  assert.deepEqual(insertAtCaret('', 0, 0, 'привет'), { value: 'привет', caret: 6 });
  assert.deepEqual(insertAtCaret('один три', 4, 4, 'два'), { value: 'один два три', caret: 8 });
  assert.deepEqual(insertAtCaret('один ', 5, 5, 'два'), { value: 'один два', caret: 8 });
  assert.deepEqual(insertAtCaret('один.', 4, 4, 'два'), { value: 'один два.', caret: 8 });
  assert.deepEqual(insertAtCaret('заменить это', 9, 12, 'то'), { value: 'заменить то', caret: 11 });
});

test('dictation splits into items at a spoken "пункт" and at a sentence end, which is how the model writes a pause', () => {
  assert.deepEqual(splitItems('Сделай pull request. Перезапусти Docker. Обнови документацию.'), ['Сделай pull request', 'Перезапусти Docker', 'Обнови документацию']);
  assert.deepEqual(splitItems('купить молоко пункт позвонить маме, пункт: оплатить счёт'), ['Купить молоко', 'Позвонить маме', 'Оплатить счёт']);
  assert.deepEqual(splitItems('Пункт первый купить молоко. Пункт 2 позвонить маме'), ['Купить молоко', 'Позвонить маме']);
  assert.deepEqual(splitItems('Почему упал тест? Посмотреть логи'), ['Почему упал тест?', 'Посмотреть логи']);
});

test('item splitting leaves alone what only looks like a boundary', () => {
  assert.deepEqual(splitItems('взять пункты и подпункт, т. е. всё'), ['Взять пункты и подпункт, т. е. всё']);
  assert.deepEqual(splitItems('обновить Node.js до 22.1'), ['Обновить Node.js до 22.1']);
  assert.deepEqual(splitItems('пункт. Пункт'), []);
  // The English version has its own word, and the Russian one means nothing there.
  assert.deepEqual(splitItems('buy milk item call mom, Item 3: pay the bill', 'en'), ['Buy milk', 'Call mom', 'Pay the bill']);
  assert.deepEqual(splitItems('Item first buy milk. item two call mom', 'en'), ['Buy milk', 'Call mom']);
  assert.deepEqual(splitItems('купить молоко айтем позвонить маме', 'en'), ['Купить молоко', 'Позвонить маме']);
  assert.deepEqual(splitItems('items and subitem stay', 'en'), ['Items and subitem stay']);
  assert.deepEqual(splitItems('раз пункт два', 'en'), ['Раз пункт два']);
  assert.deepEqual(splitItems('one item two'), ['One item two']);
});

test('items land as checklist lines of their own', () => {
  assert.deepEqual(insertItems('', 0, 0, ['а', 'б']), { value: '- [ ] а\n- [ ] б', caret: 15 });
  assert.equal(insertItems('заметка', 7, 7, ['а']).value, 'заметка\n- [ ] а');
  assert.equal(insertItems('заметка\n', 8, 8, ['а']).value, 'заметка\n- [ ] а');
  assert.equal(insertItems('до после', 2, 2, ['а']).value, 'до\n- [ ] а\n после');
  // The empty item the caret stands on takes the first one, with its indent.
  assert.equal(insertItems('  - [ ] ', 8, 8, ['а', 'б']).value, '  - [ ] а\n  - [ ] б');
  assert.equal(insertItems('- [ ]', 5, 5, ['а']).value, '- [ ] а');
  const middle = insertItems('- [ ] один\n- [ ] два', 10, 10, ['новый']);
  assert.equal(middle.value, '- [ ] один\n- [ ] новый\n- [ ] два');
  assert.equal(middle.caret, 22);
});

test('the meter stays in 0..1 and silence reads as zero', () => {
  assert.equal(meterLevel(new Float32Array(800)), 0);
  assert.equal(meterLevel(new Float32Array(0)), 0);
  assert.equal(meterLevel(new Float32Array(800).fill(1)), 1);
  const speech = meterLevel(new Float32Array(800).fill(0.05));
  assert.ok(speech > 0.2 && speech < 1, String(speech));
});

test('microphone errors map to states the user can act on', () => {
  assert.equal(micProblem(new DOMException('x', 'NotAllowedError')), 'denied');
  assert.equal(micProblem(new DOMException('x', 'NotFoundError')), 'nodevice');
  assert.equal(micProblem(new DOMException('x', 'NotReadableError')), 'busy');
  assert.equal(micProblem(new TypeError('no mediaDevices')), 'other');
});
