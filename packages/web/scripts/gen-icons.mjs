// gen-icons.mjs — rasterize PWA icons from the drum favicon.
//
// Renders src/client/public/favicon.svg into the PNG sizes the web app
// manifest and iOS need. Outputs are committed to src/client/public/, so this
// only has to be re-run when the favicon artwork changes:
//
//   pnpm --filter @percussionist/web gen:icons
//
// Two variants are produced:
//   - icon-{192,512}.png          — the favicon as-is (rounded rect, purpose "any")
//   - icon-maskable-{192,512}.png — full-bleed background with the artwork
//     scaled into the maskable safe zone (center 80%), for Android launchers
//     that crop icons into circles/squircles
//   - apple-touch-icon.png        — 180×180 full-bleed; iOS applies its own
//     corner rounding and renders transparency as black, so the rounded-rect
//     favicon can't be used directly

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const publicDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../src/client/public',
);

const favicon = readFileSync(path.join(publicDir, 'favicon.svg'), 'utf8');

// Full-bleed variant: square background in the favicon's brand color, with the
// original artwork (including its rounded rect, which disappears into the
// matching background) scaled to 80% and centered — the maskable safe zone.
const fullBleed = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" fill="#fbbf24"/>
  <g transform="translate(6.4 6.4) scale(0.8)">${favicon.replace(/<\/?svg[^>]*>/g, '')}</g>
</svg>`;

function render(svg, size, outFile) {
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();
  writeFileSync(path.join(publicDir, outFile), png);
  console.log(`${outFile} (${size}×${size}, ${png.length} bytes)`);
}

render(favicon, 192, 'icon-192.png');
render(favicon, 512, 'icon-512.png');
render(fullBleed, 192, 'icon-maskable-192.png');
render(fullBleed, 512, 'icon-maskable-512.png');
render(fullBleed, 180, 'apple-touch-icon.png');
