// Orbit camera. Every parameter eases to its goal through two exponential steps in a row: drag, wheel, flight and intro share one motion,
// which starts as softly as it ends. The same filter on every field also keeps a zoom's point under the pointer still all the way.
const FOV = (38 * Math.PI) / 180;
const TAN = Math.tan(FOV / 2);

export interface Pose {
  yaw: number;
  pitch: number;
  dist: number;
  x: number;
  y: number;
  z: number;
}

const NEAR = 2;
const FAR = 30000;
const FIELDS = ['yaw', 'pitch', 'dist', 'x', 'y', 'z'] as const;

export class Camera {
  now: Pose;
  goal: Pose;
  private mid: Pose;
  private rate = 7;
  /** Speed of the easing, per second. */
  speed = 7;
  readonly viewProj = new Float32Array(16);
  width = 1;
  height = 1;
  private right = [1, 0, 0];
  private up = [0, 1, 0];
  private forward = [0, 0, -1];
  private eye = [0, 0, 0];

  constructor(pose: Pose) {
    this.now = { ...pose };
    this.goal = { ...pose };
    this.mid = { ...pose };
  }

  /** Pixels per world unit at clip w = 1, in the units of width and height. */
  get pxPerWorld() {
    return this.height / 2 / TAN;
  }

  /** Returns true while it still moves. */
  step(dt: number): boolean {
    // The speed itself changes softly, or the moment of a change would be a kink in the motion.
    this.rate += (this.speed - this.rate) * (1 - Math.exp(-dt * 10));
    const f = 1 - Math.exp(-dt * this.rate * 2); // two steps: twice the rate for the same delay
    let moving = false;
    for (const key of FIELDS) {
      const eps = key === 'yaw' || key === 'pitch' ? 2e-5 : 2e-3;
      this.mid[key] += (this.goal[key] - this.mid[key]) * f;
      const d = this.mid[key] - this.now[key];
      if (Math.abs(d) < eps && Math.abs(this.goal[key] - this.now[key]) < eps) {
        this.mid[key] = this.goal[key];
        this.now[key] = this.goal[key];
      } else {
        this.now[key] += d * f;
        moving = true;
      }
    }
    this.compute();
    return moving;
  }

  jump() {
    this.now = { ...this.goal };
    this.mid = { ...this.goal };
    this.compute();
  }

  compute() {
    const { yaw, pitch, dist, x, y, z } = this.now;
    const cp = Math.cos(pitch);
    const eye = [x + dist * cp * Math.sin(yaw), y + dist * Math.sin(pitch), z + dist * cp * Math.cos(yaw)];
    const f = [x - eye[0], y - eye[1], z - eye[2]].map((v) => v / dist);
    const rl = Math.hypot(f[2], f[0]) || 1;
    const r = [-f[2] / rl, 0, f[0] / rl];
    const u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
    this.right = r;
    this.up = u;
    this.forward = f;
    this.eye = eye;

    const aspect = this.width / Math.max(1, this.height);
    const py = 1 / TAN;
    const px = py / aspect;
    const a = (FAR + NEAR) / (NEAR - FAR);
    const b = (2 * FAR * NEAR) / (NEAR - FAR);
    const dr = -(r[0] * eye[0] + r[1] * eye[1] + r[2] * eye[2]);
    const du = -(u[0] * eye[0] + u[1] * eye[1] + u[2] * eye[2]);
    const df = f[0] * eye[0] + f[1] * eye[1] + f[2] * eye[2];
    const m = this.viewProj;
    m[0] = px * r[0];
    m[1] = py * u[0];
    m[2] = -a * f[0];
    m[3] = f[0];
    m[4] = px * r[1];
    m[5] = py * u[1];
    m[6] = -a * f[1];
    m[7] = f[1];
    m[8] = px * r[2];
    m[9] = py * u[2];
    m[10] = -a * f[2];
    m[11] = f[2];
    m[12] = px * dr;
    m[13] = py * du;
    m[14] = a * df + b;
    m[15] = -df;
  }

  /** Screen position in pixels and clip w. w <= 0 means behind the camera. */
  project(x: number, y: number, z: number): { sx: number; sy: number; w: number } {
    const m = this.viewProj;
    const w = m[3] * x + m[7] * y + m[11] * z + m[15];
    const cx = m[0] * x + m[4] * y + m[8] * z + m[12];
    const cy = m[1] * x + m[5] * y + m[9] * z + m[13];
    return { sx: (cx / w + 1) * 0.5 * this.width, sy: (1 - cy / w) * 0.5 * this.height, w };
  }

  /** Just the clip w of a point: the overlay asks this hundreds of times a frame. */
  depth(x: number, y: number, z: number): number {
    const m = this.viewProj;
    return m[3] * x + m[7] * y + m[11] * z + m[15];
  }

  /** Where the ray through a screen point meets the disc plane at the current target height. */
  groundAt(sx: number, sy: number): [number, number] | null {
    const nx = ((sx / this.width) * 2 - 1) * TAN * (this.width / this.height);
    const ny = (1 - (sy / this.height) * 2) * TAN;
    const dir = [0, 1, 2].map((i) => this.forward[i] + this.right[i] * nx + this.up[i] * ny);
    if (Math.abs(dir[1]) < 1e-4) return null;
    const t = (this.now.y - this.eye[1]) / dir[1];
    if (t <= 0) return null;
    return [this.eye[0] + dir[0] * t, this.eye[2] + dir[2] * t];
  }

  pan(dx: number, dy: number) {
    const unit = (this.goal.dist * 2 * TAN) / this.height;
    const fl = Math.hypot(this.forward[0], this.forward[2]) || 1;
    const stretch = 1 / Math.max(0.35, Math.sin(this.now.pitch));
    this.goal.x += -this.right[0] * dx * unit + (this.forward[0] / fl) * dy * unit * stretch;
    this.goal.z += -this.right[2] * dx * unit + (this.forward[2] / fl) * dy * unit * stretch;
  }
}
