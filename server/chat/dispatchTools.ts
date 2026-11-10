// Tabs out of a conversation: the root session has them, and a service job whose template asks for them (MICROTASK_TOOLS).
import { mkdirSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { Ctx } from '../context.ts';
import type { Chat } from './manager.ts';

export const ok = (data: unknown) => ({ content: [{ type: 'text' as const, text: typeof data === 'string' ? data : JSON.stringify(data, null, 1) }] });
export const fail = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true });

// One name, one directory right under the configured place. Nothing that could leave it.
export function projectDirFor(baseDir: string, name: string): string | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name) || name.includes('..')) return null;
  const base = resolve(baseDir);
  const dir = resolve(base, name);
  return dir.startsWith(base + sep) ? dir : null;
}

export const resumeSessionTool = (chat: Chat) => tool('resume_session', 'Continue an old session in a tab with its history: the tab where it is already open, or a new one. A new process picks up the MCP of the project again. prompt is optional: without it the tab waits for the user.', {
  session_id: z.string().describe('Id from list_sessions'),
  prompt: z.string().min(1).optional(),
}, async ({ session_id, prompt }) => {
  try {
    await chat.settleClosedChild(session_id); // a tab closed a moment ago: its process ends before a new one starts
    return ok(chat.resumeInTab(session_id, prompt));
  } catch (err) {
    return fail((err as Error).message);
  }
});

export const createProjectTool = (ctx: Ctx, chat: Chat) => tool('create_project', 'Create the folder of a new project, open a tab and start a session in it with the given request.', {
  name: z.string().describe('Folder name: Latin letters, digits, dot, hyphen, underscore'),
  prompt: z.string().min(1),
}, async ({ name, prompt }) => {
  // CLAUDE_OS_NEW_PROJECTS, then the profile's folder, then ~/Projects.
  const base = process.env.CLAUDE_OS_NEW_PROJECTS ? ctx.paths.newProjectsDir : ctx.settings?.profile()?.projectsDir ?? ctx.paths.newProjectsDir;
  const dir = projectDirFor(base, name);
  if (!dir) return fail(`Invalid project name: ${JSON.stringify(name)}. Only one folder name: Latin letters, digits, ".", "-", "_", up to 64 characters.`);
  mkdirSync(base, { recursive: true });
  try {
    mkdirSync(dir);
  } catch (err) {
    return fail((err as NodeJS.ErrnoException).code === 'EEXIST' ? `The folder already exists: ${dir}` : `The folder was not created: ${(err as Error).message}`);
  }
  ctx.audit('create_project', join(dir));
  return ok(chat.openWithPrompt({ cwd: dir, title: name }, prompt));
});
