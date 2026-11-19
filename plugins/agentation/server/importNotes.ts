// Loads notes a toolbar kept in a browser (an exported `feedback-annotations-<path>` array) into the agentation server under
// the page's session, as the toolbar would have sent them. A note already in that session, the same comment at the same
// time, is skipped: a second run adds nothing, and the toolbar adopts the server's copies instead of sending its own.
export interface LocalNote { comment: string; element: string; elementPath: string; timestamp?: number; kind?: string; status?: string; [field: string]: unknown }
interface Session { id: string; url: string; createdAt: string; annotations?: LocalNote[] }

/** The toolbar keeps placements and closed notes to itself (Wa in the library). */
export const isOpenNote = (n: LocalNote) => n.kind !== 'placement' && n.kind !== 'rearrange' && n.status !== 'resolved' && n.status !== 'dismissed';
const sameNote = (a: LocalNote, b: LocalNote) => a.comment === b.comment && a.timestamp === b.timestamp;
const page = (url: string) => {
  const u = new URL(url);
  return u.origin + u.pathname;
};

export async function importNotes(base: string, url: string, notes: LocalNote[]) {
  async function call<T>(method: string, path: string, body?: object): Promise<T> {
    const res = await fetch(`${base}${path}`, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status} ${await res.text()}`);
    return res.json() as Promise<T>;
  }
  // The page's newest session: the toolbar adopts the same one.
  const known = (await call<Session[]>('GET', '/sessions')).filter((s) => page(s.url) === page(url)).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const session = known ? await call<Session>('GET', `/sessions/${known.id}`) : await call<Session>('POST', '/sessions', { url });
  const there = [...(session.annotations ?? [])];
  let added = 0;
  for (const note of notes.filter(isOpenNote)) {
    if (there.some((n) => sameNote(n, note))) continue;
    const { id: _local, _syncedTo: _session, ...fields } = note;
    there.push(await call<LocalNote>('POST', `/sessions/${session.id}/annotations`, { ...fields, sessionId: session.id, url }));
    added++;
  }
  return { sessionId: session.id, added, skipped: notes.length - added };
}
