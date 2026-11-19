import { create } from 'zustand';

/** The interface themes; the sky on Home stays dark in both. */
export const THEMES = ['dark', 'light'] as const;
export type Theme = (typeof THEMES)[number];
/** What the person picks: a theme, or the one the system uses, followed as it changes. */
export type ThemeChoice = Theme | 'system';

// A choice of this window's browser profile, like the language before a profile exists: the server does not keep it.
const STORAGE_KEY = 'claude-os.theme';
const systemLight = matchMedia('(prefers-color-scheme: light)');

function stored(): ThemeChoice {
  const v = localStorage.getItem(STORAGE_KEY);
  return v === 'light' || v === 'system' ? v : 'dark';
}

const resolve = (choice: ThemeChoice): Theme => (choice === 'system' ? (systemLight.matches ? 'light' : 'dark') : choice);

// index.html sets the same attribute before the first paint, so the page does not flash dark.
function apply(choice: ThemeChoice) {
  const theme = resolve(choice);
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  useTheme.setState({ choice, theme });
}

export const useTheme = create<{ choice: ThemeChoice; theme: Theme }>(() => ({ choice: 'dark', theme: 'dark' }));
apply(stored());

export function setTheme(choice: ThemeChoice) {
  localStorage.setItem(STORAGE_KEY, choice);
  apply(choice);
}

// A popout window shares the storage: it follows a change made in the main window.
window.addEventListener('storage', (e) => {
  if (e.key === STORAGE_KEY) apply(stored());
});
systemLight.addEventListener('change', () => {
  if (useTheme.getState().choice === 'system') apply('system');
});
