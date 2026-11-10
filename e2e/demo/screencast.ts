// Records a page at the rate Chromium paints it (60 frames a second here) through the DevTools screencast, then
// rebuilds a constant 60 fps video from the frame timestamps. Playwright's own recorder is fixed at 25 fps.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CDPSession, Page } from 'playwright';

type Frame = { data: Buffer; at: number };

export interface Recording {
  stop: () => Promise<Frame[]>;
}

export async function record(page: Page): Promise<Recording> {
  const cdp: CDPSession = await page.context().newCDPSession(page);
  const frames: Frame[] = [];
  cdp.on('Page.screencastFrame', (f) => {
    frames.push({ data: Buffer.from(f.data, 'base64'), at: f.metadata.timestamp ?? Date.now() / 1000 });
    void cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 95, everyNthFrame: 1 });
  return {
    stop: async () => {
      await cdp.send('Page.stopScreencast');
      return frames;
    },
  };
}

/** Frames -> an H.264 MP4 at a constant 60 fps. A frame lasts until the next one: the screencast skips still frames. */
export function toMp4(frames: Frame[], dir: string, out: string): void {
  const lines: string[] = [];
  frames.forEach((f, i) => {
    const file = join(dir, `f${String(i).padStart(5, '0')}.jpg`);
    writeFileSync(file, f.data);
    const next = frames[i + 1]?.at ?? f.at + 1 / 60;
    lines.push(`file '${file}'`, `duration ${(next - f.at).toFixed(5)}`);
  });
  // The concat demuxer ignores the last duration unless the last file is listed again.
  lines.push(`file '${join(dir, `f${String(frames.length - 1).padStart(5, '0')}.jpg`)}'`);
  writeFileSync(join(dir, 'frames.txt'), lines.join('\n'));
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', join(dir, 'frames.txt'),
    '-vf', 'fps=60,format=yuv420p', '-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-movflags', '+faststart', out]);
}

/** MP4 -> an animated WebP that plays by itself in a README, like a GIF, at the full 60 fps. */
export function toWebp(mp4: string, out: string, width: number): void {
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', mp4, '-vf', `fps=60,scale=${width}:-1:flags=lanczos`,
    '-c:v', 'libwebp_anim', '-lossless', '0', '-quality', '72', '-compression_level', '6', '-loop', '0', '-an', out]);
}
