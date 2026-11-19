// Text tokens of both themes stay readable: WCAG contrast of 4.5:1 or more on the surfaces text sits on.
// A light palette tuned by eye once left the secondary text too faint to read; this keeps it from drifting back.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const css = readFileSync(join(import.meta.dirname, '..', 'web', 'src', 'styles.css'), 'utf8');

function block(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  assert.ok(start >= 0, `no ${selector} block in styles.css`);
  const body = css.slice(start, css.indexOf('}', start));
  return Object.fromEntries([...body.matchAll(/--color-([\w-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1], m[2]]));
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

const dark = block('@theme');
const themes = { dark, light: { ...dark, ...block("[data-theme='light']") } };

for (const [name, t] of Object.entries(themes)) {
  test(`${name} theme text tokens keep 4.5:1 on the background, cards and panels`, () => {
    for (const text of ['fg', 'soft', 'muted', 'dim']) {
      for (const surface of ['bg', 'card', 'panel', 'panel-deep']) {
        const ratio = contrast(t[text], t[surface]);
        assert.ok(ratio >= 4.5, `${name}: ${text} ${t[text]} on ${surface} ${t[surface]} is ${ratio.toFixed(2)}:1`);
      }
    }
  });
}

// Project and plugin icons on paper: the pastel palette deepened to `--ink-light` (oklch L) in its tile, glyph against tile.
// WCAG 1.4.11 asks 3:1 of a graphic; the light theme once drew these at about 1.5:1.
const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

function hexToOklch(hex: string): [number, number, number] {
  const [r, g, b] = [1, 3, 5].map((i) => toLinear(parseInt(hex.slice(i, i + 2), 16) / 255));
  const [l, m, s] = [
    0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b,
    0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b,
    0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b,
  ].map(Math.cbrt);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [L, Math.hypot(A, B), Math.atan2(B, A)];
}

function oklchToLinear([L, C, h]: [number, number, number]): number[] {
  const [A, B] = [C * Math.cos(h), C * Math.sin(h)];
  const [l, m, s] = [L + 0.3963377774 * A + 0.2158037573 * B, L - 0.1055613458 * A - 0.0638541728 * B, L - 0.0894841775 * A - 1.291485548 * B].map((x) => x ** 3);
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
}

/** The browser maps an out-of-gamut colour by lowering its chroma: the same here, by halving. */
function inGamut(lch: [number, number, number]): number[] {
  const ok = (rgb: number[]) => rgb.every((c) => c >= -1e-4 && c <= 1 + 1e-4);
  if (ok(oklchToLinear(lch))) return oklchToLinear(lch).map((c) => Math.min(1, Math.max(0, c)));
  let [lo, hi] = [0, lch[1]];
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (ok(oklchToLinear([lch[0], mid, lch[2]]))) lo = mid;
    else hi = mid;
  }
  return oklchToLinear([lch[0], lo, lch[2]]).map((c) => Math.min(1, Math.max(0, c)));
}

const linearLuminance = ([r, g, b]: number[]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

test('light theme project and plugin icons keep 3:1 against their tile for every palette colour', async () => {
  const { SWATCHES } = await import('../web/src/home/universe/colors.ts');
  const light = Number(/\[data-theme='light'\] \{[^}]*--ink-light:\s*([\d.]+)/.exec(css)?.[1]);
  const tint = Number(/\[data-theme='light'\] \.icon-tile \{[^}]*var\(--ink\) (\d+)%, transparent/.exec(css)?.[1]) / 100;
  assert.ok(light > 0 && light < 1 && tint > 0, 'no --ink-light or tile tint for the light theme in styles.css');
  for (const hex of SWATCHES) {
    const lch = hexToOklch(hex);
    const glyph = linearLuminance(inGamut([Math.min(lch[0], light), lch[1], lch[2]]));
    // The tint is the raw palette colour over white paper, mixed in sRGB as the browser composites it.
    const paper = [1, 3, 5].map((i) => toLinear(tint * (parseInt(hex.slice(i, i + 2), 16) / 255) + (1 - tint)));
    const ratio = (linearLuminance(paper) + 0.05) / (glyph + 0.05);
    assert.ok(ratio >= 3, `${hex}: ${ratio.toFixed(2)}:1`);
  }
});
