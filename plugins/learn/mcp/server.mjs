// The Learn MCP server: stdio, one JSON-RPC message per line, no dependencies. LEARN_DATA is the plugin's data folder.
import { createInterface } from 'node:readline';
import { LearnError, createStore, createTrack, getLesson, getTrack, listTracks, readMaterial, recordGrade, saveLesson, saveMaterial, updateRoadmap } from './store.mjs';

const VERSION = '1.1.0';
const str = (description) => ({ type: 'string', description });
const NODE = { type: 'object', properties: { id: str('Keep an existing id to keep its lesson and progress; omit for a new node.'), title: str('Short title'), summary: str('One or two lines: what the learner can do after it'), status: { type: 'string', enum: ['todo', 'done', 'skipped'] } }, required: ['title'] };
const NODES = { type: 'array', items: NODE, description: 'The roadmap in order, 5 to 30 nodes' };
const QUIZ = { type: 'array', description: '3 to 7 questions that check understanding, not recall of wording', items: { type: 'object', properties: { question: str('The question'), options: { type: 'array', items: { type: 'string' } }, answer: { type: 'integer', description: 'Index of the right option' }, explain: str('Why it is right, shown after answering') }, required: ['question', 'options', 'answer'] } };
const FILES = { type: 'array', description: 'The exercise as files written into the work folder when practice starts: a stub with TODO bodies and tests that fail until it is solved', items: { type: 'object', properties: { path: str('Relative path inside the exercise folder, such as money/money_test.go'), content: str('The file') }, required: ['path', 'content'] } };
const PRACTICE = { type: 'object', properties: { task: str('An exercise done with Claude in the work folder'), hint: str('One hint'), check: str('The command that checks a solution, such as go test ./...'), files: FILES }, required: ['task'] };
const VIDEOS = { type: 'array', description: 'Short videos (under 20 min). A YouTube search URL when you cannot check a video exists.', items: { type: 'object', properties: { title: str('Title'), url: str('https URL'), minutes: { type: 'number' } }, required: ['title', 'url'] } };

const TOOLS = [
  { name: 'learn_list_tracks', description: 'List the learning tracks with progress and the next node.', inputSchema: { type: 'object', properties: {} }, run: listTracks },
  { name: 'learn_get_track', description: 'A track: goal, style notes, work folder, roadmap with done marks and which nodes have lessons, recent quiz attempts and grades. Read it before writing a lesson.', inputSchema: { type: 'object', properties: { track: str('Track id') }, required: ['track'] }, run: getTrack },
  {
    name: 'learn_create_track',
    description: 'Create a learning track with its roadmap. Its work folder (default ~/learn/<id>) is where practice happens.',
    inputSchema: { type: 'object', properties: { id: str('Optional latin id'), title: str('Title in the learner language'), goal: str('What the learner wants to be able to do'), level: str('Where the learner starts'), language: str('Language of lessons, such as ru or en'), style: str('How lessons of this track are written: audience, comparisons, examples, rules'), source: str('Where it came from, such as a course plugin folder'), workdir: str('Folder for exercises inside ~/learn, absolute or relative to it; default ~/learn/<track id>'), nodes: NODES }, required: ['title', 'goal', 'nodes'] },
    run: createTrack,
  },
  { name: 'learn_update_roadmap', description: 'Replace the roadmap (nodes in order) and optionally the goal, level or style. Keep ids of nodes that stay.', inputSchema: { type: 'object', properties: { track: str('Track id'), nodes: NODES, goal: str('Goal'), level: str('Level'), style: str('Style notes') }, required: ['track'] }, run: updateRoadmap },
  {
    name: 'learn_save_lesson',
    description: 'Save the lesson of a roadmap node: an HTML article (body content only, no scripts, no external files), a quiz, videos and a practice task. Replaces an older lesson of that node.',
    inputSchema: { type: 'object', properties: { track: str('Track id'), node: str('Node id'), title: str('Lesson title'), minutes: { type: 'number', description: 'Reading time' }, html: str('The article, see the learn skill for the format'), quiz: QUIZ, videos: VIDEOS, practice: PRACTICE }, required: ['track', 'node', 'title', 'html'] },
    run: saveLesson,
  },
  { name: 'learn_get_lesson', description: 'A saved lesson in full: the article, the quiz, videos and the practice with its exercise files and check command.', inputSchema: { type: 'object', properties: { track: str('Track id'), node: str('Node id') }, required: ['track', 'node'] }, run: getLesson },
  { name: 'learn_record_grade', description: 'Record a grade for practice or open answers. 70 or more marks the node done.', inputSchema: { type: 'object', properties: { track: str('Track id'), node: str('Node id'), score: { type: 'number', description: '0 to 100' }, feedback: str('What was good, what to fix, in the learner language') }, required: ['track', 'node', 'score', 'feedback'] }, run: recordGrade },
  {
    name: 'learn_save_material',
    description: "Save a material of the track: the course program, a page template, reference notes. Lessons follow the track's materials. Pass an existing id to replace it.",
    inputSchema: { type: 'object', properties: { track: str('Track id'), id: str('Material id to replace; omit for a new one'), title: str('Title'), kind: { type: 'string', enum: ['markdown', 'html', 'text'] }, content: str('The material') }, required: ['track', 'title', 'content'] },
    run: saveMaterial,
  },
  { name: 'learn_read_material', description: 'Read a material of the track in full; learn_get_track lists them.', inputSchema: { type: 'object', properties: { track: str('Track id'), material: str('Material id') }, required: ['track', 'material'] }, run: readMaterial },
];

function call(store, params) {
  const tool = TOOLS.find((t) => t.name === params?.name);
  if (!tool) return { content: [{ type: 'text', text: `unknown tool ${params?.name}` }], isError: true };
  try {
    return { content: [{ type: 'text', text: JSON.stringify(tool.run(store, params.arguments ?? {}), null, 2) }] };
  } catch (err) {
    if (!(err instanceof LearnError) && !(err instanceof SyntaxError)) throw err;
    return { content: [{ type: 'text', text: err.message }], isError: true };
  }
}

function handle(store, msg) {
  switch (msg.method) {
    case 'initialize':
      return { protocolVersion: msg.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'learn', version: VERSION } };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
    case 'tools/call':
      return call(store, msg.params);
    default:
      return undefined;
  }
}

function serve() {
  const store = createStore(process.env.LEARN_DATA || process.cwd());
  const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
  createInterface({ input: process.stdin }).on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return send({ id: null, error: { code: -32700, message: 'parse error' } });
    }
    if (msg.id === undefined) return; // a notification
    try {
      const result = handle(store, msg);
      send(result === undefined ? { id: msg.id, error: { code: -32601, message: `no method ${msg.method}` } } : { id: msg.id, result });
    } catch (err) {
      send({ id: msg.id, error: { code: -32603, message: err.message } });
    }
  });
}

serve();
