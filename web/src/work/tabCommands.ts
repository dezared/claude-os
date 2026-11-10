import { useEffect } from 'react';

// The dialog of a slash command opening a control that lives elsewhere in the work tab. Home keeps its composer mounted under the tabs: the id says whose.
type TabCommand = 'git' | 'mode' | 'running';

export const sendTabCommand = (tabId: string, what: TabCommand) => window.dispatchEvent(new CustomEvent(`claude-os:${what}`, { detail: tabId }));

export function useTabCommand(tabId: string, what: TabCommand, run: () => void) {
  useEffect(() => {
    const on = (e: Event) => {
      if ((e as CustomEvent<string>).detail === tabId) run();
    };
    window.addEventListener(`claude-os:${what}`, on);
    return () => window.removeEventListener(`claude-os:${what}`, on);
  }, [tabId, what]); // eslint-disable-line react-hooks/exhaustive-deps
}
