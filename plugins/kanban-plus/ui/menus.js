// What a card can do from its right-click menu and its dialog, and the board's own menu.
import { placeByKey } from './board.js';
import { COLUMNS, boardName, cardUrl, moveCard, patchCard, send } from './data.js';

/** The tab takes the card on the way: from here on the board shows who works on it. */
export async function sendToSession(kit, card) {
  const tab = await kit.tabs.createTab({ project: card.project ?? undefined, title: card.title });
  if (!tab) return;
  await send(kit, `${cardUrl(card.id)}/take`, 'POST', { agent: 'Claude', tab: tab.id });
  const body = card.description.trim() ? `\n\n${card.description.trim()}` : '';
  await kit.api(`/api/tabs/${encodeURIComponent(tab.id)}/send`, { method: 'POST', body: { text: `${card.id}: ${card.title}${body}\n\nCard file: ${card.path}. Move the card with move_kanban_card when its state changes; note what you did with add_kanban_comment.` } }).catch(kit.toastError);
}

export function mention(kit, card) {
  const hint = `${card.id}: ${card.title.replace(/\s+/g, ' ')}`;
  if (kit.mention.tagInChat(card.path, hint)) return;
  void navigator.clipboard.writeText(kit.mention.mentionFor(card.path, hint)).then(() => kit.toast(kit.t('card.mentionCopied')), kit.toastError);
}

function moveItems(kit, card, cards) {
  const at = COLUMNS.indexOf(card.column);
  const go = (key) => () => {
    const place = placeByKey(cards, card, key);
    if (place) void moveCard(kit, card.id, place);
  };
  return [
    ...(at > 0 ? [{ id: 'kp.left', label: kit.t('card.moveTo', { name: kit.t(`col.${COLUMNS[at - 1]}`) }), icon: kit.icons.ArrowLeft, apart: true, onSelect: go('ArrowLeft') }] : []),
    ...(at < COLUMNS.length - 1 ? [{ id: 'kp.right', label: kit.t('card.moveTo', { name: kit.t(`col.${COLUMNS[at + 1]}`) }), icon: kit.icons.ArrowRight, apart: at === 0, onSelect: go('ArrowRight') }] : []),
  ];
}

function boardItems(kit, card, boards) {
  return boards.filter((b) => b.id !== card.board).map((b, i) => ({ id: `kp.board.${b.id}`, label: kit.t('card.boardTo', { name: boardName(kit, b) }), icon: kit.icons.Columns3, apart: i === 0, onSelect: () => void patchCard(kit, card.id, { board: b.id }) }));
}

function whoItems(kit, card, tabs) {
  const tab = card.agentTab ? tabs.find((x) => x.id === card.agentTab) : undefined;
  return [
    ...(tab ? [{ id: 'kp.agentOpen', label: kit.t('card.agentOpen', { name: tab.title }), icon: kit.icons.Bot, onSelect: () => kit.go({ kind: 'tab', id: tab.id }) }] : []),
    ...(card.assignee !== 'user' ? [{ id: 'kp.mine', label: kit.t('card.takeMine'), icon: kit.icons.User, onSelect: () => void patchCard(kit, card.id, { assignee: 'user' }) }] : []),
    ...(card.agent || card.assignee ? [{ id: 'kp.release', label: kit.t('card.release'), icon: kit.icons.UserRoundX, onSelect: () => void patchCard(kit, card.id, { assignee: null }) }] : []),
  ];
}

export function cardMenu(kit, { card, cards, boards, tabs, open, remove }) {
  const [change, ask] = kit.claudeItems({ kind: 'kanban card', name: card.title, context: `Card id: ${card.id}\nType: ${card.type}\nColumn: ${card.column}\nPriority: ${card.priority}${card.project ? `\nProject: ${card.project}` : ''}\n${card.description}`, project: card.project });
  return [
    { id: 'kp.open', label: kit.t('card.open'), icon: kit.icons.Pencil, onSelect: () => open(card) },
    { id: 'kp.send', label: kit.t('card.send'), icon: kit.icons.MessageSquarePlus, disabled: !card.project, title: card.project ? undefined : kit.t('card.sendNeedsProject'), onSelect: () => void sendToSession(kit, card).catch(kit.toastError) },
    { id: 'kp.mention', label: kit.t('card.mention'), icon: kit.icons.AtSign, onSelect: () => mention(kit, card) },
    ...whoItems(kit, card, tabs),
    ...moveItems(kit, card, cards),
    ...boardItems(kit, card, boards),
    { ...change, apart: true },
    ask,
    { id: 'kp.delete', label: kit.t('card.delete'), icon: kit.icons.Trash2, danger: true, apart: true, onSelect: () => remove(card) },
  ];
}

/** Claude arranges the board in the root session, which has the board's tools. */
export function arrange(kit, { name, board, cards }) {
  const list = cards.map((c) => `- [${c.column}] ${c.id}: ${c.title}${c.project ? ` (${c.project})` : ''}, ${c.type}, ${c.priority}`).join('\n');
  return kit.claudeItems({
    kind: 'kanban board',
    name,
    context: `Use the tools list_kanban_cards, add_kanban_card, update_kanban_card and move_kanban_card. This is the board with id ${board.id}: a new card gets board "${board.id}". ${board.project ? `Its cards belong to project key ${board.project}.` : 'Set each card\'s project from list_projects, null when it is not about one project.'}\nCards now:\n${list || 'none'}`,
  }, { changePresets: [kit.t('arrange.fromNotes'), kit.t('arrange.priorities'), kit.t('arrange.split')] })[0];
}
