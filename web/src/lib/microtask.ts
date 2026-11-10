import { api } from './api';
import { locale } from './i18n';
import { toastError, useApp } from './store';
import { createTab } from './tabs';
import type { Microtask, NewTabRequest } from './types';

export interface MicrotaskRequest {
  id: string;
  vars?: Record<string, string>;
  project?: string | null; // lets the chooser offer "a new tab in this project"
  title?: string; // tab title for a new tab
  placeholder?: string; // what the free-text input asks for
  secondary?: { label: string; onClick: () => void }; // a path that spends no tokens
}

/** What a free-text request to Claude is about. `kind` and `context` go into the prompt, so they stay in English. */
export interface AskSubject {
  kind: string; // 'skill', 'hook', 'panel', 'selected text'...
  name: string;
  context?: string;
  project?: string | null; // lets the dialog offer "a new tab in this project"
}

export interface AskRequest {
  subject: AskSubject;
  title: string;
  presets?: string[];
  placeholder?: string;
  intent?: 'ask' | 'change';
}

/** One mechanism: a template, a chosen session, a label about tokens. Nothing is sent until the dialog's button. */
export function runMicrotask(req: MicrotaskRequest) {
  useApp.getState().setMicrotask(req);
}

/** The same path for what has no template: free text wrapped in the subject's context. */
export function askClaude(req: AskRequest) {
  useApp.getState().setAsk(req);
}

export function askPrompt({ subject, intent }: AskRequest, text: string): string {
  const head = intent === 'change' ? `Change the ${subject.kind} "${subject.name}" in Claude OS as requested below.` : `This is about the ${subject.kind} "${subject.name}" in Claude OS.`;
  return [head, subject.context && `Context:\n${subject.context}`, `Request:\n${text}`].filter(Boolean).join('\n\n');
}

export const fillPrompt = (prompt: string, vars: Record<string, string>) =>
  prompt.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? vars[name] : m));

export const microtaskTitle = (m: Microtask) => (locale() === 'ru' ? m.titleRu : m.title);

/** The service session takes it by default: the answer comes to a card, and it opens a tab itself when the job is big.
 *  `from` marks the tokens as Claude OS's own load in the analytics. */
export async function sendMicrotask(prompt: string, target: 'service' | 'new', req: Pick<MicrotaskRequest, 'project' | 'title'>, title: string, from: Pick<NewTabRequest, 'source' | 'sourceDetail'>): Promise<boolean> {
  try {
    if (target === 'service') {
      await api('/api/service/tasks', { method: 'POST', body: { title: req.title ?? title, prompt, project: req.project ?? null, ...from } });
      return true;
    }
    const tab = await createTab({ project: req.project ?? undefined, title: req.title ?? title, ...from });
    if (!tab) return false;
    await api(`/api/tabs/${encodeURIComponent(tab.id)}/send`, { method: 'POST', body: { text: prompt } });
    return true;
  } catch (err) {
    toastError(err);
    return false;
  }
}
