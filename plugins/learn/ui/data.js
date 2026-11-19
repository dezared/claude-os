// What the screen reads and writes in the plugin's data folder. Claude writes tracks, lessons and grades through the MCP
// server; the screen writes progress.json per track and activity.json for the streak. Every change refreshes the hooks.
export const PASS = 0.7;
const BASE = '/api/os-plugins/learn/data';
const TOPICS = ['osPluginData'];
const enc = encodeURIComponent;

export const trackPath = (id, rest = 'track.json') => `${BASE}/tracks/${enc(id)}/${rest}`;

export function today(at = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/** Days in a row with some learning, ending today or, if nothing yet today, yesterday. */
export function streakOf(days, now = new Date()) {
  const set = new Set(days ?? []);
  const day = new Date(now);
  if (!set.has(today(day))) day.setDate(day.getDate() - 1);
  let n = 0;
  while (set.has(today(day))) {
    n++;
    day.setDate(day.getDate() - 1);
  }
  return n;
}

// Ids as the MCP server makes them: latin words joined by dashes; a title with none gets a numbered one.
export const slug = (text) => String(text).normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
export function uniqueId(title, taken, prefix = 'track') {
  const base = slug(title) || `${prefix}-${taken.size + 1}`;
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  taken.add(id);
  return id;
}

export const isDone = (node, progress) => node.status === 'done' || !!progress?.done?.[node.id];

/** Each node's place: done, skipped, the current one (the first left) or ahead. */
export function statusesOf(track, progress) {
  const out = {};
  let current = null;
  for (const node of track?.nodes ?? []) {
    if (isDone(node, progress)) out[node.id] = 'done';
    else if (node.status === 'skipped') out[node.id] = 'skipped';
    else if (!current) out[(current = node.id)] = 'current';
    else out[node.id] = 'todo';
  }
  return out;
}

export function makeData(host) {
  const { api, useApi, toastError } = host;
  const useData = (path) => useApi(path, TOPICS);

  const useTrackIds = () => {
    const r = useData(`${BASE}/tracks`);
    return { ids: (r.data?.entries ?? []).filter((e) => e.dir).map((e) => e.name), loading: r.loading && !r.data && !r.error };
  };
  const useTrack = (id) => useData(id ? trackPath(id) : null);
  const useProgress = (id) => useData(id ? trackPath(id, 'progress.json') : null).data ?? {};
  const useLessonIds = (id) => new Set((useData(id ? `${BASE}/tracks/${enc(id)}/lessons` : null).data?.entries ?? []).map((e) => e.name.replace(/\.json$/, '')));
  const useLesson = (id, node) => useData(id && node ? trackPath(id, `lessons/${enc(node)}.json`) : null);
  const useGrades = (id) => useData(id ? trackPath(id, 'grades.json') : null).data ?? [];
  const useActivity = () => useData(`${BASE}/activity.json`).data ?? {};

  const put = (path, value) => api(path, { method: 'PUT', body: value }).catch(toastError);

  async function markActive() {
    const activity = await api(`${BASE}/activity.json`).catch(() => ({}));
    const days = activity.days ?? [];
    if (!days.includes(today())) await put(`${BASE}/activity.json`, { ...activity, days: [...days, today()].slice(-400) });
  }

  // Read the file fresh, not the copy on screen: Claude may have written in between, and two clicks must not lose one.
  async function changeProgress(id, change) {
    const now = await api(trackPath(id, 'progress.json')).catch(() => ({}));
    await put(trackPath(id, 'progress.json'), change(now));
    await markActive();
  }

  const markRead = (id, node) => changeProgress(id, (p) => (p.read?.[node] ? p : { ...p, read: { ...p.read, [node]: Date.now() } }));
  const markDone = (id, node) => changeProgress(id, (p) => ({ ...p, done: { ...p.done, [node]: Date.now() } }));
  const addAttempt = (id, attempt, passed) => changeProgress(id, (p) => ({
    ...p,
    attempts: [...(p.attempts ?? []), attempt].slice(-500),
    ...(passed ? { done: { ...p.done, [attempt.node]: attempt.at } } : {}),
  }));
  return {
    useTrackIds, useTrack, useProgress, useLessonIds, useLesson, useGrades, useActivity, markRead, markDone, addAttempt,
    ...makeCourse(host, useData, put),
  };
}

// What makes a course: the track itself, its settings and roadmap, its materials and its work folder.
function makeCourse(host, useData, put) {
  const { api, toastError } = host;
  const deleteTrack = (id) => api(`${BASE}/tracks/${enc(id)}`, { method: 'DELETE' }).catch(toastError);
  const workspace = (folder) => api('/api/os-plugins/learn/workspace', { method: 'POST', body: folder ? { folder } : {} }).then((r) => r.path);

  // The settings and the roadmap the user edits on the screen: the same track.json Claude's tools write, read fresh first.
  async function saveTrack(id, change) {
    const now = await api(trackPath(id));
    await api(trackPath(id), { method: 'PUT', body: { ...change(now), updatedAt: Date.now() } });
  }
  // A track made without Claude: its work folder is ~/learn/<id>, made now so practice has somewhere to start.
  async function createTrack(fields, taken) {
    const id = uniqueId(fields.title, taken);
    const workdir = await workspace(id);
    await api(trackPath(id), { method: 'PUT', body: { id, ...fields, workdir, source: null, createdAt: Date.now() } });
    return id;
  }

  const useMaterialIds = (id) => (useData(id ? `${BASE}/tracks/${enc(id)}/materials` : null).data?.entries ?? []).filter((e) => !e.dir).map((e) => e.name.replace(/\.json$/, ''));
  const useMaterial = (id, m) => useData(id && m ? trackPath(id, `materials/${enc(m)}.json`) : null).data;
  const saveMaterial = (id, m, value) => put(trackPath(id, `materials/${enc(m)}.json`), { ...value, updatedAt: Date.now() });
  const deleteMaterial = (id, m) => api(trackPath(id, `materials/${enc(m)}.json`), { method: 'DELETE' }).catch(toastError);

  return { deleteTrack, workspace, saveTrack, createTrack, useMaterialIds, useMaterial, saveMaterial, deleteMaterial };
}
