// Stands in for engine.ts in tests: same messages, no model, no network. A vector is a bag of words hashed into the
// dimensions, with a few synonyms folded together, so a test can find a note by a word it does not contain.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SEMANTIC_MODEL } from '../../../../shared/memorySemantic.ts';
import type { EngineReply, EngineRequest } from '../index.ts';

const SAME: Record<string, string> = { automobile: 'car', vehicle: 'car', 'машина': 'car', 'кэш': 'cache' }; // shippable-allow: Russian synonyms of the fake
const send = (m: EngineReply) => process.send?.(m);

function vector(text: string): Float32Array {
  const v = new Float32Array(SEMANTIC_MODEL.dims);
  for (const raw of text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []) {
    const word = SAME[raw] ?? raw;
    let h = 0;
    for (const ch of word) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    v[h % v.length] += 1;
  }
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
}

process.on('disconnect', () => process.exit(0));
process.on('message', async (m: EngineRequest) => {
  if (m.type === 'load') {
    const files = join(m.dir, SEMANTIC_MODEL.repo);
    mkdirSync(files, { recursive: true });
    for (const loaded of [50_000_000, SEMANTIC_MODEL.bytes]) {
      await new Promise((r) => setTimeout(r, 5));
      send({ type: 'progress', loaded });
    }
    writeFileSync(join(files, 'model.onnx'), Buffer.alloc(4096));
    send({ type: 'loaded' });
    return;
  }
  const out = new Float32Array(m.texts.length * SEMANTIC_MODEL.dims);
  m.texts.forEach((t, i) => out.set(vector(t), i * SEMANTIC_MODEL.dims));
  send({ type: 'vectors', id: m.id, data: Buffer.from(out.buffer).toString('base64') });
});
