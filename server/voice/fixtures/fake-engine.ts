// Stands in for engine.ts in tests: same messages, no model, no network. Reports the bytes received, so a test can see the audio arrived.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EngineReply, EngineRequest } from '../index.ts';

const send = (m: EngineReply) => process.send?.(m);
process.on('disconnect', () => process.exit(0));
process.on('message', async (m: EngineRequest) => {
  if (m.type === 'load') {
    if (m.download) {
      mkdirSync(m.dir, { recursive: true });
      for (const loaded of [60_000_000, 120_000_000, 251_846_613]) {
        await new Promise((r) => setTimeout(r, Number(process.env.CLAUDE_OS_VOICE_FAKE_STEP_MS ?? 300)));
        send({ type: 'progress', loaded });
      }
      writeFileSync(join(m.dir, 'model.onnx'), Buffer.alloc(4096));
    }
    send({ type: 'loaded' });
    return;
  }
  await new Promise((r) => setTimeout(r, Number(process.env.CLAUDE_OS_VOICE_FAKE_DELAY_MS ?? 0)));
  const scripted = process.env.CLAUDE_OS_VOICE_FAKE_TEXT_FILE;
  send({ type: 'text', id: m.id, text: scripted && existsSync(scripted) ? readFileSync(scripted, 'utf8') : `сделай pull request (${Buffer.from(m.pcm, 'base64').length} байт)` });
});
