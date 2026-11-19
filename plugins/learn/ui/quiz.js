// The quiz after a lesson: scored here, every attempt kept in progress.json, a pass marks the node done.
import { fill } from './strings.js';
import { PASS } from './data.js';

let c;
const h = (...args) => c.React.createElement(...args);

export function makeQuiz(ctx) {
  c = ctx;
  return Quiz;
}

function optionClass(i, q, chosen, checked) {
  const names = ['lrn-option', 'press'];
  if (chosen === i) names.push('is-chosen');
  if (checked && i === q.answer) names.push('is-right');
  else if (checked && chosen === i) names.push('is-wrong');
  return names.join(' ');
}

function Question({ q, index, chosen, checked, onChoose }) {
  const { host, icons } = c;
  return h('fieldset', { className: 'lrn-question', 'data-testid': 'learn-question' },
    h('legend', null, h('span', { className: 'lrn-q-num' }, index + 1), q.question),
    q.options.map((option, i) => h('label', { key: i, className: optionClass(i, q, chosen, checked) },
      h('input', { type: 'radio', name: `q${index}`, checked: chosen === i, disabled: checked, onChange: () => onChoose(i) }),
      h('span', null, option),
      checked && i === q.answer && h(icons.check, { size: 13, className: 'lrn-option-mark' }))),
    h(host.motion.Fold, { show: checked && !!q.explain }, h('p', { className: 'lrn-explain' }, q.explain)));
}

function History({ attempts }) {
  const { text } = c;
  if (attempts.length === 0) return null;
  return h('div', { className: 'lrn-history' },
    h('h3', null, text.history),
    h('ol', null, attempts.slice(-5).reverse().map((a) => h('li', { key: a.at, className: a.score / a.total >= PASS ? 'is-pass' : '' },
      h('span', null, new Date(a.at).toLocaleString(c.host.lang(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })),
      h('strong', null, fill(text.score, { score: a.score, total: a.total }))))));
}

function Result({ result, total, onRetry }) {
  const { text, parts, host } = c;
  return h(host.motion.Pop, { show: !!result, fade: true },
    result && h('div', { className: `lrn-result ${result.passed ? 'is-pass' : 'is-fail'}`, role: 'status' },
      h('strong', null, fill(text.score, { score: result.score, total })),
      h('span', null, result.passed ? text.passed : fill(text.failed, { need: Math.ceil(total * PASS), total })),
      h(parts.Button, { onClick: onRetry }, text.retry)));
}

function Quiz({ track, node, lesson, progress }) {
  const { React, text, parts, data } = c;
  const quiz = lesson.quiz ?? [];
  const [answers, setAnswers] = React.useState(() => quiz.map(() => null));
  const [result, setResult] = React.useState(null);
  if (quiz.length === 0) return h('p', { className: 'lrn-empty' }, text.noQuiz);
  const ready = answers.every((a) => a !== null);
  const check = () => {
    const score = quiz.filter((q, i) => answers[i] === q.answer).length;
    const passed = score / quiz.length >= PASS;
    setResult({ score, passed });
    void data.addAttempt(track.id, { node: node.id, at: Date.now(), score, total: quiz.length, answers }, passed);
  };
  const retry = () => {
    setAnswers(quiz.map(() => null));
    setResult(null);
  };
  const attempts = (progress.attempts ?? []).filter((a) => a.node === node.id);
  return h('div', { className: 'lrn-quiz' },
    quiz.map((q, i) => h(Question, { key: i, q, index: i, chosen: answers[i], checked: !!result, onChoose: (v) => setAnswers((all) => all.map((a, j) => (j === i ? v : a))) })),
    h(Result, { result, total: quiz.length, onRetry: retry }),
    !result && h('div', { className: 'lrn-row-end' }, h(parts.Button, { kind: 'primary', disabled: !ready, title: ready ? undefined : text.answerAll, onClick: check }, text.check)),
    h(History, { attempts }));
}
