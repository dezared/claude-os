// Background work of the memory module takes turns: one slice per turn of the event loop, whoever's it is. Node runs
// every immediate queued before a turn in one go, so five tasks with 15 ms slices each held the server for 75 ms.
const queue: (() => void)[] = [];
let scheduled = false;

function one() {
  scheduled = false;
  try {
    queue.shift()?.();
  } finally {
    schedule();
  }
}

function schedule() {
  if (scheduled || !queue.length) return;
  scheduled = true;
  setImmediate(one);
}

// Runs fn in a later turn, after the slices queued before it.
export function nextTurn(fn: () => void): { cancel(): void } {
  queue.push(fn);
  schedule();
  return {
    cancel() {
      const at = queue.indexOf(fn);
      if (at >= 0) queue.splice(at, 1);
    },
  };
}
