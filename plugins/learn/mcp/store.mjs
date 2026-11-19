// The Learn data folder as Claude changes it: tracks, roadmaps, lessons and grades. The screen owns progress.json.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const STATUSES = ['todo', 'done', 'skipped'];
const MAX_HTML = 2 * 1024 * 1024;
const KINDS = ['markdown', 'html', 'text'];
const MAX_FILES = 30;
export const PASS = 70;

export class LearnError extends Error {}
const fail = (message) => {
  throw new LearnError(message);
};

export const slug = (text) => String(text).normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);

function readJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  return JSON.parse(readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  renameSync(tmp, file);
}

const text = (v, name, max = 2000) => {
  if (typeof v !== 'string' || !v.trim()) fail(`${name} is required`);
  return v.trim().slice(0, max);
};
const optional = (v, max = 4000) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

function uniqueId(wanted, taken, prefix) {
  const base = (wanted && ID.test(wanted) ? wanted : slug(wanted ?? '')) || `${prefix}-${taken.size + 1}`;
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  taken.add(id);
  return id;
}

// A node keeps its id once it has one: lessons and progress are filed under it.
function readNode(given, before, taken) {
  const old = before.find((b) => b.id === given?.id);
  const n = { ...old, ...(typeof given === 'object' ? given : {}) };
  const status = n.status ?? 'todo';
  if (!STATUSES.includes(status)) fail(`status must be one of ${STATUSES.join(', ')}`);
  const id = old ? old.id : uniqueId(n.id ?? n.title, taken, 'step');
  taken.add(id);
  return { id, title: text(n.title, 'node title', 200), summary: optional(n.summary, 600), status };
}

function readNodes(list, before = []) {
  if (!Array.isArray(list) || list.length === 0) fail('nodes must be a non-empty list');
  const taken = new Set(before.map((b) => b.id).filter((id) => list.some((n) => n?.id === id)));
  return list.map((n) => readNode(n, before, taken));
}

function readQuiz(list) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) fail('quiz must be a list');
  return list.map((q, i) => {
    const options = Array.isArray(q?.options) ? q.options.map((o) => text(o, `quiz ${i + 1} option`, 400)) : [];
    if (options.length < 2) fail(`quiz ${i + 1} needs at least two options`);
    if (!Number.isInteger(q.answer) || q.answer < 0 || q.answer >= options.length) fail(`quiz ${i + 1}: answer must be the index of the right option`);
    return { question: text(q.question, `quiz ${i + 1} question`, 1000), options, answer: q.answer, explain: optional(q.explain, 1000) };
  });
}

function readVideos(list) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) fail('videos must be a list');
  return list.map((v, i) => {
    const url = text(v?.url, `video ${i + 1} url`, 500);
    if (!url.startsWith('https://')) fail(`video ${i + 1}: url must start with https://`);
    return { title: text(v.title, `video ${i + 1} title`, 200), url, minutes: Number.isFinite(v.minutes) ? v.minutes : null };
  });
}

// An exercise's files, written into the work folder when practice starts: relative paths that stay inside it.
function readFiles(list) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list) || list.length > MAX_FILES) fail(`practice files must be a list of at most ${MAX_FILES}`);
  return list.map((f, i) => {
    const path = text(f?.path, `practice file ${i + 1} path`, 300).replaceAll('\\', '/');
    if (path.startsWith('/') || /^[a-z]:/i.test(path) || path.split('/').some((s) => s === '..' || s === '')) fail(`practice file ${path}: a relative path inside the exercise folder`);
    if (typeof f.content !== 'string') fail(`practice file ${path}: content is required`);
    return { path, content: f.content.slice(0, MAX_HTML) };
  });
}

function readPractice(p) {
  if (!p) return null;
  return { task: text(p.task, 'practice task', 4000), hint: optional(p.hint, 1000), check: optional(p.check, 500), files: readFiles(p.files) };
}

// Mirrors what the screen's frame does to a lesson: Claude learns about it now, not the user later.
function warningsFor(html) {
  const out = [];
  if (/<script\b/i.test(html) || /\son\w+\s*=/i.test(html)) out.push('Scripts do not run: the lesson is shown without JS.');
  if (/(?:src|srcset)\s*=\s*["']?(?:https?:)?\/\//i.test(html) || /<link\b/i.test(html)) out.push('External files do not load: inline SVG or data: URLs only.');
  return out;
}

export function createStore(root) {
  const trackDir = (id) => {
    if (!ID.test(String(id))) fail(`bad track id ${id}`);
    return join(root, 'tracks', id);
  };
  const trackFile = (id) => join(trackDir(id), 'track.json');
  function load(id) {
    const track = readJson(trackFile(id), null);
    if (!track) fail(`no track ${id}; learn_list_tracks lists them`);
    return track;
  }
  const save = (track) => writeJson(trackFile(track.id), { ...track, updatedAt: Date.now() });
  const ids = () => (existsSync(join(root, 'tracks')) ? readdirSync(join(root, 'tracks')).filter((n) => ID.test(n) && existsSync(trackFile(n))) : []);
  const progressOf = (id) => readJson(join(trackDir(id), 'progress.json'), {});
  const isDone = (node, progress) => node.status === 'done' || !!progress.done?.[node.id];
  return { root, trackDir, trackFile, load, save, ids, progressOf, isDone };
}

export function listTracks(store) {
  return store.ids().map((id) => {
    const track = store.load(id);
    const progress = store.progressOf(id);
    const next = track.nodes.find((n) => n.status !== 'skipped' && !store.isDone(n, progress));
    return { id, title: track.title, goal: track.goal, nodes: track.nodes.length, done: track.nodes.filter((n) => store.isDone(n, progress)).length, next: next?.id ?? null };
  });
}

export function getTrack(store, args) {
  const track = store.load(args.track);
  const progress = store.progressOf(track.id);
  const lessons = existsSync(join(store.trackDir(track.id), 'lessons')) ? readdirSync(join(store.trackDir(track.id), 'lessons')).filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)) : [];
  const attempts = (progress.attempts ?? []).slice(-20);
  const grades = readJson(join(store.trackDir(track.id), 'grades.json'), []).slice(-20);
  const materials = materialIds(store, track.id).map((id) => {
    const m = readJson(materialFile(store, track.id, id), {});
    return { id, title: m.title ?? id, kind: m.kind ?? 'text', chars: String(m.content ?? '').length };
  });
  return { ...track, nodes: track.nodes.map((n) => ({ ...n, done: store.isDone(n, progress), hasLesson: lessons.includes(n.id) })), materials, recentQuizAttempts: attempts, recentGrades: grades, activeDays: (progress.days ?? []).slice(-30) };
}

// A course's own materials: a program, a page template, reference notes. The user adds them on the screen, Claude here.
const materialFile = (store, track, id) => join(store.trackDir(track), 'materials', `${id}.json`);
function materialIds(store, track) {
  const dir = join(store.trackDir(track), 'materials');
  return existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)).filter((id) => ID.test(id)) : [];
}

export function saveMaterial(store, args) {
  const track = store.load(args.track);
  const kind = args.kind ?? 'markdown';
  if (!KINDS.includes(kind)) fail(`kind must be one of ${KINDS.join(', ')}`);
  const taken = new Set(materialIds(store, track.id));
  const id = args.id && ID.test(args.id) ? args.id : uniqueId(args.title, taken, 'material');
  const material = { title: text(args.title, 'title', 200), kind, content: text(args.content, 'content', MAX_HTML), updatedAt: Date.now() };
  writeJson(materialFile(store, track.id, id), material);
  return { id, title: material.title, kind };
}

export function readMaterial(store, args) {
  const track = store.load(args.track);
  if (!ID.test(String(args.material)) || !existsSync(materialFile(store, track.id, args.material))) fail(`no material ${args.material} in ${track.id}; learn_get_track lists them`);
  return { id: args.material, ...readJson(materialFile(store, track.id, args.material), {}) };
}

// Exercises live in ~/learn, the plugin's workspace: a track's folder is made there and nowhere else on the machine.
function workdirOf(given, id) {
  const home = join(homedir(), 'learn');
  const dir = resolve(home, optional(given, 500) ?? id);
  if (!dir.startsWith(home + sep)) fail(`workdir must be a folder inside ${home}`);
  return dir;
}

export function createTrack(store, args) {
  const taken = new Set(store.ids());
  const id = uniqueId(args.id ?? args.title, taken, 'track');
  const workdir = workdirOf(args.workdir, id);
  mkdirSync(workdir, { recursive: true });
  const track = {
    id, title: text(args.title, 'title', 200), goal: text(args.goal, 'goal', 1000), level: optional(args.level, 200), language: optional(args.language, 20) ?? 'ru',
    style: optional(args.style, 8000), source: optional(args.source, 500), workdir, createdAt: Date.now(), nodes: readNodes(args.nodes),
  };
  store.save(track);
  return track;
}

export function updateRoadmap(store, args) {
  const track = store.load(args.track);
  const next = { ...track, nodes: args.nodes === undefined ? track.nodes : readNodes(args.nodes, track.nodes) };
  for (const key of ['goal', 'level', 'style']) if (args[key] !== undefined) next[key] = optional(args[key], 8000);
  store.save(next);
  return next;
}

export function saveLesson(store, args) {
  const track = store.load(args.track);
  if (!track.nodes.some((n) => n.id === args.node)) fail(`no node ${args.node} in ${track.id}: add it with learn_update_roadmap first`);
  const html = text(args.html, 'html', MAX_HTML);
  const lesson = {
    node: args.node, title: text(args.title, 'title', 200), minutes: Number.isFinite(args.minutes) ? args.minutes : null, html,
    quiz: readQuiz(args.quiz), videos: readVideos(args.videos),
    practice: readPractice(args.practice), createdAt: Date.now(),
  };
  writeJson(join(store.trackDir(track.id), 'lessons', `${args.node}.json`), lesson);
  return { saved: `${track.id}/${args.node}`, quiz: lesson.quiz.length, warnings: warningsFor(html) };
}

export function getLesson(store, args) {
  const track = store.load(args.track);
  const file = join(store.trackDir(track.id), 'lessons', `${args.node}.json`);
  if (!ID.test(String(args.node)) || !existsSync(file)) fail(`no lesson for ${args.node} in ${track.id}`);
  return readJson(file, null);
}

export function recordGrade(store, args) {
  const track = store.load(args.track);
  const node = track.nodes.find((n) => n.id === args.node);
  if (!node) fail(`no node ${args.node} in ${track.id}`);
  if (!Number.isFinite(args.score) || args.score < 0 || args.score > 100) fail('score must be 0 to 100');
  const file = join(store.trackDir(track.id), 'grades.json');
  const grade = { node: node.id, at: Date.now(), score: Math.round(args.score), feedback: text(args.feedback, 'feedback', 4000) };
  writeJson(file, [...readJson(file, []), grade]);
  if (grade.score >= PASS && node.status === 'todo') store.save({ ...track, nodes: track.nodes.map((n) => (n.id === node.id ? { ...n, status: 'done' } : n)) });
  return { ...grade, passed: grade.score >= PASS };
}
