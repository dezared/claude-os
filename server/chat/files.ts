import { execFile } from 'node:child_process';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import type { Attachment, ChatBlock, SendRequest } from '../../shared/contract.ts';
import { withServerPaths } from '../tools/platform.ts';

const run = promisify(execFile);
const MAX_RESULTS = 50;
const WALK_LIMIT = 5000;
const WALK_DEPTH = 8;
export const SKIP_DIRS = new Set(['.git', 'node_modules', 'vendor', 'dist', 'build', '.next', '__pycache__']);
const API_IMAGES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

function walk(root: string): string[] {
  const found: string[] = [];
  const visit = (dir: string, depth: number) => {
    if (found.length >= WALK_LIMIT || depth > WALK_DEPTH) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (found.length >= WALK_LIMIT) return;
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) visit(join(dir, e.name), depth + 1); }
      else if (e.isFile()) found.push(relative(root, join(dir, e.name)));
    }
  };
  visit(root, 0);
  return found;
}

// Null outside a git repo.
export async function gitFiles(cwd: string): Promise<string[] | null> {
  try {
    const { stdout } = await run('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd, timeout: 5000, maxBuffer: 64 * 1024 * 1024 });
    return stdout.split('\0').filter(Boolean);
  } catch {
    return null;
  }
}

async function allFiles(cwd: string): Promise<string[]> {
  return (await gitFiles(cwd)) ?? walk(cwd);
}

export async function completeFiles(cwd: string, q: string): Promise<string[]> {
  const needle = q.toLowerCase();
  const matches = (await allFiles(cwd)).filter((f) => f.toLowerCase().includes(needle));
  matches.sort((a, b) => Number(!basename(a).toLowerCase().includes(needle)) - Number(!basename(b).toLowerCase().includes(needle)) || a.length - b.length);
  return matches.slice(0, MAX_RESULTS);
}

export interface OutgoingMessage {
  blocks: ChatBlock[]; // what the chat shows
  content: string | Record<string, unknown>[]; // what Claude receives
}

function saveFile(dir: string, a: Attachment): string {
  mkdirSync(dir, { recursive: true });
  // The name comes from any system: both separators are cut, its letters stay, and no space breaks the path in the message.
  const safe = (a.name.split(/[\\/]/).pop() ?? '').replace(/[^\p{L}\p{N}_.\-]+/gu, '_').replace(/^\.+/, '').slice(-100) || 'file';
  const path = join(dir, `${randomUUID().slice(0, 8)}-${safe}`);
  writeFileSync(path, Buffer.from(a.base64, 'base64'));
  return path;
}

// A queued message with new text: its images stay.
export function withText(message: OutgoingMessage, text: string): OutgoingMessage {
  if (typeof message.content === 'string') return { blocks: [{ type: 'text', text }], content: text };
  const content: Record<string, unknown>[] = message.content.filter((b) => b.type !== 'text');
  const blocks: ChatBlock[] = message.blocks.filter((b) => b.type !== 'text');
  if (text) {
    content.push({ type: 'text', text });
    blocks.push({ type: 'text', text });
  }
  return { blocks, content };
}

// Plain text stays a string: only then does the CLI dispatch slash commands such as /compact.
export function buildMessage(req: SendRequest, uploadDir: string): OutgoingMessage {
  const text = typeof req.text === 'string' ? withServerPaths(req.text) : '';
  const attachments = req.attachments ?? [];
  if (attachments.length === 0) return { blocks: [{ type: 'text', text }], content: text };

  const images = attachments.filter((a) => API_IMAGES.has(a.mediaType));
  const notes = attachments.filter((a) => !API_IMAGES.has(a.mediaType)).map((a) => `Attached file: ${saveFile(uploadDir, a)}`);
  const fullText = [text, ...notes].filter(Boolean).join('\n');
  const content: Record<string, unknown>[] = images.map((a) => ({
    type: 'image', source: { type: 'base64', media_type: a.mediaType, data: a.base64 },
  }));
  if (fullText) content.push({ type: 'text', text: fullText });
  const blocks: ChatBlock[] = images.map((a) => ({ type: 'image', mediaType: a.mediaType, base64: a.base64 }));
  if (fullText) blocks.push({ type: 'text', text: fullText });
  return { blocks, content };
}
