// The decorative galaxy: dust along the arms, the bulge, far stars and nebulae. Never hoverable, never counted.
// Deliberately much smaller and dimmer than a note star, so nobody takes it for data.
import type { SkyColors } from './colors';
import { ARMS, armAngle, REACH } from './layout';
import { SPRITE_FLOATS } from './shaders';

function prng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(rnd: () => number) {
  return (rnd() + rnd() + rnd() + rnd() - 2) * 0.87;
}

// Two strong arms and two weaker ones: real spirals are not symmetric.
const ARM_WEIGHT = [1, 0.5, 0.85, 0.42];

export interface DustField {
  dust: Float32Array;
  nebula: Float32Array;
}

export function buildDust(R: number, density: number, sky: Pick<SkyColors, 'inner' | 'outer'>): DustField {
  const INNER = sky.inner;
  const OUTER = sky.outer;
  const rnd = prng(20261105);
  const armCount = Math.round(34000 * density);
  const fieldCount = Math.round(9000 * density);
  const bulgeCount = Math.round(7000 * density);
  const farCount = Math.round(2800 * density);
  const dust = new Float32Array((armCount + fieldCount + bulgeCount + farCount) * SPRITE_FLOATS);
  let o = 0;
  const put = (x: number, y: number, z: number, px: number, r: number, g: number, b: number, a: number) => {
    dust[o++] = x;
    dust[o++] = y;
    dust[o++] = z;
    dust[o++] = 0;
    dust[o++] = px;
    dust[o++] = r;
    dust[o++] = g;
    dust[o++] = b;
    dust[o++] = a;
  };
  const tone = (u: number) => {
    const t = Math.min(1, u * 1.9);
    return [0, 1, 2].map((i) => INNER[i] * (1 - t) + OUTER[i] * t);
  };

  for (let i = 0; i < armCount; i++) {
    const arm = i % ARMS;
    const u = 0.05 + rnd() ** 0.8 * 0.95;
    const a = armAngle(arm, u);
    // The spread is a distance across the arm, so an arm stays a band instead of a widening fan.
    const across = gauss(rnd) * R * (0.045 + 0.1 * u);
    const d = u * R * REACH;
    const x = Math.cos(a) * d - Math.sin(a) * across;
    const z = Math.sin(a) * d + Math.cos(a) * across;
    const c = tone(u);
    const big = rnd() < 0.04;
    const alpha = (big ? 0.62 : 0.34) * (0.45 + rnd() * 0.75) * (1.12 - u * 0.5) * (0.45 + ARM_WEIGHT[arm] * 0.55);
    put(x, gauss(rnd) * R * 0.04 * (1.15 - u), z, big ? 2.1 + rnd() * 0.8 : 0.95 + rnd() * 0.95, c[0], c[1], c[2], alpha);
  }
  for (let i = 0; i < fieldCount; i++) {
    const a = rnd() * Math.PI * 2;
    const d = Math.sqrt(rnd()) * R * REACH * 1.25;
    const c = tone(d / (R * REACH));
    put(Math.cos(a) * d, gauss(rnd) * R * 0.09, Math.sin(a) * d, 0.85 + rnd() * 0.7, c[0], c[1], c[2], 0.1 + rnd() * 0.22);
  }
  for (let i = 0; i < bulgeCount; i++) {
    const a = rnd() * Math.PI * 2;
    const d = Math.abs(gauss(rnd)) ** 1.4 * R * 0.3;
    put(Math.cos(a) * d, gauss(rnd) * R * 0.018 * Math.exp(-d / (R * 0.22)), Math.sin(a) * d, 0.95 + rnd() * 0.9, INNER[0], INNER[1], INNER[2], 0.06 + rnd() * 0.12);
  }
  for (let i = 0; i < farCount; i++) {
    const y = rnd() * 2 - 1;
    const a = rnd() * Math.PI * 2;
    const s = Math.sqrt(1 - y * y);
    const dd = R * 9;
    const warm = rnd();
    put(Math.cos(a) * s * dd, y * dd, Math.sin(a) * s * dd, 0.8 + rnd() * 0.8, 0.78 + warm * 0.22, 0.82 + warm * 0.1, 1 - warm * 0.2, 0.14 + rnd() ** 3 * 0.6);
  }

  // Nebulae trace the arms: many small low-alpha puffs add up to a band of light, a few large ones would read as blobs.
  const puffs = 320;
  const nebula = new Float32Array((puffs + 3) * SPRITE_FLOATS);
  let n = 0;
  const puff = (x: number, y: number, z: number, size: number, r: number, g: number, b: number, a: number) => {
    nebula.set([x, y, z, size, 0, r, g, b, a], n);
    n += SPRITE_FLOATS;
  };
  puff(0, 0, 0, R * 1.5, INNER[0] * 0.3, INNER[1] * 0.3, INNER[2] * 0.35, 0.34);
  puff(0, 0, 0, R * 0.62, INNER[0] * 0.62, INNER[1] * 0.58, INNER[2] * 0.56, 0.26);
  puff(0, 0, 0, R * 0.2, INNER[0], INNER[1], INNER[2], 0.16);
  for (let i = 0; i < puffs; i++) {
    const arm = i % ARMS;
    const u = 0.1 + rnd() ** 0.9 * 0.9;
    const a = armAngle(arm, u);
    const across = gauss(rnd) * R * (0.03 + 0.07 * u);
    const d = u * R * REACH;
    const t = Math.min(1, u * 2.1);
    // The light of the dust around it, far dimmer.
    const r = INNER[0] * 0.46 * (1 - t) + OUTER[0] * 0.3 * t;
    const g = INNER[1] * 0.42 * (1 - t) + OUTER[1] * 0.34 * t;
    const b = INNER[2] * 0.4 * (1 - t) + OUTER[2] * 0.36 * t;
    puff(Math.cos(a) * d - Math.sin(a) * across, gauss(rnd) * R * 0.02, Math.sin(a) * d + Math.cos(a) * across, R * (0.07 + rnd() * 0.13) * (0.8 + u * 0.7), r, g, b, (0.09 + rnd() * 0.12) * (0.4 + ARM_WEIGHT[arm] * 0.6));
  }
  return { dust, nebula };
}
