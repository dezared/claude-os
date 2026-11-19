// A lesson in three steps: the article, the quiz, practice with Claude and videos.
import { fill } from './strings.js';
import { isDone } from './data.js';
import { lessonDocument, useTheme } from './article.js';
import { lessonPrompt, practicePrompt } from './prompts.js';
import { chatInTrack } from './track.js';

const STEPS = ['article', 'quiz', 'practice'];

let c;
const h = (...args) => c.React.createElement(...args);
let Quiz;

export function makeLesson(ctx, quiz) {
  c = ctx;
  Quiz = quiz;
  return Lesson;
}

function Steps({ step, setStep, lesson }) {
  const { text, icons } = c;
  const icon = { article: icons.book, quiz: icons.quiz, practice: icons.chat };
  return h('div', { className: 'lrn-steps', role: 'tablist', style: { '--at': STEPS.indexOf(step) } },
    h('span', { className: 'lrn-steps-thumb', 'aria-hidden': true }),
    STEPS.map((s) => h('button', { key: s, type: 'button', role: 'tab', 'aria-selected': step === s, className: 'lrn-step press', onClick: () => setStep(s) },
      h(icon[s], { size: 13 }), text[s], s === 'quiz' && lesson.quiz?.length > 0 && h('span', { className: 'lrn-count' }, lesson.quiz.length))));
}

function Article({ lesson, onNext }) {
  const { React, host, text, parts, icons } = c;
  const theme = useTheme(React);
  const html = React.useMemo(() => lessonDocument(lesson, host.highlight), [lesson, theme]);
  return h('div', { className: 'lrn-article' },
    h(host.HtmlFrame, { html, title: lesson.title, className: 'lrn-frame' }),
    h('div', { className: 'lrn-article-foot' }, h(parts.Button, { kind: 'primary', icon: icons.quiz, onClick: onNext }, lesson.quiz?.length ? text.toQuiz : text.toPractice)));
}

function Videos({ videos }) {
  const { text, icons } = c;
  if (!videos?.length) return null;
  return h('section', { className: 'lrn-videos' },
    h('h3', null, text.videos),
    videos.map((v) => h('a', { key: v.url, href: v.url, target: '_blank', rel: 'noopener noreferrer', className: 'lrn-video press' },
      h(icons.play, { size: 14 }), h('span', null, v.title), v.minutes && h('span', { className: 'lrn-dim' }, fill(text.minutes, { n: v.minutes })))));
}

function Grades({ grades }) {
  const { text } = c;
  if (grades.length === 0) return null;
  return h('section', { className: 'lrn-grades' },
    h('h3', null, text.grades),
    grades.slice(-3).reverse().map((g) => h('div', { key: g.at, className: `lrn-grade ${g.score >= 70 ? 'is-pass' : ''}` }, h('strong', null, g.score), h('p', null, g.feedback))));
}

/** The exercise the course carries: its files and the command that checks a solution. */
function Exercise({ practice }) {
  const { text, icons } = c;
  if (!practice.check && !practice.files?.length) return null;
  return h('div', { className: 'lrn-exercise', 'data-testid': 'learn-exercise' },
    practice.check && h('div', { className: 'lrn-row' }, h('span', { className: 'lrn-dim' }, text.checkWith), h('code', { className: 'lrn-mono' }, practice.check)),
    practice.files?.length > 0 && h('ul', { className: 'lrn-files', 'aria-label': text.exerciseFiles },
      practice.files.map((f) => h('li', { key: f.path }, h(icons.files, { size: 12 }), h('span', { className: 'lrn-mono' }, f.path)))));
}

function Task({ practice }) {
  const { text } = c;
  if (!practice) return h('p', { className: 'lrn-empty' }, text.noPractice);
  return h('div', { className: 'lrn-task' },
    h('p', null, practice.task),
    practice.hint && h('details', null, h('summary', null, text.hint), h('p', null, practice.hint)),
    h(Exercise, { practice }));
}

function Practice({ track, node, lesson, done }) {
  const { text, icons, parts, data } = c;
  const grades = data.useGrades(track.id).filter((g) => g.node === node.id);
  return h('div', { className: 'lrn-practice' },
    h(Task, { practice: lesson.practice }),
    h('p', { className: 'lrn-dim' }, text.practiceNote),
    h('div', { className: 'lrn-row' },
      h(parts.Button, { kind: 'primary', icon: icons.chat, onClick: () => void chatInTrack(track, lesson.title, practicePrompt(track, node, lesson)) }, text.practiceGo),
      !done && !lesson.quiz?.length && h(parts.Button, { icon: icons.check, onClick: () => void data.markDone(track.id, node.id) }, text.markDone)),
    h(Grades, { grades }),
    h(Videos, { videos: lesson.videos }));
}

function Body({ track, node, lesson, progress }) {
  const { React } = c;
  const [step, setStep] = React.useState('article');
  const next = () => setStep(lesson.quiz?.length ? 'quiz' : 'practice');
  const panel = {
    article: () => h(Article, { lesson, onNext: next }),
    quiz: () => h(Quiz, { key: lesson.createdAt, track, node, lesson, progress }),
    practice: () => h(Practice, { track, node, lesson, done: isDone(node, progress) }),
  }[step];
  return h(React.Fragment, null,
    h(Steps, { step, setStep, lesson }),
    h('div', { key: step, className: `lrn-panel enter-fade is-${step}`, role: 'tabpanel' }, panel()));
}

function Head({ track, node, lesson, progress, onBack }) {
  const { text, parts, icons, host } = c;
  const done = !!node && isDone(node, progress);
  const redo = () => void chatInTrack(track, node.title, lessonPrompt(track, node, true));
  return h(parts.Header, { title: lesson?.title ?? node?.title ?? '…', onBack, backLabel: track?.title },
    h(parts.Streak),
    lesson?.minutes && h('span', { className: 'lrn-chip' }, h(icons.clock, { size: 12 }), fill(text.minutes, { n: lesson.minutes })),
    h(host.motion.Pop, { show: done }, h('span', { className: 'lrn-chip is-ok' }, h(icons.check, { size: 12 }), text.doneMark)),
    node && h('button', { type: 'button', className: 'lrn-icon-btn press', 'aria-label': text.redo, title: text.redo, onClick: redo }, h(icons.sparkles, { size: 14 })));
}

function Lesson({ trackId, nodeId, onBack }) {
  const { React, text, data } = c;
  const track = data.useTrack(trackId).data;
  const progress = data.useProgress(trackId);
  const { data: lesson, error } = data.useLesson(trackId, nodeId);
  const node = track?.nodes.find((n) => n.id === nodeId);
  React.useEffect(() => {
    if (lesson) void data.markRead(trackId, nodeId);
  }, [!!lesson, trackId, nodeId]);
  const broken = lesson && typeof lesson.html !== 'string';
  const problem = broken ? text.lessonBroken : error ? text.noLesson : null;
  return h('div', { className: 'lrn-page lrn-lesson' },
    h(Head, { track, node, lesson, progress, onBack }),
    problem && h('p', { className: 'lrn-empty' }, problem),
    node && lesson && !broken && h(Body, { track, node, lesson, progress }));
}
