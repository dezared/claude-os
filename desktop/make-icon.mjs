// Renders desktop/icon.ico: the dot sphere from the home screen on a dark tile. ICO entries hold plain PNGs.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

function svg(size) {
  const dots = [];
  const n = size >= 64 ? 150 : size >= 32 ? 46 : 18;
  const R = size * 0.34;
  for (let i = 0; i < n; i++) {
    const y = 1 - ((i + 0.5) / n) * 2;
    const r = Math.sqrt(1 - y * y);
    const a = i * 2.399963;
    const z = r * Math.sin(a);
    if (z < -0.25) continue;
    const t = (z + 1) / 2;
    const px = size / 2 + r * Math.cos(a) * R;
    const py = size / 2 + y * R;
    const hot = (px - size * 0.62) ** 2 + (py - size * 0.4) ** 2 < (size * 0.2) ** 2;
    const rad = Math.max(size * (0.006 + t * 0.016), size < 32 ? 0.9 : 0);
    dots.push(`<circle cx="${px}" cy="${py}" r="${rad}" fill="${hot ? '#d97757' : '#e4e4e7'}" opacity="${hot ? 1 : 0.25 + t * 0.7}"/>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><rect width="${size}" height="${size}" rx="${size * 0.2}" fill="#09090b"/><rect x=".5" y=".5" width="${size - 1}" height="${size - 1}" rx="${size * 0.2}" fill="none" stroke="#27272a"/>${dots.join('')}</svg>`;
}

const browser = await chromium.launch();
const pngs = [];
const sizes = [16, 24, 32, 48, 64, 128, 256];
for (const size of sizes) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block}</style>${svg(size)}`);
  pngs.push(await page.screenshot({ omitBackground: true }));
  await page.close();
}
await browser.close();

const header = Buffer.alloc(6);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
const entries = [];
let offset = 6 + 16 * sizes.length;
sizes.forEach((size, i) => {
  const e = Buffer.alloc(16);
  e[0] = size === 256 ? 0 : size;
  e[1] = size === 256 ? 0 : size;
  e.writeUInt16LE(1, 4);
  e.writeUInt16LE(32, 6);
  e.writeUInt32LE(pngs[i].length, 8);
  e.writeUInt32LE(offset, 12);
  offset += pngs[i].length;
  entries.push(e);
});
writeFileSync(join(import.meta.dirname, 'icon.ico'), Buffer.concat([header, ...entries, ...pngs]));
writeFileSync(join(import.meta.dirname, 'icon.png'), pngs[pngs.length - 1]);
