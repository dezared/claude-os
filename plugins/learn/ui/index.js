// Learn: a screen in the burger menu for learning anything with Claude. Plain modules with no build step: React comes from the app.
import { makeData } from './data.js';
import { makeEditor } from './editor.js';
import { makeHome } from './home.js';
import { makeIcons } from './icons.js';
import { makeLesson } from './lesson.js';
import { makeMaterials } from './materials.js';
import { makeParts } from './parts.js';
import { makeQuiz } from './quiz.js';
import { STRINGS } from './strings.js';
import { CSS } from './styles.js';
import { makeTrack } from './track.js';

const PLACE_KEY = 'claude-os.learn.place';

function readPlace() {
  try {
    const place = JSON.parse(localStorage.getItem(PLACE_KEY) ?? '{}');
    return { track: typeof place.track === 'string' ? place.track : null, node: typeof place.node === 'string' ? place.node : null };
  } catch {
    return { track: null, node: null };
  }
}

export function activate(host) {
  const { React } = host;
  const h = React.createElement;
  const text = STRINGS[host.lang()] ?? STRINGS.en;
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.append(style);

  const ctx = { React, h, host, text, icons: makeIcons(h), data: makeData(host) };
  ctx.parts = makeParts(ctx);
  ctx.TrackForm = makeEditor(ctx);
  ctx.Materials = makeMaterials(ctx);
  const Home = makeHome(ctx);
  const Track = makeTrack(ctx);
  const Lesson = makeLesson(ctx, makeQuiz(ctx));

  // Where the user was comes back with the screen: the lesson they were reading, not the list.
  function LearnScreen() {
    const [place, setPlace] = React.useState(readPlace);
    const go = (next) => {
      localStorage.setItem(PLACE_KEY, JSON.stringify(next));
      setPlace(next);
    };
    const view = place.track && place.node
      ? h(Lesson, { trackId: place.track, nodeId: place.node, onBack: () => go({ track: place.track, node: null }) })
      : place.track
        ? h(Track, { id: place.track, onBack: () => go({ track: null, node: null }), onLesson: (node) => go({ track: place.track, node }) })
        : h(Home, { onOpen: (track) => go({ track, node: null }) });
    return h('div', { className: 'lrn-screen', 'data-testid': 'learn-screen' }, h('div', { key: `${place.track}/${place.node}`, className: 'lrn-view' }, view));
  }

  return {
    screens: [{ id: 'learn', title: text.title, icon: ctx.icons.cap, component: LearnScreen }],
    dispose() {
      style.remove();
    },
  };
}
