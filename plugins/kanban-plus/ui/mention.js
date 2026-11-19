// The board's section of the composer's @ menu: a card goes into the text as the path of its file.
import { BOARD_URL } from './data.js';

const MAX_ITEMS = 30;
const COLUMN_ORDER = { doing: 0, polish: 1, todo: 2, backlog: 3, done: 4 };

function score(card, q) {
  if (!q) return 0;
  const id = card.id.toLowerCase();
  if (id === q) return 0;
  if (id.startsWith(q)) return 1;
  if (id.includes(q)) return 2;
  const title = card.title.toLowerCase();
  if (title.startsWith(q)) return 3;
  return title.includes(q) ? 4 : -1;
}

/** Own project first, then how well it matches, then what is alive on the board, then the newest. */
export function rankCards(cards, query, project) {
  const q = query.trim().toLowerCase();
  const own = (c) => Number(c.project === project && project !== null);
  const number = (c) => Number(c.id.slice(c.id.lastIndexOf('-') + 1));
  return cards
    .map((card) => ({ card, score: score(card, q) }))
    .filter((x) => x.score >= 0)
    .sort((a, b) => own(b.card) - own(a.card) || a.score - b.score || COLUMN_ORDER[a.card.column] - COLUMN_ORDER[b.card.column] || number(b.card) - number(a.card))
    .map((x) => x.card);
}

export function makeMentions(kit) {
  return {
    id: 'kanban',
    label: () => kit.t('mention.section'),
    icon: kit.icons.SquareKanban,
    async search(query, project) {
      const { cards } = await kit.api(BOARD_URL);
      return rankCards(cards, query, project).slice(0, MAX_ITEMS).map((c) => ({
        id: c.id,
        label: c.title,
        hint: c.project ?? undefined,
        mention: kit.mention.mentionFor(c.path, `${c.id}: ${c.title.replace(/\s+/g, ' ')}`),
      }));
    },
  };
}
