/**
 * Renders the favicon, app icons and social share image from the vector
 * logo (src/assets/img/logo-mark.svg). Run once after changing the logo;
 * the output is committed, so normal builds never need a browser.
 *
 *   node scripts/make-icons.mjs
 *
 * Needs Playwright with Chromium available (npx playwright install chromium,
 * or PLAYWRIGHT_BROWSERS_PATH pointing at an existing install).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const IMG = resolve(ROOT, 'src/assets/img');
const require = createRequire(import.meta.url);

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  ({ chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright'));
}

const mark = readFileSync(resolve(IMG, 'logo-mark.svg'), 'utf8');
const browser = await chromium.launch();
const page = await browser.newPage();

async function shot(html, width, height) {
  await page.setViewportSize({ width, height });
  await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent">${html}</body></html>`);
  return page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width, height } });
}

const iconHtml = (size, pad = 0.04) =>
  `<div style="width:${size}px;height:${size}px;display:grid;place-items:center">${mark.replace('<svg ', `<svg style="width:${size * (1 - pad * 2)}px;height:${size * (1 - pad * 2)}px" `)}</div>`;
// Apple and Android icons sit on a solid background, so give them one.
const tileHtml = (size) =>
  `<div style="width:${size}px;height:${size}px;display:grid;place-items:center;background:#FAF6F2">${mark.replace('<svg ', `<svg style="width:${size * 0.74}px;height:${size * 0.74}px" `)}</div>`;

const png = {};
for (const s of [16, 32, 48]) png[s] = await shot(iconHtml(s, 0), s, s);
writeFileSync(resolve(IMG, 'favicon-16.png'), png[16]);
writeFileSync(resolve(IMG, 'favicon-32.png'), png[32]);
writeFileSync(resolve(IMG, 'apple-touch-icon.png'), await shot(tileHtml(180), 180, 180));
writeFileSync(resolve(IMG, 'icon-192.png'), await shot(tileHtml(192), 192, 192));
writeFileSync(resolve(IMG, 'icon-512.png'), await shot(tileHtml(512), 512, 512));

// ICO container holding PNG entries (supported by every current browser).
function toIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  let offset = 6 + entries.length * 16;
  const dir = entries.map(({ size, data }) => {
    const d = Buffer.alloc(16);
    d[0] = size;
    d[1] = size;
    d.writeUInt16LE(1, 4);
    d.writeUInt16LE(32, 6);
    d.writeUInt32LE(data.length, 8);
    d.writeUInt32LE(offset, 12);
    offset += data.length;
    return d;
  });
  return Buffer.concat([header, ...dir, ...entries.map((e) => e.data)]);
}
writeFileSync(resolve(IMG, 'favicon.ico'), toIco([16, 32, 48].map((size) => ({ size, data: png[size] }))));

const og = `<div style="width:1200px;height:630px;box-sizing:border-box;background:#FAF6F2;border:28px solid #4A2C1D;display:flex;align-items:center;gap:56px;padding:0 90px;font-family:Georgia,serif">
  ${mark.replace('<svg ', '<svg style="width:260px;height:260px;flex:none" ')}
  <div>
    <div style="font-size:30px;letter-spacing:8px;color:#B88A44;font-family:Helvetica,Arial,sans-serif;font-weight:700">CHOCOLATE NEAR YOU</div>
    <div style="font-size:76px;line-height:1.05;color:#2A1810;font-weight:700;margin-top:18px">Find chocolate shops near you</div>
    <div style="font-size:30px;color:#6B4128;margin-top:22px;font-family:Helvetica,Arial,sans-serif">Ranked by rating, with hours and directions</div>
  </div>
</div>`;
writeFileSync(resolve(IMG, 'og-image.png'), await shot(og, 1200, 630));

await browser.close();
console.log('Icons written to src/assets/img/');
