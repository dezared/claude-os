// Preloaded into a server process by memory-compare.ts (node --import): the longest event-loop stall since the last
// SIGUSR2, written to MEMCOMPARE_LOOP_FILE on each SIGUSR2, which also starts the next window. Nothing else changes.
import { writeFileSync } from 'node:fs';

const file = process.env.MEMCOMPARE_LOOP_FILE;
if (file) {
  // A 5 ms timer measures how late it fires: lateness is time the loop was held by something else.
  let max = 0;
  let tick = performance.now();
  setInterval(() => {
    const now = performance.now();
    max = Math.max(max, now - tick - 5);
    tick = now;
  }, 5).unref();
  process.on('SIGUSR2', () => {
    writeFileSync(file, JSON.stringify({ maxStall: max, at: Date.now() }));
    max = 0;
  });
}
