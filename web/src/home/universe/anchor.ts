// A card that belongs to the scene: a DOM element for crisp text, placed by the frame loop on an object in the world.
// It eases after the object, leans with the camera, shrinks with distance and hangs on a thin line. No React in here.
import type { Camera } from './camera';

const FOLLOW = 13; // easing per second
const EDGE = 8;
const OFF_SCREEN = 40;
const LEAN_Y = 9; // degrees at the edge of the window
const LEAN_X = 6;
const LEAN_SPEED = 0.012; // degrees per pixel a second
const LEAN_MAX = 16;
const SETTLED_PX = 0.2;

export interface CardPlace {
  /** The object's world position. */
  x: number;
  y: number;
  z: number;
  /** Where the card's top left corner wants to be, given the object on screen and the card's size. */
  goal: (sx: number, sy: number, w: number, h: number) => [number, number];
}

export class SceneCard {
  private w: number;
  private h: number;
  /** Where layout alone puts it: the transform is what is added to that. */
  private baseX: number;
  private baseY: number;
  private cx = NaN;
  private cy = NaN;
  private refDepth = 0;
  private transform = '';
  private line = '';
  private gone = false;

  private el: HTMLElement;
  private leader: HTMLElement;
  private place: CardPlace;
  private still: boolean;
  private lean: number;

  constructor(el: HTMLElement, leader: HTMLElement, place: CardPlace, still: boolean, lean = 1) {
    this.el = el;
    this.leader = leader;
    this.place = place;
    this.still = still;
    this.lean = lean;
    // An opening transition on transform would lag behind every frame's write.
    el.style.transition = 'opacity 120ms ease';
    el.style.transform = '';
    const box = el.getBoundingClientRect();
    this.w = box.width;
    this.h = box.height;
    this.baseX = box.left;
    this.baseY = box.top;
    leader.classList.add('on');
  }

  destroy() {
    this.el.style.transform = '';
    this.el.style.transition = '';
    this.el.classList.remove('u-gone');
    this.leader.classList.remove('u-gone');
    this.leader.classList.remove('on');
    this.leader.style.transform = '';
  }

  /** Returns true while it still moves on its own. */
  step(camera: Camera, dt: number): boolean {
    const { x, y, z, goal } = this.place;
    const p = camera.project(x, y, z);
    const W = camera.width;
    const H = camera.height;
    const away = p.w <= 0 || p.sx < -OFF_SCREEN || p.sx > W + OFF_SCREEN || p.sy < -OFF_SCREEN || p.sy > H + OFF_SCREEN;
    if (away !== this.gone) {
      this.gone = away;
      this.el.classList.toggle('u-gone', away);
      this.leader.classList.toggle('u-gone', away);
    }
    if (away) return false;

    const [wantX, wantY] = goal(p.sx, p.sy, this.w, this.h);
    const gx = Math.max(EDGE, Math.min(W - this.w - EDGE, wantX));
    const gy = Math.max(EDGE, Math.min(H - this.h - EDGE, wantY));
    const first = Number.isNaN(this.cx);
    if (first) this.refDepth = p.w;
    const f = first || this.still ? 1 : 1 - Math.exp(-dt * FOLLOW);
    const px = this.cx;
    const py = this.cy;
    this.cx = first ? gx : px + (gx - px) * f;
    this.cy = first ? gy : py + (gy - py) * f;
    const settled = Math.abs(gx - this.cx) < SETTLED_PX && Math.abs(gy - this.cy) < SETTLED_PX;
    if (settled) {
      this.cx = gx;
      this.cy = gy;
    }

    let transform: string;
    const dx = this.cx - this.baseX;
    const dy = this.cy - this.baseY;
    if (this.still) transform = `translate3d(${dx.toFixed(1)}px,${dy.toFixed(1)}px,0)`;
    else {
      // Leaning from where it stands in the window, and a little more while it travels.
      const vx = first || dt <= 0 ? 0 : (this.cx - px) / dt;
      const vy = first || dt <= 0 ? 0 : (this.cy - py) / dt;
      const rx = clamp(((p.sy / H) - 0.5) * -2 * LEAN_X - vy * LEAN_SPEED, -LEAN_MAX, LEAN_MAX) * this.lean;
      const ry = clamp(((p.sx / W) - 0.5) * 2 * LEAN_Y + vx * LEAN_SPEED, -LEAN_MAX, LEAN_MAX) * this.lean;
      const s = clamp(Math.pow(this.refDepth / p.w, 0.25), 0.88, 1.12);
      transform = `translate3d(${dx.toFixed(1)}px,${dy.toFixed(1)}px,0) perspective(900px) rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg) scale(${s.toFixed(3)})`;
    }
    if (transform !== this.transform) {
      this.transform = transform;
      this.el.style.transform = transform;
    }

    // From the object to the nearest point of the card.
    const ex = Math.max(this.cx, Math.min(this.cx + this.w, p.sx));
    const ey = Math.max(this.cy, Math.min(this.cy + this.h, p.sy));
    const len = Math.hypot(ex - p.sx, ey - p.sy);
    const line = `translate3d(${p.sx.toFixed(1)}px,${p.sy.toFixed(1)}px,0) rotate(${Math.atan2(ey - p.sy, ex - p.sx).toFixed(3)}rad) scaleX(${len.toFixed(1)})`;
    if (line !== this.line) {
      this.line = line;
      this.leader.style.transform = line;
    }
    return !settled;
  }
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}
