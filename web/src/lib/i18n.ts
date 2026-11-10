import { create } from 'zustand';
import { strings as ru } from './locales/ru';

// A language is one file in ./locales exporting `label` and `strings`: nothing else has to change to add it.
const modules = import.meta.glob<{ label: string; strings: Partial<Record<Key, string>> }>('./locales/*.ts', { eager: true });

export type Key = keyof typeof ru;
type PluralBase<K = Key> = K extends `${infer B}.one` ? B : never;

const dictionaries = Object.fromEntries(
  Object.entries(modules).map(([path, mod]) => [path.replace(/^.*\/|\.ts$/g, ''), mod]),
);

export const languages = Object.entries(dictionaries)
  .map(([code, mod]) => ({ code, label: mod.label }))
  .sort((a, b) => a.code.localeCompare(b.code));

// Before the profile exists, the choice made here; after, a copy of the profile's for the first paint.
const STORAGE_KEY = 'claude-os.lang';

function initialLang(): string {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved && dictionaries[saved]) return saved;
  const browser = navigator.language.split('-')[0].toLowerCase();
  return dictionaries[browser] ? browser : 'en';
}

let current = initialLang();
document.documentElement.lang = current;

/** The app remounts on change, so plain t() calls in components need no subscription. */
export const useLang = create<{ lang: string }>(() => ({ lang: current }));

export function setLang(code: string) {
  if (!dictionaries[code]) return;
  current = code;
  localStorage.setItem(STORAGE_KEY, code);
  document.documentElement.lang = code;
  useLang.setState({ lang: code });
}

/** profile.language is the UI language too: its catalog, or en without one. Null (no profile yet) keeps the stored choice. */
export function applyProfileLanguage(profileLang: string | null): void {
  if (profileLang !== null) setLang(dictionaries[profileLang] ? profileLang : 'en');
}

export function locale(): string {
  return current;
}

export function t(key: Key, params?: Record<string, string | number>): string {
  const text = dictionaries[current]?.strings[key] ?? ru[key] ?? key;
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? String(params[name]) : m));
}

export function has(key: string): key is Key {
  return key in ru;
}

/** A message of the server: the catalog's text for its key, its own text when the catalog has none. */
export function serverText(text: string, key?: string, params?: Record<string, string | number>): string {
  const k = key && `errors.${key}`;
  return k && has(k) ? t(k, params) : text;
}

/** The word for a count: ru has one/few/many, en one/other. Missing forms fall back to `.other`. */
export function tn(base: PluralBase, n: number): string {
  const rule = new Intl.PluralRules(current).select(n);
  const strings = dictionaries[current]?.strings as Record<string, string | undefined>;
  return strings?.[`${base}.${rule}`] ?? strings?.[`${base}.other`] ?? (ru as Record<string, string>)[`${base}.other`];
}
