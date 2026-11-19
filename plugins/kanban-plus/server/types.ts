// What the board is made of. The interface (ui/*.js) reads the same shapes from the routes.

export const COLUMNS = ['backlog', 'todo', 'doing', 'polish', 'done'] as const; // in the order of the board
export type Column = (typeof COLUMNS)[number];
export const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type Priority = (typeof PRIORITIES)[number];
export const TYPES = ['task', 'bug', 'story', 'epic', 'chore'] as const;
export type CardType = (typeof TYPES)[number];
export const LEVELS = ['user', 'root'] as const; // what a Claude OS task changes: config/, or the core
export type Level = (typeof LEVELS)[number];
// The boards every install has; a card with no board goes onto one of them by its type. Their names are the interface's words.
export const EPICS = 'epics';
export const TASKS = 'tasks';
export const DEFAULT_BOARDS = [EPICS, TASKS] as const;

// Fields a person may write by hand in Obsidian in a form the board does not read, see cardFile.ts.
export type WrittenKey = 'type' | 'assignee' | 'labels' | 'estimate';

export interface Card {
  id: string; // like OS-21: the board's prefix and a number, and the name of the card's file
  path: string; // the card's .md file in the vault: can be edited directly and mentioned with @
  title: string;
  description: string;
  project: string | null; // a project key; null: the general board
  type: CardType;
  priority: Priority;
  column: Column;
  labels: string[];
  estimate?: number; // story points
  assignee?: 'user'; // the user took it; an agent's mark is `agent`
  agent?: string; // the agent that took it
  agentTab?: string; // the tab it works in, when it is one
  level?: Level; // only on cards of the Claude OS project
  board: string; // KanbanBoard.id; absent in the file, or an id no board has: the default board of its type
  sessions?: string[]; // sessions of the tabs that took it, oldest first, the last 20
  asWritten?: Partial<Record<WrittenKey, string>>; // a value in the file the board does not understand, shown as it is
  comments: number;
  created: number;
  updated: number;
}

/** A list of cards with the five columns. Cards of every project may be on it; the project is a filter. */
export interface KanbanBoard {
  id: string; // EPICS, TASKS, B3 for a board made later, S1 for one that was a sprint before boards
  name?: string; // absent on a default board that was never renamed: the interface names it in the user's language
  project?: string; // a board made for one project: a new card on it gets that project
  goal?: string;
}

/** The default board of a card that names none. */
export const defaultBoard = (type: CardType): string => (type === 'epic' ? EPICS : TASKS);

// 'sprint' is only in logs written before boards replaced sprints.
export const ACTIVITY_KINDS = ['created', 'moved', 'taken', 'released', 'edited', 'board', 'sprint', 'comment'] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

/** One line of a card's log. A comment is a log line with text. */
export interface Activity {
  id: string;
  at: number;
  kind: ActivityKind;
  by: string; // 'user' or an agent's name
  tab?: string;
  session?: string;
  from?: string;
  to?: string;
  fields?: string[];
  text?: string;
}

/** Who makes a change: the user in the interface, or an agent through a tool, from a tab. */
export interface Actor { by: string; tab?: string | null; session?: string | null }

export const GENERAL_BOARD = '@general'; // the prefix key of cards with no project, in _board.json
