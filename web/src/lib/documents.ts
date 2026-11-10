import type { LucideIcon } from 'lucide-react';
import { BookOpen, ClipboardList, File, FileText, LayoutDashboard } from 'lucide-react';
import { DOCUMENT_CSP } from '../../../shared/documents.ts';
import { api, setCached } from './api';
import type { Key } from './i18n';
import { toastError, useApp } from './store';
import type { DocumentKind, Tab } from './types';

export const KIND_LABEL: Record<DocumentKind, Key> = { report: 'documents.kindReport', documentation: 'documents.kindDocumentation', plan: 'documents.kindPlan', dashboard: 'documents.kindDashboard', other: 'documents.kindOther' };
export const KIND_ICON: Record<DocumentKind, LucideIcon> = { report: FileText, documentation: BookOpen, plan: ClipboardList, dashboard: LayoutDashboard, other: File };

/** Its one tab, opened or found by the server: a link from any chat and a card in the library end up here. */
export async function openDocument(id: string): Promise<Tab | null> {
  try {
    const tab = await api<Tab>(`/api/documents/${encodeURIComponent(id)}/tab`, { method: 'POST' });
    setCached<Tab[]>('/api/tabs', (old) => [...(old ?? []).filter((x) => x.id !== tab.id), tab]);
    useApp.getState().go({ kind: 'tab', id: tab.id });
    return tab;
  } catch (err) {
    toastError(err);
    return null;
  }
}

const REMOVED = 'script, base, iframe, frame, frameset, object, embed, form, meta[http-equiv]';
const SAFE_LINK = /^(https?:|mailto:)/i;

/**
 * What goes into the frame. Isolation comes from the frame's sandbox and this policy, not from here: a script left in
 * would not run. Cleaning only stops what would misbehave: a redirect, a form, a link that would open inside the frame.
 */
export function prepareDocument(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll(REMOVED).forEach((el) => el.remove());
  for (const el of doc.querySelectorAll('*')) {
    for (const { name } of [...el.attributes]) if (name.toLowerCase().startsWith('on')) el.removeAttribute(name);
  }
  for (const a of doc.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href') ?? '';
    if (href.startsWith('#')) continue;
    if (!SAFE_LINK.test(href)) {
      a.removeAttribute('href');
      continue;
    }
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer');
  }
  const csp = doc.createElement('meta');
  csp.httpEquiv = 'Content-Security-Policy';
  csp.content = DOCUMENT_CSP;
  doc.head.prepend(csp);
  return `<!doctype html>${doc.documentElement.outerHTML}`;
}

/** The frame's rules: no scripts, no origin of the app. Popups only so that a link can leave for the real browser. */
export const DOCUMENT_SANDBOX = 'allow-popups allow-popups-to-escape-sandbox';
