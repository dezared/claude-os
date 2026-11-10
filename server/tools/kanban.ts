// The task board: one Markdown file per card in vault/kanban, named by its id (OS-21.md), so Obsidian can open, edit and
// hand it on. The frontmatter is the card's fields, the body its description, `rank` its place on the board. Every change is
// a synchronous read-change-rename, so concurrent requests take turns and a crash leaves the previous whole file.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { KANBAN_COLUMNS, type KanbanCard, type KanbanCardSessions, type KanbanColumn, type KanbanLevel, type KanbanPriority, type KanbanSprint } from '../../shared/contract.ts';
import type { Ctx } from '../context.ts';
import { httpError, parseFrontmatter, safely } from '../memory/util.ts';

const MAX_TITLE = 200;
const MAX_DESCRIPTION = 20_000;
const MAX_AGENT = 80;
const MAX_SPRINT = 80;
const MAX_SESSIONS = 20; // the newest stay: a card's file is not a journal
const ENDED_SHOWN = 3;
const PRIORITIES: KanbanPriority[] = ['low', 'normal', 'high'];
const LEVELS: KanbanLevel[] = ['user', 'root'];
const CARD_FILE = /^([A-Z][A-Z0-9]{0,9})-(\d+)\.md$/;
const PREFIX = /^[A-Z][A-Z0-9]{0,9}$/;
const BOARD_FILE = '_board.json'; // prefixes and counters: what no single card knows
export const GENERAL_BOARD = '@general'; // the prefix key of cards with no project
const SPRINT_COUNTER = '@sprint'; // not a prefix: those start with a capital
const GENERAL_PREFIX = 'TASK';
const LAST_RESORT_RANK = 1e12; // a file made by hand has no rank: it stands after the others
const WATCH_DELAY_MS = 300;

export const kanbanDir = (ctx: Pick<Ctx, 'paths'>) => join(ctx.paths.vault, 'kanban');
const legacyFile = (ctx: Pick<Ctx, 'paths'>) => join(ctx.paths.data, 'kanban.json');

interface Stored extends KanbanCard {
  rank: number;
  aliases: string[]; // ids this card had: a mention already sent keeps working
  extra: string; // frontmatter lines this code does not know: tags added in Obsidian survive a move
  unknownSprint?: string; // a sprint id the board does not know: shown as no sprint, kept in the file until a sprint is set
}

interface BoardState {
  prefixes: Record<string, string>; // project key or GENERAL_BOARD
  counters: Record<string, number>; // the last number given, per prefix: a deleted card's id is not given again
  sprints: KanbanSprint[]; // a third dimension over the same columns; a card names one by id
}

const publicCard = ({ rank: _r, aliases: _a, extra: _e, unknownSprint: _u, ...card }: Stored): KanbanCard => card;

// Write the temp file next to the target, hidden from the watcher and from Obsidian, then rename.
function writeAtomic(path: string, text: string): void {
  const slash = path.lastIndexOf('/');
  const tmp = `${path.slice(0, slash + 1)}.${path.slice(slash + 1)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

const KNOWN_KEYS = new Set(['title', 'project', 'priority', 'column', 'rank', 'level', 'agent', 'agent_tab', 'sprint', 'sessions', 'aliases', 'created', 'updated']);

function headOf(text: string): string {
  return /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)?.[1] ?? '';
}

function unknownLines(head: string): string {
  let keep = false;
  return head.split(/\r?\n/).filter((line) => {
    const key = /^([\w-]+):/.exec(line)?.[1];
    if (key) keep = !KNOWN_KEYS.has(key);
    return keep;
  }).join('\n');
}

// As written here (["a"]) or as Obsidian rewrites a list property (one "  - a" per line).
function listOf(head: string, key: string): string[] {
  const lines = head.split(/\r?\n/);
  const at = lines.findIndex((l) => l.startsWith(`${key}:`));
  if (at < 0) return [];
  const inline = lines[at].slice(key.length + 1).trim();
  if (inline) return safely(() => (JSON.parse(inline) as unknown[]).filter((a): a is string => typeof a === 'string'), []);
  const out: string[] = [];
  for (const line of lines.slice(at + 1)) {
    const item = /^\s*-\s*(.+)$/.exec(line);
    if (!item) break;
    out.push(item[1].trim().replace(/^["']|["']$/g, ''));
  }
  return out;
}

const timeOf = (value: string | undefined, fallback: number) => {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isNaN(parsed) ? fallback : parsed;
};

function readCard(dir: string, name: string): Stored {
  const path = join(dir, name);
  const text = readFileSync(path, 'utf8');
  const { data, body } = parseFrontmatter(text);
  const head = headOf(text);
  const id = name.slice(0, -3);
  const mtime = safely(() => statSync(path).mtimeMs, 0);
  const rank = Number(data.rank);
  const firstLine = body.split('\n').map((l) => l.replace(/^#+\s*/, '').trim()).find(Boolean);
  const sessions = listOf(head, 'sessions');
  return {
    id,
    title: data.title || firstLine || id,
    description: body,
    project: data.project || null,
    priority: PRIORITIES.includes(data.priority as KanbanPriority) ? data.priority as KanbanPriority : 'normal',
    column: KANBAN_COLUMNS.includes(data.column as KanbanColumn) ? data.column as KanbanColumn : 'backlog',
    ...(LEVELS.includes(data.level as KanbanLevel) ? { level: data.level as KanbanLevel } : {}),
    ...(data.agent ? { agent: data.agent } : {}),
    ...(data.agent_tab ? { agentTab: data.agent_tab } : {}),
    ...(data.sprint ? { sprint: data.sprint } : {}),
    ...(sessions.length ? { sessions } : {}),
    path,
    created: timeOf(data.created, mtime),
    updated: timeOf(data.updated, mtime),
    rank: head && Number.isFinite(rank) && data.rank ? rank : LAST_RESORT_RANK + Number(CARD_FILE.exec(name)?.[2] ?? 0),
    aliases: listOf(head, 'aliases'),
    extra: unknownLines(head),
  };
}

function cardText(card: Stored): string {
  const meta: Record<string, unknown> = {
    title: card.title,
    project: card.project,
    priority: card.priority,
    column: card.column,
    rank: card.rank,
    level: card.level ?? null,
    agent: card.agent ?? null,
    agent_tab: card.agentTab ?? null,
    sprint: card.sprint ?? card.unknownSprint ?? null,
    sessions: card.sessions?.length ? card.sessions : null,
    aliases: card.aliases.length ? card.aliases : null,
    created: new Date(card.created).toISOString(),
    updated: new Date(card.updated).toISOString(),
  };
  const head = Object.entries(meta).flatMap(([k, v]) => (v === null ? [] : [`${k}: ${JSON.stringify(v)}`]));
  return `---\n${head.join('\n')}${card.extra ? `\n${card.extra}` : ''}\n---\n${card.description}`;
}

function loadCards(dir: string): Stored[] {
  const names = safely(() => readdirSync(dir, { withFileTypes: true }), []).filter((e) => e.isFile() && CARD_FILE.test(e.name)).map((e) => e.name);
  return names.map((name) => readCard(dir, name)).sort((a, b) => a.rank - b.rank || a.created - b.created);
}

function readBoard(dir: string): BoardState {
  let text: string;
  try {
    text = readFileSync(join(dir, BOARD_FILE), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { prefixes: {}, counters: {}, sprints: [] };
    throw err;
  }
  try {
    const parsed = JSON.parse(text) as Partial<BoardState>;
    return { prefixes: parsed.prefixes ?? {}, counters: parsed.counters ?? {}, sprints: Array.isArray(parsed.sprints) ? parsed.sprints : [] };
  } catch {
    // A damaged file is refused, not replaced: the next write would give out ids already taken.
    throw httpError(500, `the board file is damaged: ${join(dir, BOARD_FILE)}`);
  }
}

function writeBoard(dir: string, state: BoardState): void {
  mkdirSync(dir, { recursive: true });
  writeAtomic(join(dir, BOARD_FILE), JSON.stringify(state, null, 1));
}

/** Capitals in a row win (claudeOS: OS), then the first letters of the words (big-web: BW), then the start of the one word. */
export function derivePrefix(name: string, taken: Set<string>): string {
  const words = name.split(/[^A-Za-z0-9]+|(?<=[a-z0-9])(?=[A-Z])/).filter(Boolean);
  const base = (/[A-Z]{2,}/.exec(name)?.[0] ?? (words.length > 1 ? words.map((w) => w[0]).join('') : (words[0] ?? '').slice(0, 3))).toUpperCase().slice(0, 6);
  const clean = /^[A-Z]/.test(base) ? base : `P${base}`;
  if (!taken.has(clean)) return clean;
  for (let n = 2; ; n++) if (!taken.has(`${clean}${n}`)) return `${clean}${n}`;
}

function column(value: unknown): KanbanColumn {
  if (!KANBAN_COLUMNS.includes(value as KanbanColumn)) throw httpError(400, `column is one of ${KANBAN_COLUMNS.join(', ')}`);
  return value as KanbanColumn;
}

function title(value: unknown): string {
  const clean = typeof value === 'string' ? value.trim() : '';
  if (!clean || clean.length > MAX_TITLE) throw httpError(400, `a title is text, up to ${MAX_TITLE} characters`);
  return clean;
}

function description(value: unknown): string {
  if (typeof value !== 'string' || value.length > MAX_DESCRIPTION) throw httpError(400, `a description is text, up to ${MAX_DESCRIPTION} characters`);
  return value;
}

function priority(value: unknown): KanbanPriority {
  if (!PRIORITIES.includes(value as KanbanPriority)) throw httpError(400, `priority is one of ${PRIORITIES.join(', ')}`);
  return value as KanbanPriority;
}

function sprintName(value: unknown): string {
  const clean = typeof value === 'string' ? value.trim() : '';
  if (!clean || clean.length > MAX_SPRINT) throw httpError(400, `a sprint name is text, up to ${MAX_SPRINT} characters`);
  return clean;
}

function agentName(value: unknown): string {
  const clean = typeof value === 'string' ? value.trim() : '';
  if (!clean || clean.length > MAX_AGENT) throw httpError(400, `an agent is a name, up to ${MAX_AGENT} characters`);
  return clean;
}

export interface CardInput { title?: unknown; description?: unknown; project?: unknown; priority?: unknown; column?: unknown; level?: unknown; agent?: unknown; agentTab?: unknown; sprint?: unknown; }
export interface KanbanProject { key: string; name?: string; }
// sessionOf: the session a tab runs now, so a card taken in it knows that session from the start.
export interface KanbanOptions { osProject?: () => string | null; legacy?: string; sessionOf?: (tab: string) => string | null; }

export function createKanban(dir: string, projects: () => KanbanProject[], options: KanbanOptions = {}) {
  const osProject = options.osProject ?? (() => null);
  const project = (value: unknown): string | null => {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value !== 'string' || !projects().some((p) => p.key === value)) throw httpError(400, `no project ${String(value)}`);
    return value;
  };
  // A level means something only in Claude OS. null takes it away; a card leaving that project loses it, see update.
  const setLevel = (card: Stored, value: unknown) => {
    if (value === null) {
      delete card.level;
      return;
    }
    if (!LEVELS.includes(value as KanbanLevel)) throw httpError(400, `level is one of ${LEVELS.join(', ')}`);
    if (card.project === null || card.project !== osProject()) throw httpError(400, 'a level is only for cards of the Claude OS project');
    card.level = value as KanbanLevel;
  };
  const setAgent = (card: Stored, agent: unknown, tab: unknown) => {
    delete card.agent;
    delete card.agentTab;
    if (agent === null) return;
    card.agent = agentName(agent);
    if (typeof tab === 'string' && tab) card.agentTab = tab;
  };
  // null or "" takes the sprint away; an id must be one of the board's.
  const setSprint = (card: Stored, value: unknown) => {
    delete card.unknownSprint;
    if (value === null || value === '') {
      delete card.sprint;
      return;
    }
    if (typeof value !== 'string' || !readBoard(dir).sprints.some((s) => s.id === value)) throw httpError(400, `no sprint ${String(value)}`);
    card.sprint = value;
  };
  const addSession = (card: Stored, session: string | null | undefined): boolean => {
    if (!session || card.sessions?.includes(session)) return false;
    card.sessions = [...(card.sessions ?? []), session].slice(-MAX_SESSIONS);
    return true;
  };
  const write = (card: Stored) => {
    mkdirSync(dir, { recursive: true });
    writeAtomic(card.path, cardText(card));
  };
  // A sprint the board does not know, an Obsidian edit or a removed one, is no sprint: the card stays on the board, its file keeps the id.
  const load = (): Stored[] => {
    migrate();
    const cards = loadCards(dir);
    const known = new Set(readBoard(dir).sprints.map((s) => s.id));
    for (const card of cards) {
      if (!card.sprint || known.has(card.sprint)) continue;
      card.unknownSprint = card.sprint;
      delete card.sprint;
    }
    return cards;
  };
  const find = (cards: Stored[], id: unknown): Stored => {
    const wanted = String(id).toUpperCase();
    const card = cards.find((c) => c.id === wanted) ?? cards.find((c) => c.aliases.includes(String(id)) || c.aliases.includes(wanted));
    if (!card) throw httpError(404, `no card ${String(id)}`);
    return card;
  };

  // Assigned once and kept: the project's name may change later, its ids do not follow.
  const prefixOf = (state: BoardState, key: string | null): string => {
    const slot = key ?? GENERAL_BOARD;
    if (state.prefixes[slot]) return state.prefixes[slot];
    const name = projects().find((p) => p.key === key)?.name ?? key;
    const prefix = key === null ? GENERAL_PREFIX : derivePrefix(name ?? '', new Set(Object.values(state.prefixes)));
    state.prefixes[slot] = prefix;
    return prefix;
  };
  const numbersOf = (cards: Stored[], prefix: string) => cards.flatMap((c) => {
    const m = CARD_FILE.exec(`${c.id}.md`);
    return m && m[1] === prefix ? [Number(m[2])] : [];
  });
  const nextId = (state: BoardState, cards: Stored[], key: string | null): string => {
    const prefix = prefixOf(state, key);
    const number = Math.max(state.counters[prefix] ?? 0, ...numbersOf(cards, prefix)) + 1;
    state.counters[prefix] = number;
    return `${prefix}-${number}`;
  };

  // Between neighbours, so only the moved card's file changes. When doubles run out of room, everyone gets a whole number again.
  const placeAt = (cards: Stored[], at: number, card: Stored) => {
    const prev = cards[at - 1]?.rank;
    const next = cards[at]?.rank;
    if (prev === undefined) card.rank = next === undefined ? 1 : next - 1;
    else if (next === undefined) card.rank = prev + 1;
    else if (next - prev > 1e-6) card.rank = (prev + next) / 2;
    else {
      cards.splice(at, 0, card);
      cards.forEach((c, i) => {
        c.rank = i + 1;
        if (c !== card) write(c);
      });
      cards.splice(at, 1);
    }
  };

  // The old data/kanban.json, one file per card, in its order. A crash halfway resumes: a card already out is known by its alias.
  const migrate = () => {
    const legacy = options.legacy;
    if (!legacy || !existsSync(legacy)) return;
    let old: Partial<KanbanCard>[];
    try {
      const parsed = JSON.parse(readFileSync(legacy, 'utf8')) as { cards?: unknown };
      if (!Array.isArray(parsed.cards)) throw new Error('no cards');
      old = parsed.cards as Partial<KanbanCard>[];
    } catch {
      throw httpError(500, `the board file is damaged: ${legacy}`);
    }
    const state = readBoard(dir);
    const cards = loadCards(dir);
    old.forEach((c, i) => {
      if (cards.some((x) => x.aliases.includes(String(c.id)))) return;
      const id = nextId(state, cards, c.project ?? null);
      const card: Stored = {
        id,
        title: c.title ?? id,
        description: c.description ?? '',
        project: c.project ?? null,
        priority: c.priority ?? 'normal',
        column: c.column ?? 'todo',
        ...(c.level ? { level: c.level } : {}),
        path: join(dir, `${id}.md`),
        created: c.created ?? Date.now(),
        updated: c.updated ?? Date.now(),
        rank: i + 1,
        aliases: [String(c.id)],
        extra: '',
      };
      write(card);
      writeBoard(dir, state);
      cards.push(card);
    });
    writeBoard(dir, state);
    renameSync(legacy, `${legacy}.migrated`);
  };

  const rekey = (card: Stored, id: string) => {
    const old = card.path;
    if (!card.aliases.includes(card.id)) card.aliases = [...card.aliases, card.id];
    card.id = id;
    card.path = join(dir, `${id}.md`);
    write(card);
    rmSync(old);
  };

  return {
    list: (): KanbanCard[] => load().map(publicCard),
    /** Each project's prefix: the one it has, or the one it would get. Nothing is saved by looking. */
    prefixes(): Record<string, string> {
      migrate();
      const state = readBoard(dir);
      const out = { ...state.prefixes };
      out[GENERAL_BOARD] ??= GENERAL_PREFIX;
      const taken = new Set(Object.values(out));
      for (const p of projects()) {
        if (out[p.key]) continue;
        out[p.key] = derivePrefix(p.name ?? p.key, taken);
        taken.add(out[p.key]);
      }
      return out;
    },
    /** Every card of the project takes the new prefix and keeps its number; its old id stays as an alias. */
    setPrefix(key: unknown, value: unknown): string {
      const clean = typeof value === 'string' ? value.trim().toUpperCase() : '';
      if (!PREFIX.test(clean)) throw httpError(400, 'a prefix is a Latin capital, then capitals or digits, up to 10');
      const owner = project(key);
      const cards = load();
      const state = readBoard(dir);
      const current = prefixOf(state, owner);
      if (current === clean) {
        writeBoard(dir, state);
        return clean;
      }
      const slot = owner ?? GENERAL_BOARD;
      const usedElsewhere = Object.entries(state.prefixes).some(([k, p]) => k !== slot && p === clean) || cards.some((c) => c.project !== owner && c.id.startsWith(`${clean}-`));
      if (usedElsewhere) throw httpError(409, `the prefix ${clean} is already taken`);
      state.prefixes[slot] = clean;
      state.counters[clean] = Math.max(state.counters[clean] ?? 0, state.counters[current] ?? 0);
      for (const card of cards.filter((c) => c.project === owner)) {
        const number = Number(card.id.slice(card.id.lastIndexOf('-') + 1));
        const free = !existsSync(join(dir, `${clean}-${number}.md`));
        rekey(card, free ? `${clean}-${number}` : nextId(state, cards, owner));
      }
      writeBoard(dir, state);
      return clean;
    },
    add(input: CardInput): KanbanCard {
      const now = Date.now();
      const owner = project(input.project);
      const cleanTitle = title(input.title);
      const cleanDescription = input.description === undefined ? '' : description(input.description);
      const cleanPriority = input.priority === undefined ? 'normal' : priority(input.priority);
      const cleanColumn = input.column === undefined ? 'backlog' : column(input.column);
      const cards = load();
      const state = readBoard(dir);
      const card: Stored = { id: '', title: cleanTitle, description: cleanDescription, project: owner, priority: cleanPriority, column: cleanColumn, path: '', created: now, updated: now, rank: (cards.at(-1)?.rank ?? 0) + 1, aliases: [], extra: '' };
      if (input.level !== undefined) setLevel(card, input.level);
      if (input.agent !== undefined) setAgent(card, input.agent, input.agentTab);
      if (input.sprint !== undefined) setSprint(card, input.sprint);
      card.id = nextId(state, cards, owner);
      card.path = join(dir, `${card.id}.md`);
      write(card);
      writeBoard(dir, state);
      return publicCard(card);
    },
    update(id: unknown, input: CardInput): KanbanCard {
      const cards = load();
      const card = { ...find(cards, id), updated: Date.now() };
      if (input.title !== undefined) card.title = title(input.title);
      if (input.description !== undefined) card.description = description(input.description);
      const movedProject = input.project !== undefined && project(input.project) !== card.project;
      if (input.project !== undefined) {
        card.project = project(input.project);
        if (card.project === null || card.project !== osProject()) delete card.level;
      }
      if (input.priority !== undefined) card.priority = priority(input.priority);
      if (input.level !== undefined) setLevel(card, input.level);
      if (input.agent !== undefined) setAgent(card, input.agent, input.agentTab);
      if (input.sprint !== undefined) setSprint(card, input.sprint);
      if (movedProject) {
        const state = readBoard(dir);
        rekey(card, nextId(state, cards, card.project));
        writeBoard(dir, state);
      } else write(card);
      return publicCard(card);
    },
    // Before another card of the column, or at its end: a position that means the same on a filtered board.
    // Back in the queue nobody is working on it, so the agent's mark goes unless a new one is given.
    move(id: unknown, to: unknown, before?: unknown, agent?: unknown, agentTab?: unknown, sprint?: unknown): KanbanCard {
      const target = column(to);
      const cards = load();
      const found = find(cards, id);
      cards.splice(cards.indexOf(found), 1);
      const moved = { ...found, column: target, updated: Date.now() };
      if (sprint !== undefined) setSprint(moved, sprint);
      if (agent !== undefined) {
        setAgent(moved, agent, agentTab);
        if (moved.agentTab) addSession(moved, options.sessionOf?.(moved.agentTab));
      } else if (target === 'backlog' || target === 'todo') setAgent(moved, null, null);
      let at: number;
      if (before === null || before === undefined) {
        at = cards.findLastIndex((c) => c.column === target) + 1 || cards.length;
      } else {
        const other = find(cards, before);
        if (other.column !== target) throw httpError(400, 'the card to stand before is in another column');
        at = cards.indexOf(other);
      }
      placeAt(cards, at, moved);
      write(moved);
      return publicCard(moved);
    },
    /** An agent takes the task: its name goes on the card, and a task still waiting goes to "doing". */
    take(id: unknown, agent: unknown, agentTab?: unknown): KanbanCard {
      const name = agentName(agent);
      const card = find(load(), id);
      if (card.column === 'backlog' || card.column === 'todo') return this.move(card.id, 'doing', null, name, agentTab);
      setAgent(card, name, agentTab);
      if (card.agentTab) addSession(card, options.sessionOf?.(card.agentTab));
      card.updated = Date.now();
      write(card);
      return publicCard(card);
    },
    get: (id: unknown): KanbanCard => publicCard(find(load(), id)),
    /** A tab got a session: every card it took remembers it. False: nothing changed. */
    recordSession(tabId: string, sessionId: string): boolean {
      let changed = false;
      // A finished card is history: a tab that goes on to other work does not add to it.
      for (const card of load().filter((c) => c.agentTab === tabId && (c.column === 'doing' || c.column === 'polish'))) {
        if (!addSession(card, sessionId)) continue;
        write(card);
        changed = true;
      }
      return changed;
    },
    sprints: (): KanbanSprint[] => readBoard(dir).sprints,
    addSprint(name: unknown): KanbanSprint {
      const clean = sprintName(name);
      const state = readBoard(dir);
      const number = Math.max(state.counters[SPRINT_COUNTER] ?? 0, ...state.sprints.map((s) => Number(/^S(\d+)$/.exec(s.id)?.[1] ?? 0))) + 1;
      state.counters[SPRINT_COUNTER] = number;
      const sprint = { id: `S${number}`, name: clean };
      state.sprints.push(sprint);
      writeBoard(dir, state);
      return sprint;
    },
    updateSprint(id: unknown, name: unknown): KanbanSprint {
      const clean = sprintName(name);
      const state = readBoard(dir);
      const sprint = state.sprints.find((s) => s.id === id);
      if (!sprint) throw httpError(404, `no sprint ${String(id)}`);
      sprint.name = clean;
      writeBoard(dir, state);
      return sprint;
    },
    /** Its cards stay where they are, with no sprint. */
    removeSprint(id: unknown): void {
      const cards = loadCards(dir);
      const state = readBoard(dir);
      if (!state.sprints.some((s) => s.id === id)) throw httpError(404, `no sprint ${String(id)}`);
      state.sprints = state.sprints.filter((s) => s.id !== id);
      writeBoard(dir, state);
      for (const card of cards.filter((c) => c.sprint === id)) {
        delete card.sprint;
        write(card);
      }
    },
    // Deleting moves the file aside, as the planner does: a card's text may exist nowhere else.
    remove(id: unknown): void {
      const card = find(load(), id);
      const trash = join(dir, '.trash');
      mkdirSync(trash, { recursive: true });
      renameSync(card.path, join(trash, `${card.id}.md`));
    },
  };
}

const osProjectOf = (ctx: Pick<Ctx, 'paths' | 'journal'>) => safely(() => ctx.journal.projectForCwd(ctx.paths.repo), null);

const tabSession = (ctx: Pick<Ctx, 'chat'>, tab: string) => ctx.chat?.list().find((t) => t.id === tab)?.sessionId ?? null;

export const kanbanFor = (ctx: Pick<Ctx, 'paths' | 'journal' | 'chat'>) => createKanban(kanbanDir(ctx), () => ctx.journal.listProjects(true), { osProject: () => osProjectOf(ctx), legacy: legacyFile(ctx), sessionOf: (tab) => tabSession(ctx, tab) });

/** Called when a tab gets its session id. Never throws: a broken board must not stop a chat. */
export function recordCardSession(ctx: Pick<Ctx, 'paths' | 'journal' | 'chat' | 'invalidate'>, tabId: string, sessionId: string): void {
  if (safely(() => kanbanFor(ctx).recordSession(tabId, sessionId), false)) ctx.invalidate('kanban');
}

// The tab working on the card now, and the last sessions it had that run nowhere.
export function cardSessions(ctx: Pick<Ctx, 'paths' | 'journal' | 'chat'>, id: string): KanbanCardSessions {
  const card = kanbanFor(ctx).get(id);
  const ids = card.sessions ?? [];
  const tabs = ctx.chat?.list() ?? [];
  const live = tabs.find((t) => t.id === card.agentTab) ?? tabs.find((t) => t.sessionId !== null && ids.includes(t.sessionId)) ?? null;
  const ended = ctx.journal.listSessions()
    .filter((s) => ids.includes(s.id) && s.id !== live?.sessionId)
    .sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0))
    .slice(0, ENDED_SHOWN);
  return { live, ended };
}

export function registerKanban(ctx: Ctx): void {
  const { app } = ctx;
  const board = kanbanFor(ctx);
  const dir = kanbanDir(ctx);
  const changed = <T>(value: T) => {
    ctx.invalidate('kanban');
    startWatching();
    return value;
  };
  // Obsidian writes these files too. Started when the folder exists: looking at the board must not create the vault.
  let watcher: FSWatcher | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  function startWatching() {
    if (watcher || !existsSync(dir)) return;
    watcher = watch(dir, (_event, name) => {
      if (name?.startsWith('.')) return; // temp files and the trash
      timer ??= setTimeout(() => {
        timer = null;
        ctx.invalidate('kanban');
      }, WATCH_DELAY_MS);
      timer.unref();
    });
    watcher.on('error', () => {
      watcher?.close();
      watcher = null; // the folder went away: the next look at the board starts again
    });
  }
  app.addHook('onClose', async () => {
    if (timer) clearTimeout(timer);
    watcher?.close();
  });
  app.get('/api/kanban', async () => {
    const cards = board.list();
    startWatching();
    return { path: dir, cards, osProject: osProjectOf(ctx), prefixes: board.prefixes(), sprints: board.sprints() };
  });
  app.post<{ Body: CardInput }>('/api/kanban/cards', async (req) => changed(board.add(req.body ?? {})));
  app.patch<{ Params: { id: string }; Body: CardInput }>('/api/kanban/cards/:id', async (req) => changed(board.update(req.params.id, req.body ?? {})));
  app.post<{ Params: { id: string }; Body: { column?: unknown; before?: unknown; sprint?: unknown } }>('/api/kanban/cards/:id/move', async (req) => changed(board.move(req.params.id, req.body?.column, req.body?.before, undefined, undefined, req.body?.sprint)));
  app.get<{ Params: { id: string } }>('/api/kanban/cards/:id/sessions', async (req) => cardSessions(ctx, req.params.id));
  app.post<{ Params: { id: string }; Body: { agent?: unknown; tab?: unknown } }>('/api/kanban/cards/:id/take', async (req) => changed(board.take(req.params.id, req.body?.agent, req.body?.tab)));
  app.put<{ Body: { project?: unknown; prefix?: unknown } }>('/api/kanban/prefix', async (req) => {
    const prefix = board.setPrefix(req.body?.project ?? null, req.body?.prefix);
    ctx.audit('kanban.prefix', String(req.body?.project ?? GENERAL_BOARD), prefix);
    return changed({ prefix, prefixes: board.prefixes() });
  });
  app.get('/api/kanban/sprints', async () => board.sprints());
  app.post<{ Body: { name?: unknown } }>('/api/kanban/sprints', async (req) => changed(board.addSprint(req.body?.name)));
  app.patch<{ Params: { id: string }; Body: { name?: unknown } }>('/api/kanban/sprints/:id', async (req) => changed(board.updateSprint(req.params.id, req.body?.name)));
  app.delete<{ Params: { id: string } }>('/api/kanban/sprints/:id', async (req) => {
    board.removeSprint(req.params.id);
    ctx.audit('kanban.sprint.delete', req.params.id);
    return changed({ ok: true });
  });
  app.delete<{ Params: { id: string } }>('/api/kanban/cards/:id', async (req) => {
    board.remove(req.params.id);
    ctx.audit('kanban.delete', req.params.id);
    return changed({ ok: true });
  });
}
