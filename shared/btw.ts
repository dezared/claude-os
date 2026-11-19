// The /btw side question: its stream and the thread a follow-up carries.
import type { MessageKey } from './contract.ts';

export type BtwEvent = { text: string } | ({ done: true; error: string | null } & MessageKey);
// A side question with the thread so far: the earlier questions and their answers, oldest first.
export interface BtwTurn { question: string; answer: string }
export interface BtwRequest { question: string; history?: BtwTurn[] }
