import { create } from 'zustand';

// In-memory drafts of unanswered request cards, so a half-filled answer survives the card unmounting on a tab switch. Gone on reload.
const useDrafts = create<Record<string, unknown>>(() => ({}));

export function useDraft<T>(key: string, initial: T): [T, (v: T) => void] {
  const value = useDrafts((s) => s[key]) as T | undefined;
  return [value === undefined ? initial : value, (v) => useDrafts.setState({ [key]: v })];
}

export function clearDraft(key: string) {
  useDrafts.setState((s) => {
    const { [key]: _, ...rest } = s;
    return rest;
  }, true);
}
