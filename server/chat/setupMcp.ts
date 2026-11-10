// The two tools of the first-run setup tab: the onboarding writes the profile through them, never by editing files.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createSdkMcpServer, tool, type Options } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { Profile } from '../../shared/contract.ts';
import type { Ctx } from '../context.ts';
import { QUESTION_LEVELS } from './profile.ts';

// A server of its own; the setup tab gets no other.
export const SETUP_MCP_NAME = 'claude-os-setup';
export const SETUP_TOOLS = ['save_profile', 'complete_setup'].map((t) => `mcp__${SETUP_MCP_NAME}__${t}`);

const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] });
const fail = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true });

// config/private-words.txt is the local denylist of check:shippable: the user's name must never reach a tracked file.
export function addPrivateWords(file: string, name: string): void {
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const known = new Set(text.split('\n').map((w) => w.trim().toLowerCase()).filter(Boolean));
  const fresh = [...new Set(name.toLowerCase().split(/\s+/).filter((w) => w.length >= 3 && !known.has(w)))]; // a shorter word would flag half the code
  if (fresh.length === 0) return;
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${text && !text.endsWith('\n') ? '\n' : ''}${fresh.join('\n')}\n`);
}

export const createSetupMcp = (ctx: Ctx, tabId: string) => createSdkMcpServer({
  name: SETUP_MCP_NAME,
  tools: [
    tool('save_profile', 'Save the user\'s profile from the setup answers. Validated by the server; the error names the field to fix.', {
      name: z.string().describe('How to address the user'),
      language: z.string().describe('ISO 639 code of the reply and UI language, like en or ru'),
      projectsDir: z.string().describe('Absolute path of an existing writable folder for new projects'),
      questionLevel: z.string().describe(`One of ${Object.keys(QUESTION_LEVELS).join(', ')}`),
    }, async (input) => {
      try {
        const view = ctx.settings!.setProfile(input as Partial<Profile>); // the same check as PUT /api/settings/profile
        addPrivateWords(join(ctx.paths.config, 'private-words.txt'), view.profile!.name);
        return ok(JSON.stringify(view.profile));
      } catch (err) {
        return fail((err as Error).message);
      }
    }),

    tool('complete_setup', 'Mark the first-run setup as finished. Call after save_profile succeeded.', {}, async () => {
      if (!ctx.settings!.profile()) return fail('No profile yet: call save_profile first');
      ctx.settings!.saveSetup({ step: 'done', completedAt: Date.now(), tabId });
      return ok('Setup complete');
    }),
  ],
});

// The setup tab's options: its own two tools instead of the tab's claude-os ones, and no built-in tool but asking the user.
// Everything the onboarding needs from the machine is in its first prompt: nothing here reads, runs or changes anything.
export function withSetupTools(ctx: Ctx, tabId: string, options: Partial<Options>): Partial<Options> {
  return {
    ...options,
    mcpServers: { [SETUP_MCP_NAME]: createSetupMcp(ctx, tabId) },
    allowedTools: SETUP_TOOLS,
    tools: ['AskUserQuestion'],
  };
}
