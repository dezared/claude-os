// How a card's fields change from outside: one place for the board's routes and the agents' tools.
import { forgetWritten, readBoard, type Stored } from './cardFile.ts';
import { httpError } from './fail.ts';
import { project, type Board } from './store.ts';
import { LEVELS, defaultBoard, type Level } from './types.ts';
import * as check from './validate.ts';

const MAX_SESSIONS = 20; // the newest stay: a card's file is not a journal

export interface CardInput {
  title?: unknown; description?: unknown; project?: unknown; type?: unknown; priority?: unknown; column?: unknown;
  labels?: unknown; estimate?: unknown; assignee?: unknown; level?: unknown; agent?: unknown; agentTab?: unknown; board?: unknown;
}

// A level means something only in Claude OS. null takes it away; a card leaving that project loses it, see applyFields.
export function setLevel(b: Board, card: Stored, value: unknown): void {
  if (value === null) {
    delete card.level;
    return;
  }
  if (!LEVELS.includes(value as Level)) throw httpError(400, `level is one of ${LEVELS.join(', ')}`);
  if (card.project === null || card.project !== b.osProject?.()) throw httpError(400, 'a level is only for cards of the Claude OS project');
  card.level = value as Level;
}

/** An agent's mark: who took it, from which tab. It replaces the user as the assignee. */
export function setAgent(card: Stored, agent: unknown, tab: unknown): void {
  delete card.agent;
  delete card.agentTab;
  if (agent === null) return;
  card.agent = check.agentName(agent);
  delete card.assignee;
  forgetWritten(card, 'assignee');
  if (typeof tab === 'string' && tab) card.agentTab = tab;
}

/** "user": the user took it, and an agent's mark goes; null: nobody. */
export function setAssignee(card: Stored, value: unknown): void {
  if (value !== null && value !== 'user') throw httpError(400, 'assignee is "user" or null');
  delete card.agent;
  delete card.agentTab;
  forgetWritten(card, 'assignee');
  if (value === 'user') card.assignee = 'user';
  else delete card.assignee;
}

// null or "" puts the card on the default board of its type; an id must be one of the board file's.
export function setBoard(b: Board, card: Stored, value: unknown): void {
  delete card.unknownBoard;
  if (value === null || value === '') {
    card.board = defaultBoard(card.type);
    return;
  }
  if (typeof value !== 'string' || !readBoard(b.dir).boards.some((x) => x.id === value)) throw httpError(400, `no board ${String(value)}`);
  card.board = value;
}

export function addSession(card: Stored, session: string | null | undefined): boolean {
  if (!session || card.sessions?.includes(session)) return false;
  card.sessions = [...(card.sessions ?? []), session].slice(-MAX_SESSIONS);
  return true;
}

const PLAIN = {
  title: (c: Stored, v: unknown) => { c.title = check.title(v); },
  description: (c: Stored, v: unknown) => { c.description = check.description(v); },
  type: (c: Stored, v: unknown) => {
    c.type = check.cardType(v);
    forgetWritten(c, 'type');
  },
  priority: (c: Stored, v: unknown) => { c.priority = check.priority(v); },
  labels: (c: Stored, v: unknown) => {
    c.labels = check.labels(v);
    forgetWritten(c, 'labels');
  },
  estimate: (c: Stored, v: unknown) => {
    const points = check.estimate(v);
    forgetWritten(c, 'estimate');
    if (points === undefined) delete c.estimate;
    else c.estimate = points;
  },
} satisfies Partial<Record<keyof CardInput, (c: Stored, v: unknown) => void>>;

function setProject(b: Board, card: Stored, value: unknown): void {
  card.project = project(b, value);
  if (card.project === null || card.project !== b.osProject?.()) delete card.level;
}

/** Sets what the input names, in an order where the project comes before the level. Answers the names of what was given. */
export function applyFields(b: Board, card: Stored, input: CardInput): string[] {
  const given = (Object.keys(input) as (keyof CardInput)[]).filter((k) => input[k] !== undefined && k !== 'agentTab' && k !== 'column');
  for (const [key, set] of Object.entries(PLAIN)) if (input[key as keyof CardInput] !== undefined) set(card, input[key as keyof CardInput]);
  if (input.project !== undefined) setProject(b, card, input.project);
  if (input.level !== undefined) setLevel(b, card, input.level);
  if (input.assignee !== undefined) setAssignee(card, input.assignee);
  if (input.agent !== undefined) setAgent(card, input.agent, input.agentTab);
  if (input.board !== undefined) setBoard(b, card, input.board);
  return given;
}
