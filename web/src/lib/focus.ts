import { create } from 'zustand';

// A display layer over the transcript, nothing reaches Claude. Global, like a view setting: one choice for all sessions, kept across restarts. On until turned off.
const KEY = 'claude-os.focus';

export const useFocusMode = create<{ on: boolean }>(() => ({ on: localStorage.getItem(KEY) !== '0' }));

export function setFocusMode(on: boolean) {
  localStorage.setItem(KEY, on ? '1' : '0');
  useFocusMode.setState({ on });
}
