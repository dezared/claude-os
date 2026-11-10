import type { Tab } from '../../../shared/contract.ts';

// The titles the server gives the root tab, the old one included: shown in the UI language. A rename stays as typed.
const ROOT_TITLES = new Set(['Home', 'Главная']); // shippable-allow: the title stored on root rows made before English

export const tabTitle = (tab: Pick<Tab, 'kind' | 'title'>, rootLabel: string): string =>
  tab.kind === 'root' && ROOT_TITLES.has(tab.title) ? rootLabel : tab.title;
