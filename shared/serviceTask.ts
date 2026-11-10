// A small job for the hidden service session: one question or fix, answered in a card and not in a tab.
export type ServiceTaskStatus = 'queued' | 'running' | 'question' | 'done' | 'failed';

export interface ServiceTask {
  id: string;
  title: string;
  project: string | null;
  status: ServiceTaskStatus;
  answer: string | null; // the job's last text
  error: string | null;
  errorKey?: string; // the UI's text for error: errors.<key> with errorParams; rows from before it have the text alone
  errorParams?: Record<string, string | number>;
  questions: string[] | null; // asked once, status 'question' until answered
  modal?: boolean; // shown in a dialog that stays until the job is over or is interrupted, not in a floating card
  link?: string; // the kanban board it fills, for the dialog's way out
  continuable?: false; // the job already opened a tab with the work (quick start): no "continue in a tab"
  created: number;
}
