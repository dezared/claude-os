// The renderer behind the home screen. The map stands still: frames are drawn only when something changes,
// so an untouched Home costs no GPU at all. The camera moves only on the user's input.
import type { MemoryGraph, MemoryNode } from '@/lib/types';
import { Camera, type Pose } from './camera';
import { SceneCard } from './anchor';
import { CORE_COLOR, makePalette, starColor, THEMES, type Palette, type SkyColors } from './colors';
import { buildDust } from './dust';
import { LabelLayer } from './labels';
import { constellationAt, hash01, layoutUniverse, R, Slots, STAR_PULSAR, type Constellation, type Star, type UniverseLayout } from './layout';
import { advance, FrameWatch, IDLE_PACE, pickOrbits, WORK_PACE, type OrbitSession, type Phase } from './orbits';
import { compositeProgram, dustProgram, lineProgram, SPRITE_FLOATS, spriteProgram } from './shaders';

export interface UniverseEvents {
  onHover: (node: MemoryNode | null) => void;
  onOpen: (node: MemoryNode) => void;
  /** A project name badge got the pointer or focus. null when it left. */
  onBadge: (key: string | null, rect: DOMRect | null, viaKeyboard: boolean) => void;
  /** A right click on the core that was not a drag, or the menu key. Everywhere else the right button only moves the map. */
  onMenu: (x: number, y: number) => void;
}

const TAU = Math.PI * 2;
const LINE_FLOATS = 10; // a 3, b 3, rgba
const SLOP = 4;
const PAN_SLOP = 7;
const PAN_SPEED = 10;
const GLIDE_DECAY = 3.6; // per second: a thrown map coasts for about a second
const GLIDE_MIN_PX = 90; // px per second at the release: slower than this was a placed hand, not a throw
const GLIDE_STOP_PX = 6;
const GLIDE_STALE_MS = 70; // the hand stopped before it let go
const CORE_FLASH_S = 0.55;
const STATE_SPEED = 16; // highlight easing per second: settles within about 200 ms
const INACTIVE_ALPHA = 0.6; // a project without live sessions: the same colour, less opaque
const MAX_ORBITS = 3;
const TRAIL_SEGMENTS = 36;
const TRAIL_ARC = 1.9; // radians behind the head
const MIN_TRAIL_SEGMENTS = 8;
const TRAIL_SEGMENT_PX = 6; // a trail far away is a few pixels long: more pieces than this would not be seen
const CORE_PULSE_S = 1.6;
const MAX_PULSARS = 64;
const PULSE_ALPHA = 0.6;
const TIP_GAP = 20;
const STAR_FLOOR_FULL = 1.6; // px per world unit from which, closer, a star keeps its whole size on screen
const STAR_FLOOR_POWER = 1; // as fast as the distances between the stars shrink: any slower and a far cluster fills up with light
const STAR_FLOOR_PX = 2.2; // and the least it comes down to: under this its core falls between the pixels and twinkles as the camera moves
const LOOSE_LINK_ALPHA = 0.07; // a project's own link outside the figure
const FIGURE_ALPHA = 0.55;
const FAN_LINES = 2.2;
const SKELETON_ALPHA = 0.16;
const SPOKE_ALPHA = 0.24;
const CENTER_WORLD = 0.24; // a project's central star, of its constellation's radius
const CENTER_PX = 5.5; // and the least it comes down to: from afar a project is this one point of its colour
const CENTER_HIT_PX = 12;
const STAR_CENTER = 5; // the shader's branch for it, next to the note styles of layout.ts
const CROSS_ALPHA = 0.03; // barely there: lit on request, a hundred projects' worth of them is what turned the map into a hairball
const CROSS_ALPHA_LIT = 0.85;
const CROSS_COLOR = [0.72, 0.78, 0.92] as const;
const CROSS_COLOR_LIT = [1, 0.84, 0.6] as const;
const TETHER_ALPHA = 0.6;
const QUALITY_KEY = 'claude-os.universe-quality'; // 'full' switches off the software-rendering fallback
const MAX_MOONS = 8;
const MOON_WORLD = 9; // radius of a tiny satellite's circle around its session: in the world up close...
const MOON_PX = 16; // ...and on screen from afar, so it never merges with its session
const MOON_SPEED = 2.6;
const MOON_FADE = 3;
const MOON_TRAIL_SEGMENTS = 6;
const MOON_TRAIL_ARC = 1.5;
const CORE_HIT_PX = 18;
const NUCLEUS_WORLD = 26;
const NUCLEUS_PX = 12;
const MOVE_PX_PER_SEC = 640;
const MOVE_KEYS: Record<string, [number, number]> = {
  KeyW: [0, 1], ArrowUp: [0, 1],
  KeyS: [0, -1], ArrowDown: [0, -1],
  KeyA: [1, 0], ArrowLeft: [1, 0],
  KeyD: [-1, 0], ArrowRight: [-1, 0],
};
// The core's own instrument: thin circles in the plane of the disc, accent outside, its own light inside. Part of the scene, not data.
const CORE_RINGS = [
  { r: 1.1, segments: 96, color: [0.85, 0.47, 0.34], alpha: 0.36 },
  { r: 0.36, segments: 48, color: CORE_COLOR, alpha: 0.26 },
];

type Vec3 = [number, number, number];

/** A running subagent: a tiny satellite around its session's satellite. */
interface Moon {
  phase: number;
  alpha: number;
  goal: number;
  ax: Vec3;
  bx: Vec3;
}

interface RenderTarget {
  fb: WebGLFramebuffer;
  tex: WebGLTexture;
  w: number;
  h: number;
}

interface Orbit extends Phase {
  id: string;
  c: Constellation;
  /** Two axes of the orbit's plane, already scaled by its radius. */
  ax: Vec3;
  bx: Vec3;
  speed: number;
  color: Vec3;
  moons: Moon[];
}

export class Universe {
  static supported(canvas: HTMLCanvasElement): WebGL2RenderingContext | null {
    return canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: 'high-performance' });
  }

  private gl: WebGL2RenderingContext;
  private canvas: HTMLCanvasElement;
  private ev: UniverseEvents;
  private labels: LabelLayer;
  private sprite!: ReturnType<typeof spriteProgram>;
  private dust!: ReturnType<typeof dustProgram>;
  private line!: ReturnType<typeof lineProgram>;
  private composite!: ReturnType<typeof compositeProgram>;
  private haze: RenderTarget | null = null;
  private quad!: WebGLBuffer;
  private dustBuf!: WebGLBuffer;
  private nebulaBuf!: WebGLBuffer;
  private starBuf!: WebGLBuffer;
  private stateBuf!: WebGLBuffer;
  private styleBuf!: WebGLBuffer;
  private linkBuf!: WebGLBuffer;
  private dynSprite!: WebGLBuffer;
  private dustCount = 0;
  private nebulaCount = 0;
  private density = 1;
  private sky: SkyColors = THEMES.default;
  private crossLit = false;
  /** Stars that hold a link to another project, while those are lit. */
  private crossStars = new Set<number>();
  /** child project -> the project whose folder holds it. Empty unless nesting is switched on. */
  private parents = new Map<string, string>();
  private tethers: [Constellation, Constellation][] = [];

  private layout: UniverseLayout = { stars: [], constellations: [], links: [], skeleton: [], spokes: [] };
  private slots = new Slots();
  /** Stars whose note is gone, still fading out. They come after the real stars in `stars` and every buffer. */
  private ghosts: Star[] = [];
  private coreKey: string | null = null;
  private palette: Palette = makePalette([], null);
  private anchors = new Map<string | null, Constellation>();
  private signature = '';
  private camera: Camera;
  private home: Pose = { yaw: 0.5, pitch: 0.82, dist: 1500, x: 0, y: 0, z: 0 };
  private starFade = 0;

  // Per star: alpha and size. `state` eases to `target`.
  private state = new Float32Array(0);
  private target = new Float32Array(0);
  private linkData = new Float32Array(0);
  private stateMoving = false;

  private liveCounts = new Map<string, number>();
  private liveSessions = new Map<string, OrbitSession[]>();
  private projectSig = '';
  private highlight: Set<string> | null = null;
  private focusKey: string | null | undefined = undefined;
  private flown: Constellation | null = null;
  private selected: string | null = null;
  private hoverStar = -1;
  private emphasis: string | null | undefined = undefined;
  private emphasisGlow = 0;
  private orbits: Orbit[] = [];
  private spriteData = new Float32Array(SPRITE_FLOATS * 64);
  private trailData = new Float32Array(LINE_FLOATS * TRAIL_SEGMENTS * 12);
  private dynLine!: WebGLBuffer;
  // Everything but the satellites is drawn here once and copied to the screen: a moving dot does not redraw 50000 sprites.
  private scene: RenderTarget | null = null;
  private sceneDirty = true;
  // The dust and nebulae under the scene, which only the camera changes: lighting up a star does not redraw them either.
  private skyLayer: RenderTarget | null = null;
  private skyDirty = true;
  private halosSig = 0;

  private visible = true;
  /** A modal or a large panel is over the map: satellites wait, input still draws. */
  private covered = false;
  private fixedQuality = localStorage.getItem(QUALITY_KEY) === 'full';
  private frames = new FrameWatch();
  /** Stars that pulse. Only while the loop is running anyway: they rest in the scene as still pulsars and an idle map stays idle. */
  private pulsars: number[] = [];
  private pulseClock = 0;
  private corePulse = false;
  private tip: SceneCard | null = null;
  private card: SceneCard | null = null;
  private tipLine: HTMLElement;
  private cardLine: HTMLElement;
  private cardsMoving = false;
  private raf = 0;
  private last = 0;
  private reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  /** Reduced motion or no GPU: satellites rest on their orbits as plain dots. */
  private stillOrbits = this.reduce;
  private scale = 1;
  private dpr = 1;
  private W = 1;
  private H = 1;

  private drag: { x: number; y: number; moved: boolean; pan: boolean; label: HTMLElement | null; vx: number; vy: number; at: number } | null = null;
  /** Screen px per second a thrown map still moves by. */
  private glide: { vx: number; vy: number } | null = null;
  private coreFlash = 0;
  private pointer: { x: number; y: number } | null = null;
  private hoverNode: MemoryNode | null = null;
  private badge: HTMLElement | null = null;
  private ro: ResizeObserver;
  private ac = new AbortController();

  constructor(canvas: HTMLCanvasElement, gl: WebGL2RenderingContext, stage: HTMLElement, labelRoot: HTMLElement, ev: UniverseEvents) {
    this.canvas = canvas;
    this.gl = gl;
    this.ev = ev;
    this.labels = new LabelLayer(labelRoot);
    this.tipLine = labelRoot.parentElement!.appendChild(document.createElement('i'));
    this.cardLine = labelRoot.parentElement!.appendChild(document.createElement('i'));
    this.tipLine.className = 'u-leader';
    this.cardLine.className = 'u-leader';
    this.camera = new Camera(this.home);
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : '';
    // No GPU: fewer particles, lower resolution, no blur. Measured at about 1 fps with blur over a software canvas.
    if (/swiftshader|llvmpipe|software/i.test(renderer) && !this.fixedQuality) {
      this.density = 0.5;
      this.scale = 0.7;
      this.stillOrbits = true;
      document.documentElement.classList.add('glass-lite');
    }
    this.initGL();
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas);
    const opt = { signal: this.ac.signal };
    stage.addEventListener('pointerdown', this.onDown, opt);
    stage.addEventListener('pointermove', this.onMove, opt);
    stage.addEventListener('pointerup', this.onUp, opt);
    const release = () => {
      // A release the page never heard of (the window lost focus mid-press) must not leave the map thinking a button is down.
      if (this.drag?.moved) this.menuAnswered = true;
      this.drag = null;
    };
    stage.addEventListener('pointercancel', release, opt);
    stage.addEventListener('lostpointercapture', release, opt);
    stage.addEventListener('pointerleave', this.onLeave, opt);
    stage.addEventListener('wheel', this.onWheel, { signal: this.ac.signal, passive: false });
    stage.addEventListener('dblclick', this.onDouble, opt);
    // Right press pans, so the core's menu opens from onUp, once it is clear there was no drag. The app's menu host must not see this event.
    stage.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const label = (e.target as HTMLElement).closest<HTMLElement>('.u-label');
      // The menu key has no press to wait for and no pointer to look at: it asks for the map's menu, unless a project's badge has the focus
      // (its popover holds that project's own). Windows sends a right click's event after the release, others on the press:
      // a press still down decides on release, and a click that no release answered still counts.
      if (e.button !== 2) {
        if (label && !label.classList.contains('core')) return;
        const [x, y] = this.coreOnScreen();
        this.openMenu(x, y);
      } else if (!this.drag && !this.menuAnswered && this.onCore(e.clientX, e.clientY, label)) this.openMenu(e.clientX, e.clientY);
    }, opt);
    canvas.addEventListener('keydown', this.onKey, opt);
    window.addEventListener('keydown', this.onMoveKey, opt);
    window.addEventListener('keyup', (e) => this.held.delete(e.code), opt);
    window.addEventListener('blur', () => this.held.clear(), opt);
    labelRoot.addEventListener('focusin', this.onBadgeFocus, opt);
    labelRoot.addEventListener('focusout', () => this.ev.onBadge(null, null, true), opt);
    labelRoot.addEventListener('keydown', this.onBadgeKey, opt);
    document.addEventListener('visibilitychange', () => this.kick(), opt);
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }, opt);
    canvas.addEventListener('webglcontextrestored', () => {
      this.initGL();
      this.rebuildDust();
      this.rebuildBuffers();
      this.resize();
    }, opt);
    this.resize();
    this.applyHome();
    this.camera.goal = { ...this.home };
    this.camera.jump();
    this.rebuildDust();
    this.kick();
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.ro.disconnect();
    this.ac.abort();
    this.labels.reset();
    this.tipLine.remove();
    this.cardLine.remove();
  }

  // ---------- Data ----------

  /**
   * A refetch of the graph, whatever changed: no camera change, no rebuild of the scene.
   * Stars that stay keep their place and state, new ones fade in, gone ones fade out.
   */
  setGraph(graph: MemoryGraph) {
    const signature = `${graph.coreProject}#${graph.nodes.map((n) => `${n.id}:${n.project}`).sort().join('|')}#${graph.edges.map((e) => e.join('-')).sort().join('|')}`;
    if (signature === this.signature) {
      const byId = new Map(graph.nodes.map((n) => [n.id, n]));
      for (const s of this.layout.stars) s.node = byId.get(s.node.id) ?? s.node;
      return;
    }
    const first = this.signature === '';
    this.signature = signature;
    this.coreKey = graph.coreProject ?? null;

    const was = this.layout.stars;
    const wasState = this.state;
    const oldState = new Map(was.map((s, i) => [s.node.id, [wasState[i * 2], wasState[i * 2 + 1]]]));
    const next = layoutUniverse(graph, this.slots);
    // Constellations keep their identity: names on the map are tied to them.
    const known = new Map([...this.layout.constellations, ...this.anchors.values()].map((c) => [c.key, c]));
    next.constellations = next.constellations.map((c) => {
      const old = known.get(c.key);
      if (!old) return c;
      old.stars = c.stars;
      old.r = c.r;
      old.core = c.core;
      old.x = c.x;
      old.y = c.y;
      old.z = c.z;
      return old;
    });
    for (const c of next.constellations) this.anchors.delete(c.key);

    const ids = new Set(graph.nodes.map((n) => n.id));
    // Older ghosts first keeps them after the live stars; a note that came back stops being one.
    const ghosts = first ? [] : [...this.ghosts.filter((g) => !ids.has(g.node.id)), ...was.slice(0, was.length - this.ghosts.length).filter((s) => !ids.has(s.node.id))];
    ghosts.forEach((g) => (g.c = -1));
    this.ghosts = ghosts;
    next.stars = [...next.stars, ...ghosts];

    this.state = new Float32Array(next.stars.length * 2);
    next.stars.forEach((star, i) => {
      const old = oldState.get(star.node.id);
      this.state[i * 2] = old ? old[0] : 0;
      this.state[i * 2 + 1] = old ? old[1] : 1;
    });
    this.target = this.state.slice();
    this.layout = next;

    if (this.hoverStar >= 0) {
      const id = was[this.hoverStar]?.node.id;
      this.hoverStar = next.stars.findIndex((x) => x.node.id === id && x.c >= 0);
    }
    if (this.flown && !next.constellations.includes(this.flown) && ![...this.anchors.values()].includes(this.flown)) this.flown = null;
    if (first) this.starFade = 0;
    this.syncProjects();
    this.labels.pruneNotes(new Set(next.stars.filter((x) => x.c >= 0)));
    this.rebuildBuffers();
    this.retarget();
    this.kick();
  }

  setNames(names: (key: string | null) => string) {
    this.labels.setNames(names);
    this.kick();
  }

  /** Live sessions per project, the projects on the map (those without notes hold a place all the same), and every key the palette counts. */
  setProjects(live: Map<string, OrbitSession[]>, mapped: string[], colored: string[]) {
    this.liveSessions = live;
    const counts = [...live].map(([key, list]) => [key, list.length] as const).sort((a, b) => a[0].localeCompare(b[0]));
    const sig = JSON.stringify([counts, mapped, colored]);
    // A status or a subagent changed, nothing else: the satellites take it up, the scene stays as drawn.
    if (sig === this.projectSig) {
      this.buildOrbits();
      this.sizeOverlay();
      this.kick();
      return;
    }
    this.projectSig = sig;
    this.liveCounts = new Map(counts);
    this.mapped = mapped;
    this.colored = colored;
    this.syncProjects();
    this.rebuildBuffers();
    this.retarget();
    this.kick();
  }

  private mapped: string[] = [];
  private colored: string[] = [];
  private chosen: Record<string, string> = {};

  /** Colours chosen by hand. The stars are repainted only when one really changed. */
  setChosenColors(chosen: Record<string, string>) {
    if (JSON.stringify(chosen) === JSON.stringify(this.chosen)) return;
    this.chosen = chosen;
    this.syncProjects();
    this.rebuildBuffers();
    this.kick();
  }

  /** The look from the user's settings. Each part costs only when it changed. */
  setLook(sky: SkyColors, crossLit: boolean, parents: Map<string, string>) {
    if (JSON.stringify(sky) !== JSON.stringify(this.sky)) {
      this.sky = sky;
      this.rebuildDust();
    }
    const nesting = JSON.stringify([...parents]) !== JSON.stringify([...this.parents]);
    const cross = crossLit !== this.crossLit;
    if (nesting) {
      this.parents = parents;
      this.labels.setParents(parents);
    }
    this.crossLit = crossLit;
    if (nesting || cross) {
      this.rebuildBuffers();
      this.retarget();
    }
    this.kick();
  }

  /** Icons by project key as sanitized SVG text, and which of them are library icons. */
  setIcons(icons: Record<string, string>, chosen: Record<string, string>) {
    this.labels.setIcons(icons, chosen);
    this.kick();
  }

  private constellationOf(key: string | null): Constellation | undefined {
    const k = key ?? this.coreKey;
    return this.layout.constellations.find((c) => c.key === k) ?? this.anchors.get(k);
  }

  private allConstellations(): Constellation[] {
    return this.anchors.size ? [...this.layout.constellations, ...this.anchors.values()] : this.layout.constellations;
  }

  private syncProjects() {
    // Until the graph is here nobody takes a place: projects with notes choose first, whatever arrives first over the network.
    const wanted = new Set<string>(this.signature ? [...this.mapped, ...this.liveCounts.keys()] : []);
    const known = new Set(this.layout.constellations.map((c) => c.key));
    this.slots.placeAll([...wanted].filter((key) => !known.has(key) && key !== this.coreKey));
    for (const key of wanted) {
      if (!known.has(key) && !this.anchors.has(key)) this.anchors.set(key, constellationAt(key, key === this.coreKey, this.slots));
    }
    for (const key of this.anchors.keys()) if (!wanted.has(key!) || known.has(key)) this.anchors.delete(key);
    this.labels.prune(this.allConstellations());
    this.palette = makePalette([...this.colored, ...this.allConstellations().map((c) => c.key).filter((k): k is string => k !== null)], this.coreKey, this.chosen);
    this.labels.setLive(this.liveCounts, (key) => this.palette.css(key));
    this.buildOrbits();
    this.sizeOverlay();
    this.sceneDirty = true;
    // More projects than the disc holds: the general view backs off until it sees them all.
    const before = this.home.dist;
    this.applyHome();
    if (!this.flown && this.camera.goal.dist === before && before !== this.home.dist) {
      this.camera.goal.dist = this.home.dist;
      if (this.reduce || this.starFade === 0) this.camera.jump();
    }
  }

  private sizeOverlay() {
    const moons = this.orbits.reduce((n, o) => n + o.moons.length, 0);
    const sprites = this.allConstellations().length * 2 + this.orbits.length + moons + this.pulsars.length + 5;
    if (this.spriteData.length < sprites * SPRITE_FLOATS) this.spriteData = new Float32Array(sprites * 2 * SPRITE_FLOATS);
    const segments = (this.orbits.length * TRAIL_SEGMENTS + moons * MOON_TRAIL_SEGMENTS) * LINE_FLOATS;
    if (this.trailData.length < segments) this.trailData = new Float32Array(segments * 2);
  }

  // One satellite per live session, three at most. Each flies its own circle in its own tilted plane, stable by project
  // and number: seen from the camera these read as ellipses crossing in front of and behind the cluster.
  // A place on the orbits outlives the data: a satellite that stays keeps its phase and eases to its new pace.
  private buildOrbits() {
    const old = new Map(this.orbits.map((o) => [o.id, o]));
    this.orbits = [];
    for (const c of this.allConstellations()) {
      const key = c.key ?? '';
      const sessions = pickOrbits(this.liveSessions.get(key) ?? [], MAX_ORBITS);
      const dir = hash01(key, 62) < 0.5 ? 1 : -1;
      for (let i = 0; i < sessions.length; i++) {
        const radius = c.r * 1.16 + 14 + i * 15;
        const tilt = 0.42 + i * 0.3 + hash01(key, 63) * 0.14;
        const azimuth = hash01(key, 64) * TAU + (i * TAU) / 3;
        // The plane: one axis in the disc, the other lifted out of it by the tilt.
        const ux = Math.cos(azimuth);
        const uz = Math.sin(azimuth);
        const ct = Math.cos(tilt);
        const st = Math.sin(tilt);
        const id = `${key}|${i}`;
        const goal = sessions[i].working ? WORK_PACE : IDLE_PACE;
        const prior = old.get(id);
        const orbit: Orbit = {
          id,
          c,
          ax: [ux * radius, 0, uz * radius],
          bx: [-uz * ct * radius, st * radius, ux * ct * radius],
          phase: prior?.phase ?? hash01(key, 65) * TAU + (i * TAU) / 3 + i * 0.7,
          pace: prior && !this.stillOrbits ? prior.pace : goal,
          goal,
          speed: dir * 0.3 * Math.sqrt(90 / radius),
          color: this.palette.of(c.key),
          moons: prior?.moons ?? [],
        };
        this.syncMoons(orbit, Math.min(MAX_MOONS, sessions[i].subagents));
        this.orbits.push(orbit);
      }
    }
  }

  private syncMoons(o: Orbit, want: number) {
    const staying = o.moons.filter((m) => m.goal > 0);
    for (let i = want; i < staying.length; i++) staying[i].goal = 0;
    for (let i = staying.length; i < want; i++) {
      const salt = o.moons.length + i;
      const azimuth = hash01(o.id, 70 + salt) * TAU;
      const tilt = 0.5 + hash01(o.id, 90 + salt) * 0.8;
      const ux = Math.cos(azimuth);
      const uz = Math.sin(azimuth);
      o.moons.push({ phase: hash01(o.id, 110 + salt) * TAU, alpha: this.stillOrbits ? 1 : 0, goal: 1, ax: [ux, 0, uz], bx: [-uz * Math.cos(tilt), Math.sin(tilt), ux * Math.cos(tilt)] });
    }
    if (this.stillOrbits) o.moons = o.moons.filter((m) => m.goal > 0);
  }

  private stepOrbits(dt: number) {
    for (const o of this.orbits) {
      advance(o, o.speed, dt);
      for (const m of o.moons) {
        m.phase += Math.sign(o.speed) * MOON_SPEED * dt;
        m.alpha += (m.goal - m.alpha) * (1 - Math.exp(-dt * MOON_FADE));
      }
      if (o.moons.some((m) => m.goal === 0 && m.alpha < 0.01)) o.moons = o.moons.filter((m) => m.goal > 0 || m.alpha >= 0.01);
    }
  }

  private isActive(c: Constellation): boolean {
    return (this.liveCounts.get(c.key ?? '') ?? 0) > 0;
  }

  // ---------- Highlight ----------

  setHighlight(ids: Set<string> | null) {
    this.highlight = ids;
    this.retarget();
    this.kick();
  }

  /** Hovering a project in the list. undefined clears it. */
  setFocus(key: string | null | undefined) {
    this.focusKey = key;
    this.retarget();
    this.kick();
  }

  setSelected(id: string | null) {
    this.selected = id;
    this.retarget();
    this.kick();
  }

  /** While a project's name badge is hovered its satellites burn a little brighter. */
  setEmphasis(key: string | null | undefined) {
    if (this.emphasis === key) return;
    this.emphasis = key;
    this.kick();
  }

  private retarget() {
    const { stars, constellations } = this.layout;
    const hl = this.highlight;
    const focusing = this.focusKey !== undefined;
    const focused = focusing ? this.constellationOf(this.focusKey!) ?? null : null;
    const focusC = focused ? constellations.indexOf(focused) : -1;
    const hoverC = this.hoverStar >= 0 ? stars[this.hoverStar].c : -1;
    const t = this.target;
    for (let i = 0; i < stars.length; i++) {
      const s = stars[i];
      if (s.c < 0) {
        t[i * 2] = 0;
        t[i * 2 + 1] = 1;
        continue;
      }
      const base = this.isActive(constellations[s.c]) || constellations[s.c].core ? 1 : INACTIVE_ALPHA;
      let a = base;
      let z = 1;
      if (hl) {
        const on = hl.has(s.node.id);
        a = on ? 1.5 : 0.08;
        z = on ? 1.45 : 0.82;
      } else if (focusing) {
        const on = s.c === focusC;
        a = on ? 1.4 : base * 0.3;
        z = on ? 1.25 : 0.9;
      } else if (s.c === hoverC) {
        a = Math.min(1.3, base * 1.6);
      } else if (this.crossStars.has(i)) {
        a = 1.4;
        z = 1.3;
      }
      if (i === this.hoverStar || s.node.id === this.selected) {
        a = 1.7;
        z = Math.max(z, 1.4);
      }
      t[i * 2] = a;
      t[i * 2 + 1] = z;
    }
    this.stateMoving = true;
    this.sceneDirty = true;
    this.labels.setFocus(focused ?? this.flown, focusing || hl != null);
  }

  private easeStates(dt: number) {
    if (!this.stateMoving) return;
    const { state, target } = this;
    const f = this.reduce ? 1 : 1 - Math.exp(-dt * STATE_SPEED);
    let moving = false;
    for (let i = 0; i < state.length; i++) {
      const d = target[i] - state[i];
      if (Math.abs(d) < 0.002) state[i] = target[i];
      else {
        state[i] += d * f;
        moving = true;
      }
    }
    this.stateMoving = moving;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.stateBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, state);
    this.writeLinks();
    if (!moving && this.ghosts.length > 0) this.dropGhosts();
  }

  private dropGhosts() {
    const live = this.layout.stars.length - this.ghosts.length;
    this.layout.stars = this.layout.stars.slice(0, live);
    this.state = this.state.slice(0, live * 2);
    this.target = this.target.slice(0, live * 2);
    this.ghosts = [];
    this.rebuildBuffers();
  }

  // Real links are the bright lines; the skeleton of the same colour stays far behind them.
  private writeLinks() {
    const { links, skeleton, spokes, stars, constellations } = this.layout;
    const { state, linkData, palette } = this;
    const hover = this.hoverStar;
    const selected = this.selected;
    links.forEach((l, i) => {
      const o = i * LINE_FLOATS + 6;
      const a = Math.min(state[l.a * 2], state[l.b * 2]);
      const hot = l.a === hover || l.b === hover || (selected != null && (stars[l.a].node.id === selected || stars[l.b].node.id === selected));
      const c = !l.cross ? palette.of(constellations[stars[l.a].c].key) : this.crossLit ? CROSS_COLOR_LIT : CROSS_COLOR;
      linkData[o] = hot ? (c[0] + 1) / 2 : c[0];
      linkData[o + 1] = hot ? (c[1] + 1) / 2 : c[1];
      linkData[o + 2] = hot ? (c[2] + 1) / 2 : c[2];
      // A long line across a cluster would turn it into a hairball: the shorter the link, the brighter.
      const A = stars[l.a];
      const B = stars[l.b];
      const span = Math.hypot(A.x - B.x, A.z - B.z) / (2 * (constellations[A.c]?.r ?? 80));
      // A hub's many spokes share one budget of light: its seeds stay readable where each line at full strength would be a solid fan.
      const fan = Math.min(1, FAN_LINES / Math.sqrt(Math.max(A.node.degree, B.node.degree, 1)));
      const strength = l.cross ? (this.crossLit ? CROSS_ALPHA_LIT : CROSS_ALPHA) : l.tree ? FIGURE_ALPHA * Math.max(0.5, 1 - span * 0.6) * fan : LOOSE_LINK_ALPHA;
      // Negative: asked for by hand, so a short line on screen does not fade.
      linkData[o + 3] = hot ? -1 : l.cross && this.crossLit ? -strength * a : strength * a;
    });
    skeleton.forEach(([x, y], i) => {
      const o = (links.length + i) * LINE_FLOATS + 6;
      const c = palette.of(constellations[stars[x].c].key);
      linkData[o] = c[0];
      linkData[o + 1] = c[1];
      linkData[o + 2] = c[2];
      linkData[o + 3] = SKELETON_ALPHA * Math.min(state[x * 2], state[y * 2]);
    });
    spokes.forEach(([k, star], i) => {
      const o = (links.length + skeleton.length + i) * LINE_FLOATS + 6;
      const c = palette.of(constellations[k].key);
      linkData[o] = c[0];
      linkData[o + 1] = c[1];
      linkData[o + 2] = c[2];
      linkData[o + 3] = SPOKE_ALPHA * state[star * 2];
    });
    let o = (links.length + skeleton.length + spokes.length) * LINE_FLOATS + 6;
    const dimmed = this.highlight != null || (this.focusKey !== undefined && !this.constellationOf(this.focusKey)?.core);
    for (const ring of this.ringsDrawn()) {
      for (let i = 0; i < ring.segments; i++, o += LINE_FLOATS) {
        linkData[o] = ring.color[0];
        linkData[o + 1] = ring.color[1];
        linkData[o + 2] = ring.color[2];
        linkData[o + 3] = -ring.alpha * (dimmed ? 0.3 : 1);
      }
    }
    for (const [parent] of this.tethers) {
      const c = palette.of(parent.key);
      linkData[o] = c[0];
      linkData[o + 1] = c[1];
      linkData[o + 2] = c[2];
      linkData[o + 3] = -TETHER_ALPHA * (dimmed ? 0.3 : 1);
      o += LINE_FLOATS;
    }
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.linkBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, linkData);
  }

  // ---------- Camera ----------

  private applyHome() {
    const aspect = this.W / Math.max(1, this.H);
    // The disc of constellations spans the free middle of the window, the dust runs on past its edges.
    const far = this.allConstellations().reduce((max, c) => Math.max(max, Math.hypot(c.x, c.z)), R);
    this.home.dist = (far * (far > R ? 3.2 : 2.85)) / Math.min(1.25, Math.max(0.8, aspect / 1.6));
  }

  /** Back to the whole galaxy. */
  resetView() {
    this.flown = null;
    this.glide = null;
    this.camera.goal = { ...this.home };
    this.camera.speed = 5;
    if (this.reduce) this.camera.jump();
    this.retarget();
    this.kick();
  }

  /** Fly to a project. Returns false if it has no place on the map. */
  flyTo(key: string | null): boolean {
    const c = this.constellationOf(key);
    if (!c) return false;
    this.flown = c;
    this.glide = null;
    const dist = Math.max(170, (c.r * 1.25 * this.camera.pxPerWorld) / (this.H * 0.28));
    this.camera.goal = { ...this.camera.goal, x: c.x, y: c.y, z: c.z, dist, pitch: Math.max(0.95, this.camera.goal.pitch) };
    this.camera.speed = 4.6;
    if (this.reduce) this.camera.jump();
    this.retarget();
    this.kick();
    return true;
  }

  zoomBy(factor: number) {
    this.glide = null;
    this.camera.speed = 7;
    this.camera.goal.dist = this.clampDist(this.camera.goal.dist * factor);
    if (this.reduce) this.camera.jump();
    this.kick();
  }

  private clampDist(d: number) {
    return Math.max(60, Math.min(Math.max(R * 6, this.home.dist * 1.6), d));
  }

  // ---------- Visibility and size ----------

  /** Off Home the last frame stays on screen and nothing runs. */
  setVisible(v: boolean) {
    this.visible = v;
    // Nothing is under the pointer any more: coming back must not find a card from before.
    if (!v) this.clearHover();
    if (v) this.resize();
    this.kick();
  }

  setCovered(v: boolean) {
    if (v && !this.covered) this.clearHover();
    this.covered = v;
    this.kick();
  }

  private resize() {
    const b = this.canvas.getBoundingClientRect();
    if (b.width === 0 || b.height === 0) return;
    this.dpr = Math.min(devicePixelRatio || 1, 2);
    this.W = b.width;
    this.H = b.height;
    const k = this.dpr * this.scale;
    this.canvas.width = Math.max(1, Math.round(b.width * k));
    this.canvas.height = Math.max(1, Math.round(b.height * k));
    this.camera.width = this.W;
    this.camera.height = this.H;
    const before = this.home.dist;
    this.applyHome();
    if (!this.flown && this.camera.goal.dist === before) {
      this.camera.goal.dist = this.home.dist;
      this.camera.now.dist = this.home.dist;
    }
    this.camera.compute();
    this.sceneDirty = true;
    this.drawnPose = null;
    this.kick();
  }

  private kick() {
    if (this.raf || document.hidden) return;
    this.raf = requestAnimationFrame(this.frame);
  }

  private frame = (now: number) => {
    this.raf = 0;
    if (document.hidden) return;
    const orbiting = this.visible && !this.covered && !this.stillOrbits && this.orbits.length > 0;
    // Re-blurring glass over a moving canvas is the first thing to give up when the GPU falls behind.
    if (this.last && !this.fixedQuality && this.scale === 1 && this.frames.add(now - this.last)) document.documentElement.classList.add('glass-lite');
    const elapsed = this.last ? (now - this.last) / 1000 : 1 / 60;
    const dt = Math.min(0.05, elapsed);
    this.last = now;
    const pointerMoved = this.pointerMoved;
    this.pointerMoved = false;
    // Off Home there is one still frame to draw: it has to show the finished picture.
    if (!this.visible) {
      this.starFade = 1;
      this.camera.jump();
    }
    const pulsing = this.visible && !this.covered && !this.stillOrbits && this.corePulse;
    if (orbiting) this.stepOrbits(dt);
    this.stepMoveKeys(dt);
    this.stepGlide(dt);
    if (this.coreFlash > 0) this.coreFlash = Math.max(0, this.coreFlash - elapsed / CORE_FLASH_S);
    this.cameraMoving = this.camera.step(dt);
    // Real time, not the capped step: every step redraws the scene, so a slow GPU must not get more of them.
    if (this.starFade < 1) this.starFade = this.reduce ? 1 : Math.min(1, this.starFade + elapsed * 1.6);
    const glow = this.emphasis !== undefined ? 1 : 0;
    this.emphasisGlow += (glow - this.emphasisGlow) * (this.reduce ? 1 : 1 - Math.exp(-dt * 10));
    // Compared, not inferred: with reduced motion the camera jumps and never counts as moving.
    const pose = this.camera.now;
    const moved = this.cameraMoving || !this.drawnPose || (['yaw', 'pitch', 'dist', 'x', 'y', 'z'] as const).some((f) => pose[f] !== this.drawnPose![f]);
    if (moved) {
      this.skyDirty = true;
      this.drawnPose = { ...pose };
    }
    if (moved || this.stateMoving || this.starFade < 1) this.sceneDirty = true;
    this.easeStates(dt);
    // Stars stand still under a resting pointer and camera: nothing to look for.
    // Only the pointer changes what is hovered: when the camera moves the object keeps its card, and the card follows it.
    if (pointerMoved) this.pick();
    if (this.visible) this.pulseClock += dt;
    this.draw();
    if (this.visible) {
      this.labels.update(this.camera, this.allConstellations(), this.layout.stars, now, moved);
      if (moved || this.cardsMoving || this.cardsNew) this.stepCards(dt);
    }

    if (this.visible && (orbiting || pulsing || this.cameraMoving || this.stateMoving || this.starFade < 1 || this.held.size > 0 || this.cardsMoving || this.glide || this.coreFlash > 0)) this.raf = requestAnimationFrame(this.frame);
    else this.last = 0;
  };

  private cardsNew = false;

  private stepCards(dt: number) {
    this.cardsNew = false;
    const tip = this.tip?.step(this.camera, dt) ?? false;
    const card = this.card?.step(this.camera, dt) ?? false;
    this.cardsMoving = tip || card;
  }

  /** The root session is making changes: the nucleus pulses for as long as it does, and the loop rests again after. */
  setCorePulse(on: boolean) {
    if (on === this.corePulse) return;
    this.corePulse = on;
    this.kick();
  }

  /** The hover card of a star: the element comes from React, its place from here. */
  anchorTip(el: HTMLElement | null) {
    this.tip?.destroy();
    this.tip = null;
    const s = this.hoverStar >= 0 ? this.layout.stars[this.hoverStar] : null;
    if (el && s) {
      this.tip = new SceneCard(el, this.tipLine, {
        x: s.x,
        y: s.y,
        z: s.z,
        goal: (sx, sy, w, h) => [sx + TIP_GAP + w > this.camera.width ? sx - TIP_GAP - w : sx + TIP_GAP, sy - TIP_GAP - h < 0 ? sy + TIP_GAP : sy - TIP_GAP - h],
      }, this.reduce);
    }
    this.cardsNew = true;
    this.kick();
  }

  /** A project's card, opened from its badge: it stays where layout put it relative to the badge and travels with the constellation. */
  anchorCard(el: HTMLElement | null, key: string | null) {
    this.card?.destroy();
    this.card = null;
    const c = el ? this.constellationOf(key) : undefined;
    if (el && c) {
      const box = el.getBoundingClientRect();
      const at = this.camera.project(c.x, c.y, c.z);
      this.card = new SceneCard(el, this.cardLine, {
        x: c.x,
        y: c.y,
        z: c.z,
        goal: (sx, sy) => [box.left + sx - at.sx, box.top + sy - at.sy],
      }, this.reduce, 0.5);
    }
    this.cardsNew = true;
    this.kick();
  }

  private cameraMoving = false;
  private drawnPose: Pose | null = null;
  private pointerMoved = false;
  private held = new Set<string>();

  // ---------- GL ----------

  private initGL() {
    const gl = this.gl;
    this.sprite = spriteProgram(gl);
    this.dust = dustProgram(gl);
    this.line = lineProgram(gl);
    this.composite = compositeProgram(gl);
    this.haze = null;
    this.quad = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    this.dustBuf = gl.createBuffer()!;
    this.nebulaBuf = gl.createBuffer()!;
    this.starBuf = gl.createBuffer()!;
    this.stateBuf = gl.createBuffer()!;
    this.styleBuf = gl.createBuffer()!;
    this.linkBuf = gl.createBuffer()!;
    this.dynSprite = gl.createBuffer()!;
    this.dynLine = gl.createBuffer()!;
    this.scene = null;
    this.skyLayer = null;
    this.sceneDirty = true;
    this.skyDirty = true;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.disable(gl.DEPTH_TEST);
    gl.clearColor(0, 0, 0, 1);
  }

  private rebuildDust() {
    const { dust, nebula } = buildDust(R, this.density, this.sky);
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.dustBuf);
    gl.bufferData(gl.ARRAY_BUFFER, dust, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.nebulaBuf);
    gl.bufferData(gl.ARRAY_BUFFER, nebula, gl.STATIC_DRAW);
    this.dustCount = dust.length / SPRITE_FLOATS;
    this.nebulaCount = nebula.length / SPRITE_FLOATS;
    this.skyDirty = true;
    this.sceneDirty = true;
  }

  private rebuildBuffers() {
    const { stars, links, skeleton, spokes, constellations } = this.layout;
    const gl = this.gl;
    const data = new Float32Array(stars.length * SPRITE_FLOATS);
    const styles = new Float32Array(stars.length * 2);
    stars.forEach((s, i) => {
      const o = i * SPRITE_FLOATS;
      const owner = constellations[s.c] ?? null; // null: a ghost, fading out in the colour it had
      const c = starColor(owner ? this.palette.of(owner.key) : this.palette.of(s.node.project ?? this.coreKey), s.node.id);
      // A note outside the vault is read only: its project's colour, washed toward cold steel.
      const wash = s.node.connected ? 0 : 0.28;
      const big = owner?.core ? 1.15 : 1;
      styles[i * 2] = s.style;
      styles[i * 2 + 1] = owner ? owner.stars.length / (Math.PI * owner.r * owner.r) : 0;
      data.set([s.x, s.y, s.z, 2.3 * s.k * big, 11.5 * s.k * big, c[0] * (1 - wash) + 0.72 * wash, c[1] * (1 - wash) + 0.8 * wash, c[2] * (1 - wash) + wash, 1], o);
    });
    gl.bindBuffer(gl.ARRAY_BUFFER, this.starBuf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.stateBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.state, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.styleBuf);
    gl.bufferData(gl.ARRAY_BUFFER, styles, gl.STATIC_DRAW);
    this.pulsars = stars.flatMap((s, i) => (s.style === STAR_PULSAR && s.c >= 0 ? [i] : [])).sort((a, b) => stars[b].node.degree - stars[a].node.degree || a - b).slice(0, MAX_PULSARS);
    this.sizeOverlay();

    this.crossStars = new Set(this.crossLit ? links.filter((l) => l.cross).flatMap((l) => [l.a, l.b]) : []);
    const all = this.allConstellations();
    this.tethers = [...this.parents].flatMap(([child, parent]) => {
      const a = all.find((c) => c.key === parent);
      const b = all.find((c) => c.key === child);
      return a && b ? [[a, b] as [Constellation, Constellation]] : [];
    });
    const rings = this.ringsDrawn();
    this.linkData = new Float32Array((links.length + skeleton.length + spokes.length + rings.reduce((n, r) => n + r.segments, 0) + this.tethers.length) * LINE_FLOATS);
    const place = (a: number, b: number, i: number) => {
      const A = stars[a];
      const B = stars[b];
      this.linkData.set([A.x, A.y, A.z, B.x, B.y, B.z], i * LINE_FLOATS);
    };
    links.forEach((l, i) => place(l.a, l.b, i));
    skeleton.forEach(([a, b], i) => place(a, b, links.length + i));
    spokes.forEach(([k, star], i) => {
      const c = constellations[k];
      const S = stars[star];
      this.linkData.set([c.x, c.y, c.z, S.x, S.y, S.z], (links.length + skeleton.length + i) * LINE_FLOATS);
    });
    const core = constellations.find((c) => c.core);
    let at = links.length + skeleton.length + spokes.length;
    for (const ring of rings) {
      const r = core!.r * ring.r;
      for (let i = 0; i < ring.segments; i++, at++) {
        const a = (i / ring.segments) * TAU;
        const b = ((i + 1) / ring.segments) * TAU;
        this.linkData.set([core!.x + Math.cos(a) * r, core!.y, core!.z + Math.sin(a) * r, core!.x + Math.cos(b) * r, core!.y, core!.z + Math.sin(b) * r], at * LINE_FLOATS);
      }
    }
    for (const [a, b] of this.tethers) this.linkData.set([a.x, a.y, a.z, b.x, b.y, b.z], at++ * LINE_FLOATS);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.linkBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.linkData, gl.DYNAMIC_DRAW);
    this.writeLinks();
    this.sceneDirty = true;
  }

  private ringsDrawn() {
    return this.layout.constellations.some((c) => c.core) ? CORE_RINGS : [];
  }

  private canvasTarget(old: RenderTarget | null, rw: number, rh: number): RenderTarget | null {
    const gl = this.gl;
    if (old && old.w === rw && old.h === rh) return old;
    if (old) {
      gl.deleteFramebuffer(old.fb);
      gl.deleteTexture(old.tex);
    }
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, rw, rh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    const fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.sceneDirty = true;
    this.skyDirty = true;
    return ok ? { fb, tex, w: rw, h: rh } : null;
  }

  private hazeTarget(rw: number, rh: number) {
    const gl = this.gl;
    const w = Math.max(2, Math.round(rw / 4));
    const h = Math.max(2, Math.round(rh / 4));
    if (this.haze && this.haze.w === w && this.haze.h === h) return this.haze;
    if (this.haze) {
      gl.deleteFramebuffer(this.haze.fb);
      gl.deleteTexture(this.haze.tex);
      this.haze = null;
    }
    const float = !!gl.getExtension('EXT_color_buffer_float') || !!gl.getExtension('EXT_color_buffer_half_float');
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (float) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (!ok) return null;
    this.haze = { fb, tex, w, h };
    return this.haze;
  }

  private bindSprites(buf: WebGLBuffer, offset: number, state: WebGLBuffer | null, style: WebGLBuffer | null = null, oneStyle = 0) {
    const gl = this.gl;
    const stride = SPRITE_FLOATS * 4;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    const attr = (loc: number, size: number, at: number) => {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset + at);
      gl.vertexAttribDivisor(loc, 1);
    };
    attr(1, 3, 0);
    attr(2, 1, 12);
    attr(3, 1, 16);
    attr(4, 4, 20);
    if (state) {
      gl.bindBuffer(gl.ARRAY_BUFFER, state);
      gl.enableVertexAttribArray(5);
      gl.vertexAttribPointer(5, 2, gl.FLOAT, false, 0, 0);
      gl.vertexAttribDivisor(5, 1);
    } else {
      gl.disableVertexAttribArray(5);
      gl.vertexAttrib2f(5, 1, 1);
    }
    if (style) {
      gl.bindBuffer(gl.ARRAY_BUFFER, style);
      gl.enableVertexAttribArray(6);
      gl.vertexAttribPointer(6, 2, gl.FLOAT, false, 0, 0);
      gl.vertexAttribDivisor(6, 1);
    } else {
      gl.disableVertexAttribArray(6);
      gl.vertexAttrib2f(6, oneStyle, 0);
    }
  }

  private bindQuad() {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(0, 0);
  }

  private draw() {
    const gl = this.gl;
    const rw = this.canvas.width;
    const rh = this.canvas.height;
    const scene = (this.scene = this.canvasTarget(this.scene, rw, rh));
    const k = this.dpr * this.scale;
    if (this.sceneDirty || !scene) {
      this.drawScene(scene?.fb ?? null, rw, rh, k);
      this.sceneDirty = false;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, rw, rh);
    if (scene) {
      // Before the copy, not out of habit: the browser clears a composited canvas at its first draw or clear of the next frame, and a blit does not count as either. Without this the first sprite of the overlay would wipe the copy.
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      this.blit(scene, null);
    }
    this.drawOverlay(rw, rh, k);
  }

  private bindLines(buf: WebGLBuffer) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    const attr = (loc: number, size: number, at: number) => {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, LINE_FLOATS * 4, at);
      gl.vertexAttribDivisor(loc, 1);
    };
    attr(1, 3, 0);
    attr(2, 3, 12);
    attr(3, 4, 24);
    gl.disableVertexAttribArray(4);
    gl.disableVertexAttribArray(5);
    gl.disableVertexAttribArray(6);
  }

  private setSpriteView(w: number, h: number, kk: number) {
    const gl = this.gl;
    gl.viewport(0, 0, w, h);
    gl.uniform2f(this.sprite.res, w, h);
    gl.uniform1f(this.sprite.px, this.camera.pxPerWorld * kk);
    gl.uniform1f(this.sprite.scale, kk);
  }

  /** The part of the picture that the camera or a project's patch of colour changes: nebulae and dust. */
  private drawSky(target: WebGLFramebuffer | null, rw: number, rh: number, k: number, dyn: { halos: number }) {
    const gl = this.gl;
    const { camera, sprite } = this;
    const [r, g, b] = this.sky.bg;
    gl.useProgram(sprite.p);
    gl.uniformMatrix4fv(sprite.vp, false, camera.viewProj);
    gl.uniform1f(sprite.fade, 1);
    gl.uniform1f(sprite.floor, 1);
    gl.uniform1f(sprite.floorMin, 0);
    this.bindQuad();
    // The haze is huge and soft: a quarter of the resolution is enough.
    const haze = this.hazeTarget(rw, rh);
    gl.bindFramebuffer(gl.FRAMEBUFFER, haze?.fb ?? target);
    this.setSpriteView(haze?.w ?? rw, haze?.h ?? rh, haze ? k * (haze.w / rw) : k);
    if (haze) gl.clearColor(0, 0, 0, 0);
    else gl.clearColor(r, g, b, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform1i(sprite.shape, 1);
    this.bindSprites(this.nebulaBuf, 0, null);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.nebulaCount);
    // The soft patch of each constellation's colour, in the same haze: a second one and its copy would take a quarter of the frame.
    if (dyn.halos > 0) {
      this.bindSprites(this.dynSprite, 0, null);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, dyn.halos);
    }
    if (haze) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, target);
      gl.viewport(0, 0, rw, rh);
      gl.clearColor(r, g, b, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      this.copyTexture(haze.tex, 1.5 / 255);
      gl.viewport(0, 0, rw, rh);
    }
    this.drawDust(k);
  }

  private drawDust(k: number) {
    const gl = this.gl;
    const { dust } = this;
    gl.useProgram(dust.p);
    gl.uniformMatrix4fv(dust.vp, false, this.camera.viewProj);
    gl.uniform1f(dust.scale, k);
    gl.uniform1f(dust.fade, Math.max(0.16, this.farOut ** 1.5));
    for (const loc of [0, 2, 5, 6]) gl.disableVertexAttribArray(loc);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.dustBuf);
    const stride = SPRITE_FLOATS * 4;
    for (const [loc, size, at] of [[1, 3, 0], [3, 1, 16], [4, 4, 20]]) {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, at);
      gl.vertexAttribDivisor(loc, 0);
    }
    gl.drawArrays(gl.POINTS, 0, this.dustCount);
  }

  /** How much of a star's fixed size in px is left at this distance. Close up all of it. */
  private get starFloor() {
    return Math.min(1, ((this.camera.pxPerWorld / this.camera.now.dist) / STAR_FLOOR_FULL) ** STAR_FLOOR_POWER);
  }

  /** A plain copy, the cheapest there is: drawing it as a full-screen quad cost more than a whole frame's worth of stars on a weak GPU. */
  private blit(from: RenderTarget, target: WebGLFramebuffer | null) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, from.fb);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, target);
    gl.blitFramebuffer(0, 0, from.w, from.h, 0, 0, from.w, from.h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target);
  }

  /** Backing away from a big map: 1 at the usual distance and closer, then less. Fixed-size sprites would otherwise melt into white. */
  private get farOut() {
    return Math.min(1, (R * 2.85) / this.camera.now.dist);
  }

  private copyTexture(tex: WebGLTexture, noise: number) {
    const gl = this.gl;
    gl.useProgram(this.composite.p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(this.composite.tex, 0);
    gl.uniform1f(this.composite.noise, noise);
    for (let loc = 0; loc < 7; loc++) gl.disableVertexAttribArray(loc);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /** The part of the picture that stands still until the camera or the data changes. */
  private drawScene(target: WebGLFramebuffer | null, rw: number, rh: number, k: number) {
    const gl = this.gl;
    const { camera, sprite, line } = this;
    const dyn = this.buildStatic();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.dynSprite);
    gl.bufferData(gl.ARRAY_BUFFER, this.spriteData.subarray(0, dyn.total * SPRITE_FLOATS), gl.DYNAMIC_DRAW);
    const skyLayer = (this.skyLayer = this.canvasTarget(this.skyLayer, rw, rh));
    if (this.skyDirty || !skyLayer || dyn.halosSig !== this.halosSig) {
      this.drawSky(skyLayer?.fb ?? target, rw, rh, k, dyn);
      this.skyDirty = false;
      this.halosSig = dyn.halosSig;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, target);
    gl.viewport(0, 0, rw, rh);
    if (skyLayer) this.blit(skyLayer, target);
    // Screen instead of a plain sum: light over light tends to white and never clips into a flat blot.
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_COLOR);

    gl.useProgram(sprite.p);
    gl.uniformMatrix4fv(sprite.vp, false, camera.viewProj);
    gl.uniform1f(sprite.fade, 1);
    gl.uniform1f(sprite.floor, 1);
    gl.uniform1f(sprite.floorMin, 0);
    this.bindQuad();
    this.setSpriteView(rw, rh, k);

    // Links and skeleton.
    const lineCount = this.linkData.length / LINE_FLOATS;
    if (lineCount > 0) {
      gl.useProgram(line.p);
      gl.uniformMatrix4fv(line.vp, false, camera.viewProj);
      gl.uniform2f(line.res, rw, rh);
      gl.uniform1f(line.width, 1.15 * k);
      gl.uniform1f(line.gap, 0.08);
      this.bindQuad();
      this.bindLines(this.linkBuf);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, lineCount);
      gl.useProgram(sprite.p);
      this.bindQuad();
    }

    // Stars and the markers of empty projects.
    gl.uniform1f(sprite.fade, this.starFade * Math.max(0.9, this.farOut));
    gl.uniform1i(sprite.shape, 2);
    if (this.layout.stars.length > 0) {
      gl.uniform1f(sprite.floor, this.starFloor);
      gl.uniform1f(sprite.floorMin, STAR_FLOOR_PX);
      this.bindSprites(this.starBuf, 0, this.stateBuf, this.styleBuf);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.layout.stars.length);
      gl.uniform1f(sprite.floor, 1);
      gl.uniform1f(sprite.floorMin, 0);
    }
    gl.uniform1f(sprite.fade, 1);
    if (dyn.markers > 0) {
      this.bindSprites(this.dynSprite, dyn.halos * SPRITE_FLOATS * 4, null, null, STAR_CENTER);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, dyn.markers);
    }
    gl.blendFunc(gl.ONE, gl.ONE);
  }

  private buildStatic() {
    const d = this.spriteData;
    let o = 0;
    const all = this.allConstellations();
    const focused = this.focusKey !== undefined ? this.constellationOf(this.focusKey) : undefined;
    const dimmed = (c: Constellation) => (focused !== undefined && c !== focused) || this.highlight != null;
    const put = (x: number, y: number, z: number, size: number, px: number, col: readonly number[], a: number) => {
      d.set([x, y, z, size, px, col[0], col[1], col[2], a], o);
      o += SPRITE_FLOATS;
    };
    let halos = 0;
    let halosSig = 0;
    for (const c of all) {
      const base = c.core ? 0.2 : this.isActive(c) ? 0.2 : 0.13;
      const a = (c === focused ? 0.26 : base) * (dimmed(c) ? 0.3 : 1) * this.starFade;
      put(c.x, c.y, c.z, c.r * 2.1, 0, this.palette.of(c.key), a);
      halos++;
      halosSig = (halosSig * 31 + a * 1e4 + c.r + this.palette.of(c.key)[0] * 1e3) % 1e9;
    }
    // Every project has its central star, with notes or without: the visual centre of the project and what answers for it.
    let markers = 0;
    for (const c of all) {
      // The nucleus: the brightest thing on the map, always lit. The core is the object here, not a marker of it.
      if (c.core) put(c.x, c.y, c.z, NUCLEUS_WORLD, NUCLEUS_PX, CORE_COLOR, dimmed(c) ? 0.45 : 1.2);
      else put(c.x, c.y, c.z, c.r * CENTER_WORLD, CENTER_PX, this.palette.of(c.key), (this.isActive(c) ? 1 : INACTIVE_ALPHA + 0.2) * (dimmed(c) ? 0.3 : 1));
      markers++;
    }
    return { halos, halosSig, markers, total: halos + markers };
  }

  /** Satellites and rings, on top of the copied scene. A few dozen quads. */
  private drawOverlay(rw: number, rh: number, k: number) {
    const gl = this.gl;
    const { camera, sprite, line } = this;
    const d = this.spriteData;
    let o = 0;
    let segments = 0;
    let heads = 0;
    const L = this.trailData;
    const moving = !this.stillOrbits;
    const dim = this.highlight != null || this.focusKey !== undefined;
    const emphasized = this.emphasis !== undefined ? this.constellationOf(this.emphasis) : undefined;
    const focused = this.focusKey !== undefined ? this.constellationOf(this.focusKey) : undefined;
    const W = camera.width;
    const H = camera.height;
    for (const orb of this.orbits) {
      const { c, ax, bx, color } = orb;
      const centre = camera.depth(c.x, c.y, c.z);
      const radius = Math.hypot(ax[0], ax[1], ax[2]);
      if (centre > 0) {
        // Off screen, orbit and all: no point working out its trail.
        const p = camera.project(c.x, c.y, c.z);
        const reach = (radius * camera.pxPerWorld) / centre + 8;
        if (p.sx < -reach || p.sx > W + reach || p.sy < -reach || p.sy > H + reach) continue;
      }
      const atX = (cos: number, sin: number) => c.x + ax[0] * cos + bx[0] * sin;
      const atY = (cos: number, sin: number) => c.y + ax[1] * cos + bx[1] * sin;
      const atZ = (cos: number, sin: number) => c.z + ax[2] * cos + bx[2] * sin;
      // Far side of the orbit: dimmer, as if behind the cluster. Near side: full.
      const nearness = (w: number) => 0.34 + 0.66 * Math.min(1, Math.max(0, 0.5 - (w - centre) / (2 * radius)));
      const own = emphasized === c;
      const lift = own ? 1 + 0.6 * this.emphasisGlow : 1;
      const quiet = dim && !own && focused !== c ? 0.25 : 1;
      const angle = orb.phase;
      const pace = Math.min(1, Math.max(0, (orb.pace - IDLE_PACE) / (WORK_PACE - IDLE_PACE)));
      const headCos = Math.cos(angle);
      const headSin = Math.sin(angle);
      const head: Vec3 = [atX(headCos, headSin), atY(headCos, headSin), atZ(headCos, headSin)];
      const headW = camera.depth(head[0], head[1], head[2]);
      if (moving) {
        // The trail: a soft arc behind the head, its strength falling off with distance.
        const arc = TRAIL_ARC * (0.35 + 0.65 * pace);
        const px = centre > 0 ? (radius * camera.pxPerWorld * arc) / centre : 0;
        const pieces = Math.min(TRAIL_SEGMENTS, Math.max(MIN_TRAIL_SEGMENTS, Math.round(px / TRAIL_SEGMENT_PX)));
        const back = -Math.sign(orb.speed) * (arc / pieces);
        let px0 = head[0];
        let py0 = head[1];
        let pz0 = head[2];
        for (let i = 0; i < pieces; i++) {
          const t = angle + back * (i + 1);
          const cos = Math.cos(t);
          const sin = Math.sin(t);
          const x = atX(cos, sin);
          const y = atY(cos, sin);
          const z = atZ(cos, sin);
          const fade = (1 - i / pieces) ** 1.7;
          const a = fade * nearness(camera.depth(x, y, z)) * lift * quiet;
          const j = segments * LINE_FLOATS;
          L[j] = px0;
          L[j + 1] = py0;
          L[j + 2] = pz0;
          L[j + 3] = x;
          L[j + 4] = y;
          L[j + 5] = z;
          L[j + 6] = color[0];
          L[j + 7] = color[1];
          L[j + 8] = color[2];
          L[j + 9] = -a;
          segments++;
          px0 = x;
          py0 = y;
          pz0 = z;
        }
      }
      // From afar a satellite comes down with the map: at its full size it would outshine the star it flies around.
      const far = 0.5 + 0.5 * this.starFloor;
      d.set([head[0], head[1], head[2], 0, (moving ? (9 + 3 * pace) * lift : 6.5 + 1.5 * pace) * far, color[0], color[1], color[2], (0.55 + 0.45 * nearness(headW)) * 1.25 * quiet], o);
      o += SPRITE_FLOATS;
      heads++;
      // Tiny satellites keep their distance on screen, whatever the zoom.
      orb.moons.forEach((m, j) => {
        const r = Math.max(MOON_WORLD, (MOON_PX * headW) / camera.pxPerWorld) * (1 + j * 0.26);
        const around = (t: number): Vec3 => {
          const cos = Math.cos(t) * r;
          const sin = Math.sin(t) * r;
          return [head[0] + m.ax[0] * cos + m.bx[0] * sin, head[1] + m.ax[1] * cos + m.bx[1] * sin, head[2] + m.ax[2] * cos + m.bx[2] * sin];
        };
        const pos = around(m.phase);
        const light = [(color[0] + 1) / 2, (color[1] + 1) / 2, (color[2] + 1) / 2];
        if (moving) {
          let prev = pos;
          for (let i = 0; i < MOON_TRAIL_SEGMENTS; i++) {
            const cur = around(m.phase - Math.sign(orb.speed) * (MOON_TRAIL_ARC / MOON_TRAIL_SEGMENTS) * (i + 1));
            L.set([prev[0], prev[1], prev[2], cur[0], cur[1], cur[2], light[0], light[1], light[2], -0.7 * (1 - i / MOON_TRAIL_SEGMENTS) * m.alpha * quiet], segments * LINE_FLOATS);
            segments++;
            prev = cur;
          }
        }
        d.set([pos[0], pos[1], pos[2], 0, (moving ? 7.5 * lift : 5) * far, light[0], light[1], light[2], m.alpha * quiet], o);
        o += SPRITE_FLOATS;
        heads++;
      });
    }

    if (moving && this.corePulse) {
      const core = this.layout.constellations.find((c) => c.core);
      if (core) {
        const wave = 0.5 + 0.5 * Math.sin((this.pulseClock / CORE_PULSE_S) * TAU);
        d.set([core.x, core.y, core.z, 26 + 16 * wave, 12 + 10 * wave, CORE_COLOR[0], CORE_COLOR[1], CORE_COLOR[2], 0.25 + 0.75 * wave], o);
        o += SPRITE_FLOATS;
        heads++;
      }
    }

    // The answer to a click on the core: one soft wave from the nucleus.
    if (this.coreFlash > 0) {
      const core = this.layout.constellations.find((c) => c.core);
      if (core) {
        const w = 1 - this.coreFlash;
        d.set([core.x, core.y, core.z, NUCLEUS_WORLD * (1 + w * 1.4), NUCLEUS_PX * (1 + (1 - (1 - w) ** 3) * 2.2), CORE_COLOR[0], CORE_COLOR[1], CORE_COLOR[2], 0.7 * this.coreFlash ** 2], o);
        o += SPRITE_FLOATS;
        heads++;
      }
    }

    // The pulse of the pulsars: their light added over the still star in the scene, in the same draw as the satellites.
    if (moving) {
      const { stars: all } = this.layout;
      const floor = this.starFloor;
      for (const i of this.pulsars) {
        const s = all[i];
        if (camera.depth(s.x, s.y, s.z) <= 0) continue;
        const period = 1.6 + hash01(s.node.id, 34) * 2.4;
        const wave = 0.5 + 0.5 * Math.sin((this.pulseClock / period + hash01(s.node.id, 35)) * TAU);
        d.set([s.x, s.y, s.z, 2.3 * s.k, Math.max(STAR_FLOOR_PX, 11.5 * s.k * floor), 0.74, 0.9, 1, PULSE_ALPHA * Math.min(1, floor * 2) * wave * wave * Math.min(1, this.state[i * 2])], o);
        o += SPRITE_FLOATS;
        heads++;
      }
    }

    let rings = 0;
    const ring = (x: number, y: number, z: number, px: number) => {
      d.set([x, y, z, 0, px, 1, 1, 1, 0.85], o);
      o += SPRITE_FLOATS;
      rings++;
    };
    const { stars } = this.layout;
    if (this.hoverStar >= 0) {
      const s = stars[this.hoverStar];
      ring(s.x, s.y, s.z, 10 + 4 * s.k);
    }
    if (this.selected) {
      const s = stars.find((x) => x.node.id === this.selected && x.c >= 0);
      if (s) ring(s.x, s.y, s.z, 13 + 4 * s.k);
    }

    if (segments > 0) {
      gl.useProgram(line.p);
      gl.uniformMatrix4fv(line.vp, false, camera.viewProj);
      gl.uniform2f(line.res, rw, rh);
      gl.uniform1f(line.width, 1.7 * k);
      gl.uniform1f(line.gap, 0.0001);
      this.bindQuad();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.dynLine);
      gl.bufferData(gl.ARRAY_BUFFER, L.subarray(0, segments * LINE_FLOATS), gl.DYNAMIC_DRAW);
      this.bindLines(this.dynLine);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, segments);
    }
    if (heads + rings === 0) return;
    gl.useProgram(sprite.p);
    gl.uniformMatrix4fv(sprite.vp, false, camera.viewProj);
    gl.uniform1f(sprite.fade, 1);
    gl.uniform1f(sprite.floor, 1);
    gl.uniform1f(sprite.floorMin, 0);
    this.setSpriteView(rw, rh, k);
    this.bindQuad();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.dynSprite);
    gl.bufferData(gl.ARRAY_BUFFER, d.subarray(0, o), gl.DYNAMIC_DRAW);
    const stride = SPRITE_FLOATS * 4;
    if (heads > 0) {
      gl.uniform1i(sprite.shape, 2);
      this.bindSprites(this.dynSprite, 0, null);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, heads);
    }
    if (rings > 0) {
      gl.uniform1i(sprite.shape, 3);
      this.bindSprites(this.dynSprite, heads * stride, null);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, rings);
    }
  }

  // ---------- Pointer ----------

  private pick() {
    const pt = this.pointer;
    if (!pt || this.drag) return;
    const { viewProj: m, width: W, height: H } = this.camera;
    let best = 16 * 16;
    let star = -1;
    const { stars } = this.layout;
    // A project's card is open: on the way to it the pointer crosses stars that have nothing to say.
    if (!this.badge && !this.card) {
      for (let i = 0; i < stars.length; i++) {
        const s = stars[i];
        if (s.c < 0) continue;
        const w = m[3] * s.x + m[7] * s.y + m[11] * s.z + m[15];
        if (w <= 0) continue;
        const dx = (((m[0] * s.x + m[4] * s.y + m[8] * s.z + m[12]) / w + 1) * 0.5 * W - pt.x);
        const dy = ((1 - (m[1] * s.x + m[5] * s.y + m[9] * s.z + m[13]) / w) * 0.5 * H - pt.y);
        const d = dx * dx + dy * dy;
        if (d < best) {
          best = d;
          star = i;
        }
      }
    }
    if (star !== this.hoverStar) {
      this.hoverStar = star;
      this.retarget();
    }
    const node = star >= 0 ? stars[star].node : null;
    if (node?.id !== this.hoverNode?.id) {
      this.hoverNode = node;
      this.canvas.style.cursor = node ? 'pointer' : 'grab';
      this.ev.onHover(node);
    }
  }

  private overNucleus(x: number, y: number): boolean {
    const c = this.layout.constellations.find((k) => k.core);
    if (!c) return false;
    const p = this.camera.project(c.x, c.y, c.z);
    // Up close the nucleus is far bigger than the pointer's margin.
    return p.w > 0 && Math.hypot(p.sx - x, p.sy - y) <= Math.max(CORE_HIT_PX, (NUCLEUS_WORLD * 0.3 * this.camera.pxPerWorld) / p.w);
  }

  /** A central star answers like its project's name: it is the object, the name only labels it. Its name may be hidden, the element is still there. */
  private centerAt(x: number, y: number): HTMLElement | null {
    const px = this.camera.pxPerWorld;
    let best = Infinity;
    let found: Constellation | null = null;
    for (const c of this.allConstellations()) {
      const p = this.camera.project(c.x, c.y, c.z);
      if (p.w <= 0) continue;
      const d = Math.hypot(p.sx - x, p.sy - y);
      const reach = c.core ? Math.max(CORE_HIT_PX, (NUCLEUS_WORLD * 0.3 * px) / p.w) : Math.max(CENTER_HIT_PX, (c.r * CENTER_WORLD * 0.3 * px) / p.w);
      if (d <= reach && d < best) {
        best = d;
        found = c;
      }
    }
    return found && this.labels.elementOf(found);
  }

  private clearHover() {
    this.pointer = null;
    this.setBadge(null);
    if (this.hoverStar >= 0) {
      this.hoverStar = -1;
      this.retarget();
    }
    if (this.hoverNode) {
      this.hoverNode = null;
      this.ev.onHover(null);
    }
  }

  private setBadge(el: HTMLElement | null) {
    if (el === this.badge) return;
    this.badge = el;
    if (!el) return this.ev.onBadge(null, null, false);
    // A name that is not shown has no place of its own: the card opens at the pointer, which is on the star.
    const at = this.pointer;
    this.ev.onBadge(el.dataset.project ?? '', el.classList.contains('on') || !at ? el.getBoundingClientRect() : new DOMRect(at.x - CENTER_HIT_PX, at.y - CENTER_HIT_PX, CENTER_HIT_PX * 2, CENTER_HIT_PX * 2), false);
  }

  private onBadgeFocus = (e: FocusEvent) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('.u-label[data-project]');
    if (el?.matches(':focus-visible')) this.ev.onBadge(el.dataset.project ?? '', el.getBoundingClientRect(), true);
  };

  private onBadgeKey = (e: KeyboardEvent) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const el = (e.target as HTMLElement).closest<HTMLElement>('.u-label');
    if (!el) return;
    e.preventDefault();
    this.activateLabel(el);
  };

  private activateLabel(el: HTMLElement) {
    if (el.dataset.note) {
      const s = this.layout.stars.find((x) => x.node.id === el.dataset.note);
      if (s) this.ev.onOpen(s.node);
      return;
    }
    const key = el.dataset.project ?? '';
    const c = this.allConstellations().find((x) => (x.key ?? '') === key);
    if (c) this.flyTo(c.key);
  }

  private onDown = (e: PointerEvent) => {
    if (e.button !== 0 && e.button !== 2) return;
    if (e.button === 2) this.menuAnswered = false;
    this.glide = null;
    const label = (e.target as HTMLElement).closest<HTMLElement>('.u-label');
    this.drag = { x: e.clientX, y: e.clientY, moved: false, pan: e.button === 2 || e.shiftKey, label, vx: 0, vy: 0, at: e.timeStamp };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    this.canvas.style.cursor = 'grabbing';
  };

  private onMove = (e: PointerEvent) => {
    if (!this.drag) {
      this.pointer = { x: e.clientX, y: e.clientY };
      const center = e.target === this.canvas ? this.centerAt(e.clientX, e.clientY) : null;
      this.setBadge((e.target as HTMLElement).closest<HTMLElement>('.u-label[data-project]') ?? center);
      if (center) this.canvas.style.cursor = 'pointer';
      else if (!this.hoverNode) this.canvas.style.cursor = 'grab';
      this.pointerMoved = true;
      this.kick();
      return;
    }
    const dx = e.clientX - this.drag.x;
    const dy = e.clientY - this.drag.y;
    // A hand on a right button trembles more than on a left one, and a click on the core that became a tiny drag loses its menu.
    if (!this.drag.moved && Math.hypot(dx, dy) < (this.drag.pan ? PAN_SLOP : SLOP)) return;
    const elapsed = Math.max(1, e.timeStamp - this.drag.at);
    // Smoothed: the last event alone says little about the throw.
    const fresh = Math.min(1, elapsed / 40);
    this.drag.vx += ((dx * 1000) / elapsed - this.drag.vx) * fresh;
    this.drag.vy += ((dy * 1000) / elapsed - this.drag.vy) * fresh;
    this.drag.at = e.timeStamp;
    this.drag.moved = true;
    this.drag.x = e.clientX;
    this.drag.y = e.clientY;
    this.camera.speed = this.drag.pan ? PAN_SPEED : 16;
    if (this.drag.pan) this.panBy(dx, dy);
    else {
      this.camera.goal.yaw -= dx * 0.0042;
      this.camera.goal.pitch = Math.max(0.22, Math.min(1.5, this.camera.goal.pitch + dy * 0.0036));
    }
    if (this.reduce) this.camera.jump();
    this.kick();
  };

  private onUp = (e: PointerEvent) => {
    const d = this.drag;
    this.drag = null;
    this.canvas.style.cursor = 'grab';
    if (e.button === 2) this.menuAnswered = true;
    // The same easing a pan had under the hand: changing it here would be a kink at the release.
    if (!d?.pan) this.camera.speed = 7;
    if (d?.pan && d.moved && !this.reduce && e.timeStamp - d.at < GLIDE_STALE_MS && Math.hypot(d.vx, d.vy) > GLIDE_MIN_PX) this.glide = { vx: d.vx, vy: d.vy };
    if (!d || d.moved) {
      this.pointer = { x: e.clientX, y: e.clientY };
      this.pointerMoved = true;
      this.kick();
      return;
    }
    if (e.button === 2) {
      if (this.onCore(e.clientX, e.clientY, d.label)) this.openMenu(e.clientX, e.clientY);
      return;
    }
    if (d.label) {
      this.activateLabel(d.label);
      return;
    }
    this.pointer = { x: e.clientX, y: e.clientY };
    const center = this.centerAt(e.clientX, e.clientY);
    if (center) return this.activateLabel(center);
    this.pick();
    if (this.hoverNode) this.ev.onOpen(this.hoverNode);
  };

  private menuAnswered = false;

  private onCore(x: number, y: number, label: HTMLElement | null) {
    return label ? label.classList.contains('core') : this.overNucleus(x, y);
  }

  /** Where the menu key opens the menu. With no map to look at, the middle of the window. */
  private coreOnScreen(): [number, number] {
    const c = this.layout.constellations.find((k) => k.core);
    const p = c && this.camera.project(c.x, c.y, c.z);
    return p && p.w > 0 && p.sx >= 0 && p.sx <= this.W && p.sy >= 0 && p.sy <= this.H ? [p.sx, p.sy] : [this.W / 2, this.H / 2];
  }

  private openMenu(x: number, y: number) {
    if (!this.reduce) this.coreFlash = 1;
    this.kick();
    this.ev.onMenu(x, y);
  }

  private onLeave = () => {
    if (!this.drag) this.clearHover();
  };

  private onDouble = (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest('.u-label') || this.hoverNode || this.centerAt(e.clientX, e.clientY)) return;
    this.resetView();
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    this.glide = null;
    const cam = this.camera;
    const before = cam.goal.dist;
    const next = this.clampDist(before * Math.exp(e.deltaY * 0.0011));
    // Zoom toward what is under the pointer: the point it will be over at the goal, whatever the camera is still doing, so ticks in a row
    // keep one spot still. Backing out past the general view leads home instead, the map does not slide away from the middle.
    const ground = cam.groundAt(e.clientX, e.clientY);
    if (next > before && next > this.home.dist) {
      cam.goal.x *= before / next;
      cam.goal.z *= before / next;
    } else if (ground) {
      const f = (1 - next / before) * (before / cam.now.dist);
      cam.goal.x += (ground[0] - cam.now.x) * f;
      cam.goal.z += (ground[1] - cam.now.z) * f;
    }
    cam.goal.dist = next;
    cam.speed = 9;
    if (this.reduce) cam.jump();
    this.kick();
  };

  // By physical key, so WASD also works on the Russian layout. Only when nothing else on the page owns the keyboard.
  private onMoveKey = (e: KeyboardEvent) => {
    if (!this.visible || !(e.code in MOVE_KEYS) || e.ctrlKey || e.metaKey || e.altKey) return;
    const target = e.target as HTMLElement;
    if (target !== document.body && target !== this.canvas) return;
    e.preventDefault();
    this.held.add(e.code);
    this.kick();
  };

  private stepMoveKeys(dt: number) {
    if (this.held.size === 0) return;
    let dx = 0;
    let dy = 0;
    for (const code of this.held) {
      dx += MOVE_KEYS[code][0];
      dy += MOVE_KEYS[code][1];
    }
    this.camera.speed = 9;
    this.panBy(dx * MOVE_PX_PER_SEC * dt, dy * MOVE_PX_PER_SEC * dt);
    if (this.reduce) this.camera.jump();
  }

  // The camera's target stays over the map: a throw cannot lose the galaxy in empty space, it runs out against the rim.
  private panBy(dx: number, dy: number) {
    const { goal } = this.camera;
    this.camera.pan(dx, dy);
    const reach = Math.max(R, ...this.allConstellations().map((c) => Math.hypot(c.x, c.z))) * 1.1;
    const off = Math.hypot(goal.x, goal.z);
    if (off <= reach) return;
    goal.x *= reach / off;
    goal.z *= reach / off;
  }

  private stepGlide(dt: number) {
    if (!this.glide) return;
    const g = this.glide;
    this.camera.speed = PAN_SPEED;
    this.panBy(g.vx * dt, g.vy * dt);
    const f = Math.exp(-dt * GLIDE_DECAY);
    g.vx *= f;
    g.vy *= f;
    if (Math.hypot(g.vx, g.vy) < GLIDE_STOP_PX) this.glide = null;
  }

  private onKey = (e: KeyboardEvent) => {
    const cam = this.camera;
    if (e.key === '+' || e.key === '=') cam.goal.dist = this.clampDist(cam.goal.dist * 0.82);
    else if (e.key === '-') cam.goal.dist = this.clampDist(cam.goal.dist * 1.22);
    else if (e.key === '0') return this.resetView();
    else return;
    e.preventDefault();
    cam.speed = 9;
    if (this.reduce) cam.jump();
    this.kick();
  };
}
