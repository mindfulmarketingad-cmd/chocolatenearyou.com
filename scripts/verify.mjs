/**
 * Checks the built site in dist/. Exits non-zero on any error.
 *
 *   node scripts/verify.mjs
 *
 * Errors: an internal href/src that does not resolve to a built file, a
 * page without exactly one <h1> or a canonical, an indexable title of 60+
 * characters or description outside 150-160, a target="_blank" link without
 * rel="noopener", an emoji anywhere, an unfilled {{TOKEN}}, or an ads.txt
 * that differs from the expected line, or a page without a featured image.
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = resolve(dirname(fileURLToPath(import.meta.url)), '../dist');
const SITE = 'https://chocolatenearyou.com';
const errors = [];
const warn = [];

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.html')) out.push(p);
  }
  return out;
}

function resolves(urlPath) {
  const clean = decodeURIComponent(urlPath.split('#')[0].split('?')[0]);
  if (!clean || clean === '/') return existsSync(join(DIST, 'index.html'));
  const p = join(DIST, clean);
  if (existsSync(p) && statSync(p).isFile()) return true;
  return existsSync(join(p, 'index.html'));
}

const EMOJI = /(?![\u00a9\u00ae\u2122])\p{Extended_Pictographic}/u;
const files = walk(DIST);
let links = 0;

for (const file of files) {
  const rel = file.slice(DIST.length);
  const html = readFileSync(file, 'utf8');
  const isStub = html.includes('http-equiv="refresh"');
  const noindex = /<meta name="robots" content="noindex/.test(html);

  const tok = html.match(/\{\{[A-Z_]+\}\}/);
  if (tok) errors.push(`${rel}: unfilled token ${tok[0]}`);
  const emoji = html.replace(/<script[\s\S]*?<\/script>/g, '').match(EMOJI);
  if (emoji) errors.push(`${rel}: emoji ${emoji[0]}`);
  if (rel !== '/404.html' && !/<link rel="canonical" href="https:\/\/chocolatenearyou\.com\/[^"]*">/.test(html)) errors.push(`${rel}: missing canonical`);

  if (!isStub) {
    if (rel !== '/404.html' && !/class="(feature|detail-hero|hero)"/.test(html)) errors.push(`${rel}: no featured image`);
    const h1s = (html.match(/<h1[\s>]/g) || []).length;
    if (h1s !== 1) errors.push(`${rel}: ${h1s} h1 tags`);
    const title = (html.match(/<title>([^<]*)<\/title>/) || [])[1] || '';
    const desc = (html.match(/<meta name="description" content="([^"]*)"/) || [])[1] || '';
    const decode = (s) => s.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    if (!noindex) {
      if (decode(title).length >= 60) errors.push(`${rel}: title ${decode(title).length} chars: ${decode(title)}`);
      const d = decode(desc).length;
      if (d < 150 || d > 160) errors.push(`${rel}: description ${d} chars: ${decode(desc)}`);
    }
    for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
      try { JSON.parse(m[1]); } catch { errors.push(`${rel}: invalid JSON-LD`); }
    }
  }

  for (const m of html.matchAll(/<a\b[^>]*>/g)) {
    const tag = m[0];
    if (/target="_blank"/.test(tag) && !/rel="[^"]*noopener/.test(tag)) errors.push(`${rel}: target=_blank without noopener: ${tag.slice(0, 120)}`);
  }
  for (const m of html.matchAll(/\s(?:href|src)="([^"]+)"/g)) {
    let url = m[1].replace(/&amp;/g, '&');
    if (url.startsWith(SITE)) url = url.slice(SITE.length) || '/';
    if (!url.startsWith('/') || url.startsWith('//')) continue;
    links++;
    if (!resolves(url)) errors.push(`${rel}: broken link ${url}`);
  }
}

const ads = existsSync(join(DIST, 'ads.txt')) ? readFileSync(join(DIST, 'ads.txt'), 'utf8').trim() : '';
if (ads !== 'google.com, pub-9332749804326149, DIRECT, f08c47fec0942fa0') errors.push(`ads.txt content is wrong: "${ads}"`);
for (const f of ['robots.txt', 'sitemap.xml', 'favicon.ico', 'site.webmanifest', '404.html']) if (!existsSync(join(DIST, f))) errors.push(`missing ${f}`);
const sitemap = readFileSync(join(DIST, 'sitemap.xml'), 'utf8');
for (const m of sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)) {
  const path = m[1].slice(SITE.length);
  const page = join(DIST, path, 'index.html');
  if (!existsSync(page)) errors.push(`sitemap lists missing page ${path}`);
  else if (/<meta name="robots" content="noindex/.test(readFileSync(page, 'utf8'))) errors.push(`sitemap lists noindex page ${path}`);
}

console.log(`Checked ${files.length} HTML files and ${links} internal links.`);
for (const w of warn) console.log(`warning: ${w}`);
if (errors.length) {
  console.log(`${errors.length} errors:`);
  for (const e of errors.slice(0, 60)) console.log(`  ${e}`);
  if (errors.length > 60) console.log(`  ...and ${errors.length - 60} more`);
  process.exit(1);
}
console.log('All checks passed.');
