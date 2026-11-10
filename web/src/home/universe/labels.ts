// Names on the map. Plain DOM for crisp type. While the camera moves placement is recalculated a few times a second and
// transforms every frame; with the camera at rest nothing here touches the DOM, however fast the satellites fly.
import { LIBRARY_ICON_INK } from '../../../../shared/contract.ts';
import type { Camera } from './camera';
import type { Constellation, Star } from './layout';

interface Label {
  el: HTMLElement;
  width: number;
  on: boolean;
  transform: string;
  icon?: string; // what its mark shows now: the same as in the project list
}

const RESELECT_MS = 180;
const RESELECT_AT_REST_MS = 1000; // a panel may have opened over a name
const MAX_PROJECT_LABELS = 14;
const LABEL_H = 22;
const NOTE_LABELS_PER_CONSTELLATION = 12;
const CENTER_CLEAR_PX = 24; // no note's title over a project's central star
const CORE_BELOW = 0.8; // the core's name stands under its ring, seen from the home view
// The same mark as the title bar's.
const CORE_MARK = '<svg aria-hidden="true" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.341 6.484A10 10 0 0 1 10.266 21.85"/><path d="M3.659 17.516A10 10 0 0 1 13.74 2.152"/><circle cx="12" cy="12" r="3"/><circle cx="19" cy="5" r="2"/><circle cx="5" cy="19" r="2"/></svg>';

function place(l: Label, transform: string) {
  if (l.transform === transform) return;
  l.transform = transform;
  l.el.style.transform = transform;
}

export class LabelLayer {
  private root: HTMLElement;
  private project = new Map<Constellation, Label>();
  private notes = new Map<Star, Label>();
  private names: (key: string | null) => string = (k) => k ?? '';
  private lastSelect = 0;
  private liveCounts = new Map<string, number>();
  private colorOf: (key: string | null) => string = () => 'white';
  private focus: Constellation | null = null;
  private dimOthers = false;
  private icons: Record<string, string> = {};
  private chosen: Record<string, string> = {};
  private parents = new Map<string, string>();

  constructor(root: HTMLElement) {
    this.root = root;
  }

  reset() {
    this.root.replaceChildren();
    this.project.clear();
    this.notes.clear();
    this.lastSelect = 0;
  }

  /** A project left the map: its name goes with it, the others are untouched. */
  prune(keep: Constellation[]) {
    const alive = new Set(keep);
    for (const [c, l] of this.project) {
      if (alive.has(c)) continue;
      l.el.remove();
      this.project.delete(c);
    }
  }

  /** Note titles follow the stars that exist now. */
  pruneNotes(alive: Set<Star>) {
    for (const [s, l] of this.notes) {
      if (alive.has(s)) continue;
      l.el.remove();
      this.notes.delete(s);
    }
  }

  setNames(names: (key: string | null) => string) {
    this.names = names;
    for (const [c, l] of this.project) this.fill(l, c);
  }

  setIcons(icons: Record<string, string>, chosen: Record<string, string>) {
    this.icons = icons;
    this.chosen = chosen;
    for (const [c, l] of this.project) this.fill(l, c);
    this.lastSelect = 0;
  }

  setParents(parents: Map<string, string>) {
    this.parents = parents;
    for (const [c, l] of this.project) this.fill(l, c);
  }

  setLive(counts: Map<string, number>, colorOf: (key: string | null) => string) {
    this.liveCounts = counts;
    this.colorOf = colorOf;
    for (const [c, l] of this.project) this.fill(l, c);
    this.lastSelect = 0;
  }

  setFocus(c: Constellation | null, dimOthers: boolean) {
    this.focus = c;
    this.dimOthers = dimOthers;
    this.lastSelect = 0;
  }

  private fill(l: Label, c: Constellation) {
    const live = this.liveCounts.get(c.key ?? '') ?? 0;
    const name = l.el.lastChild as HTMLElement;
    if (c.core && l.el.firstElementChild?.tagName === 'I') l.el.firstElementChild.outerHTML = CORE_MARK;
    const title = c.core ? 'Claude OS' : this.names(c.key);
    name.textContent = title;
    const parent = this.parents.get(c.key ?? '');
    l.el.classList.toggle('nested', !!parent);
    if (parent) l.el.title = `${this.names(parent)} / ${title}`;
    else l.el.removeAttribute('title');
    l.el.setAttribute('aria-label', title);
    if (!c.core) this.fillIcon(l, c);
    l.el.style.setProperty('--dot', this.colorOf(c.key));
    l.el.classList.toggle('live', live > 0);
    l.el.classList.toggle('core', c.core);
    l.width = 0;
  }

  // The same mark as ProjectIcon in the project list: a library icon in the project's colour, a custom SVG as it is, else a monogram.
  // An img can run nothing and load nothing. The <i> stays: it carries the project's colour.
  private fillIcon(l: Label, c: Constellation) {
    const key = c.key ?? '';
    const color = this.colorOf(c.key);
    const raw = this.icons[key];
    const svg = this.chosen[key] ? raw?.replaceAll(LIBRARY_ICON_INK, color) : raw;
    const letter = this.names(c.key).replace(/^[^\p{L}\p{N}]+/u, '').slice(0, 1).toUpperCase() || '·';
    const shown = svg ?? `letter:${letter}`;
    if (shown === l.icon) return;
    l.icon = shown;
    const mark = l.el.firstElementChild as HTMLElement;
    mark.classList.toggle('u-icon', !!svg);
    if (!svg) return void (mark.textContent = letter);
    const img = document.createElement('img');
    img.alt = '';
    img.src = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
    mark.replaceChildren(img);
  }

  private projectLabel(c: Constellation): Label {
    let l = this.project.get(c);
    if (l) return l;
    const el = document.createElement('div');
    el.className = 'u-label';
    el.dataset.project = c.key ?? '';
    el.tabIndex = 0;
    el.setAttribute('role', 'button');
    const dot = document.createElement('i');
    const name = document.createElement('span');
    el.append(dot, name);
    this.root.append(el);
    l = { el, width: 0, on: false, transform: '' };
    this.project.set(c, l);
    this.fill(l, c);
    return l;
  }

  private noteLabel(s: Star): Label {
    let l = this.notes.get(s);
    if (l) return l;
    const el = document.createElement('div');
    el.className = 'u-label u-label-note';
    el.dataset.note = s.node.id;
    const name = document.createElement('span');
    name.textContent = s.node.title;
    el.append(name);
    this.root.append(el);
    l = { el, width: 0, on: false, transform: '' };
    this.notes.set(s, l);
    return l;
  }

  update(camera: Camera, constellations: Constellation[], stars: Star[], now: number, moved: boolean) {
    const since = now - this.lastSelect;
    const reselect = this.lastSelect === 0 || since > (moved ? RESELECT_MS : RESELECT_AT_REST_MS);
    if (!reselect && !moved) return;
    if (reselect) {
      this.lastSelect = now;
      this.select(camera, constellations, stars);
    }
    const px = camera.pxPerWorld;
    for (const [c, l] of this.project) {
      if (!l.on) continue;
      const p = camera.project(c.x, c.y, c.z);
      if (p.w <= 0) continue;
      const lift = (c.r * px) / p.w;
      place(l, c.core
        ? `translate3d(${p.sx.toFixed(1)}px,${(p.sy + lift * CORE_BELOW + 8).toFixed(1)}px,0) translate(-50%,0)`
        : `translate3d(${p.sx.toFixed(1)}px,${(p.sy - lift * 0.62 - 12).toFixed(1)}px,0) translate(-50%,-100%)`);
    }
    for (const [s, l] of this.notes) {
      if (!l.on) continue;
      const p = camera.project(s.x, s.y, s.z);
      if (p.w <= 0) continue;
      place(l, `translate3d(${(p.sx + 10).toFixed(1)}px,${p.sy.toFixed(1)}px,0) translate(0,-50%)`);
    }
  }

  private select(camera: Camera, constellations: Constellation[], stars: Star[]) {
    const W = camera.width;
    const H = camera.height;
    const px = camera.pxPerWorld;
    // Glass already covers these areas: a name behind a panel would only be a smudge.
    const placed: [number, number, number, number][] = [...document.querySelectorAll('.home-layer .glass, .home-layer .glass-strong')].map((el) => {
      const b = el.getBoundingClientRect();
      return [b.left, b.top, b.right, b.bottom];
    });
    const free = (x: number, y: number, w: number, h: number) => {
      for (const r of placed) if (x < r[2] && x + w > r[0] && y < r[3] && y + h > r[1]) return false;
      return true;
    };

    const ranked = constellations
      .map((c) => {
        const live = (this.liveCounts.get(c.key ?? '') ?? 0) > 0;
        const score = (c === this.focus ? 1e7 : 0) + (c.core ? 1e6 : 0) + (live ? 1e5 : 0) + c.r * 10 + (this.project.get(c)?.on ? 40 : 0);
        return { c, score, live };
      })
      .sort((a, b) => b.score - a.score);

    let shown = 0;
    const closeUp: Constellation[] = [];
    for (const { c, live } of ranked) {
      const l = this.projectLabel(c);
      const p = camera.project(c.x, c.y, c.z);
      const pxR = p.w > 0 ? (c.r * px) / p.w : 0;
      let on = p.w > 0 && p.sx > -60 && p.sx < W + 60 && p.sy > 30 && p.sy < H + 40;
      // Small constellations wait until the camera is closer; live ones and the focused one never wait.
      if (on && !live && !c.core && c !== this.focus && c.stars.length > 0 && pxR < 13) on = false;
      if (on && shown >= MAX_PROJECT_LABELS && c !== this.focus) on = false;
      if (on) {
        if (!l.width) l.width = l.el.offsetWidth;
        const x = p.sx - l.width / 2 - 8;
        const y = c.core ? p.sy + pxR * CORE_BELOW + 6 : p.sy - pxR * 0.62 - 12 - LABEL_H - 2;
        if (!free(x, y, l.width + 16, LABEL_H + 4)) on = false;
        else {
          placed.push([x, y, x + l.width + 16, y + LABEL_H + 4]);
          shown++;
        }
      }
      if (pxR > H * 0.2 && p.w > 0) closeUp.push(c);
      this.toggle(l, on);
      l.el.classList.toggle('hot', c === this.focus);
      l.el.classList.toggle('dim', this.dimOthers && c !== this.focus);
    }

    // Close enough to read: the most linked notes get their titles too.
    const wanted = new Set<Star>();
    for (const c of closeUp) {
      const heart = camera.project(c.x, c.y, c.z);
      placed.push([heart.sx - CENTER_CLEAR_PX, heart.sy - CENTER_CLEAR_PX, heart.sx + CENTER_CLEAR_PX, heart.sy + CENTER_CLEAR_PX]);
      const top = c.stars.map((i) => stars[i]).sort((a, b) => b.node.degree - a.node.degree || a.node.id.localeCompare(b.node.id));
      for (const s of top.slice(0, NOTE_LABELS_PER_CONSTELLATION)) {
        const p = camera.project(s.x, s.y, s.z);
        if (p.w <= 0 || p.sx < 0 || p.sx > W || p.sy < 30 || p.sy > H) continue;
        const l = this.noteLabel(s);
        if (!l.width) l.width = l.el.offsetWidth;
        const x = p.sx + 8;
        const y = p.sy - LABEL_H / 2;
        if (!free(x, y, l.width + 8, LABEL_H)) continue;
        placed.push([x, y, x + l.width + 8, y + LABEL_H]);
        wanted.add(s);
      }
    }
    for (const [s, l] of this.notes) this.toggle(l, wanted.has(s));
  }

  /** The element that stands for this constellation, for pointer events that land on the nucleus itself. */
  elementOf(c: Constellation): HTMLElement | null {
    return this.project.get(c)?.el ?? null;
  }

  private toggle(l: Label, on: boolean) {
    if (l.on === on) return;
    l.on = on;
    l.el.classList.toggle('on', on);
  }
}
