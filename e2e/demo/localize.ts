// Rewrites fixture answers into the demo: project names and Russian strings become English on the way to the page,
// and the page's requests get the fixture names back so the fixture keeps answering.
import type { BrowserContext } from 'playwright';
import { NAMES, skillRunsByDay, SUBSTRINGS, TEXT } from './demo-data.ts';

const CYRILLIC = /[А-Яа-яЁё]/;

const replaceAll = (s: string, pairs: [string, string][], reverse = false) =>
  pairs.reduce((acc, [a, b]) => (reverse ? acc.split(b).join(a) : acc.split(a).join(b)), s);

/** One string as the demo shows it. Records what is still untranslated, so a new fixture string is noticed. */
export function demoString(s: string, missed: Set<string>): string {
  const whole = TEXT[s] ?? replaceAll(s, SUBSTRINGS);
  const out = replaceAll(whole, NAMES);
  if (CYRILLIC.test(out)) missed.add(out);
  return out;
}

export function localize(value: unknown, missed: Set<string>): unknown {
  if (typeof value === 'string') return demoString(value, missed);
  if (Array.isArray(value)) return value.map((v) => localize(v, missed));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, localize(v, missed)]));
  return value;
}

/** Fixture names back into a request URL or body. */
export const toFixture = (s: string) => replaceAll(s, NAMES, true);

/** Routes every API call of the context through the demo layer. Returns the set of strings left untranslated. */
export async function routeDemo(ctx: BrowserContext): Promise<Set<string>> {
  const missed = new Set<string>();
  await ctx.route('**/api/**', async (route) => {
    const req = route.request();
    const body = req.postData();
    const res = await route.fetch({ url: toFixture(req.url()), ...(body ? { postData: toFixture(body) } : {}) });
    const raw = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return route.fulfill({ response: res, body: raw });
    }
    if (new URL(req.url()).pathname === '/api/admin/skills') json = { ...(json as object), byDay: skillRunsByDay() };
    await route.fulfill({ response: res, json: localize(json, missed) });
  });
  return missed;
}
