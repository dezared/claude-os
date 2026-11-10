import { create } from 'zustand';

// How wide the chat column is. A view setting like focus: one choice for all sessions, kept across restarts.
const KEY = 'claude-os.chatWidth';

export const CHAT_WIDTHS = ['default', 'large', 'full'] as const;
export type ChatWidth = (typeof CHAT_WIDTHS)[number];

const CLASS: Record<ChatWidth, string> = { default: 'max-w-180', large: 'max-w-300', full: 'max-w-none' };

const saved = localStorage.getItem(KEY);
export const useChatWidth = create<{ width: ChatWidth }>(() => ({ width: CHAT_WIDTHS.find((w) => w === saved) ?? 'default' }));

export function setChatWidth(width: ChatWidth) {
  localStorage.setItem(KEY, width);
  useChatWidth.setState({ width });
}

export const nextChatWidth = (width: ChatWidth): ChatWidth => CHAT_WIDTHS[(CHAT_WIDTHS.indexOf(width) + 1) % CHAT_WIDTHS.length];

/** The max-width class of every part of the chat column: transcript, composer, the strips above it. */
export const useChatWidthClass = () => CLASS[useChatWidth((s) => s.width)];
