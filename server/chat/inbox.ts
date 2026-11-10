import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

// The prompt stream of a query: open for as long as the process lives.
export class Inbox {
  private items: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private closed = false;
  push(m: SDKUserMessage) { this.items.push(m); this.wake?.(); }
  close() { this.closed = true; this.wake?.(); }
  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      while (this.items.length) yield this.items.shift()!;
      if (this.closed) return;
      await new Promise<void>((r) => { this.wake = r; });
      this.wake = null;
    }
  }
}
