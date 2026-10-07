/**
 * Static site generator for chocolatenearyou.com.
 *
 *   node scripts/build.mjs
 *
 * Reads src/pages/**.html (each with a JSON <!--meta --> front-matter block),
 * wraps them in src/templates/base.html, generates every state, city,
 * listing, speciality and map page from data/listings.json, and writes the
 * whole site to dist/. Nothing is rendered at request time.
 *
 * LISTINGS_FILE=path/to/listings.json overrides the data file (handy for
 * testing a fresh Outscraper import before it replaces the committed one).
 */
import {
  readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, existsSync, readdirSync,
} from 'node:fs';
import { resolve, dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { slugify, DAYS, stripEmoji } from './lib/listings.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');
const DIST = join(ROOT, 'dist');
const DATA_FILE = process.env.LISTINGS_FILE ? resolve(process.cwd(), process.env.LISTINGS_FILE) : join(ROOT, 'data/listings.json');

const SITE_URL = 'https://chocolatenearyou.com';
const SITE_NAME = 'Chocolate Near You';
const CONTACT_EMAIL = 'hello@chocolatenearyou.com';
const SOCIAL = {
  instagram: 'https://www.instagram.com/chocolatenearyou/',
  twitter: 'https://twitter.com/chocolatenearyou',
  facebook: 'https://www.facebook.com/chocolatenearyou',
};
const ASSET_VERSION = String(Date.now()).slice(-6);
const BUILD_DATE = new Date().toISOString().slice(0, 10);
const NOW = Date.now();
const MONTH_YEAR = new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

// AdSense. The slot ids are existing units on the same publisher account;
// swap in site-specific units from the AdSense dashboard whenever you like.
const AD_CLIENT = 'ca-pub-9332749804326149';
const AD_SLOTS = { display: '4275377186', inFeed: '9687485965' };
const AD_INFEED_LAYOUT_KEY = '-6q+e9+15-2u+4y';

// Google photo URLs in an Outscraper export are signed and stop resolving
// after roughly four weeks. Past this age the build stops emitting them and
// uses a local fallback image instead, so a stale import never ships a page
// full of broken images. Re-import to refresh them.
const PHOTO_MAX_AGE_DAYS = 25;

// How many entries on a hub get the full write-up before the list switches
// to compact entries (same facts, one-line summary).
const STATE_RICH_ENTRIES = 30;
const CITY_RICH_ENTRIES = 50;
// Hubs below these non-placeholder counts are still built (so every link
// resolves) but marked noindex, so the index is not padded with thin pages.
const CITY_INDEX_MIN = 2;
const FIND_STATE_INDEX_MIN = 3;
// Bayesian prior for ranking: a shop needs real review volume before a
// perfect score from a handful of reviews can outrank an established one.
const RANK_PRIOR_REVIEWS = 25;

/* ----------------------------------------------------------------- inputs */

const data = JSON.parse(readFileSync(DATA_FILE, 'utf8'));
const listings = (data.listings || []).filter((l) => l.state && l.city && l.name);
for (const l of listings) l.name = stripEmoji(l.name);
const faqs = JSON.parse(readFileSync(join(SRC, 'data/faqs.json'), 'utf8'));
const categories = JSON.parse(readFileSync(join(SRC, 'data/categories.json'), 'utf8'));
const template = readFileSync(join(SRC, 'templates/base.html'), 'utf8');
const sampleCount = listings.filter((l) => l.sample).length;

/* ------------------------------------------------------------- utilities */

const esc = (s) =>
  stripEmoji(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const attr = (s) => esc(s).replace(/'/g, '&#39;');
const num = (n) => Number(n).toLocaleString('en-US');
const plural = (n, one, many) => `${num(n)} ${n === 1 ? one : many}`;
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function joinNatural(words) {
  if (words.length <= 1) return words[0] || '';
  if (words.length === 2) return `${words[0]} and ${words[1]}`;
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

function seededHash(seed) {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return hash;
}

function haversineMiles(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const a = Math.sin(toRad(lat2 - lat1) / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(toRad(lng2 - lng1) / 2) ** 2;
  return 2 * 3958.8 * Math.asin(Math.sqrt(a));
}

const writtenPaths = new Set();
function writePage(urlPath, html) {
  if (writtenPaths.has(urlPath)) throw new Error(`Two pages tried to write ${urlPath}`);
  writtenPaths.add(urlPath);
  const rel = urlPath === '/' ? 'index.html' : join(urlPath.replace(/^\/|\/$/g, ''), 'index.html');
  const out = join(DIST, rel);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, html);
}

/* ----------------------------------------------------- meta length rules
   Titles stay under 60 characters and descriptions land at 150-160, the
   range Google shows without truncating. Each page type supplies a few
   phrasings, and these pick the first one that fits instead of cutting a
   sentence off mid-word. */

function fitTitle(candidates) {
  const fit = candidates.find((t) => t && t.length < 60);
  if (fit) return fit;
  const last = candidates[candidates.length - 1];
  return `${last.slice(0, 56).replace(/\s+\S*$/, '')}...`;
}

const DEFAULT_FILLERS = [' See hours.', ' Free to use.', ' Updated regularly.', ' No sign-up needed.', ' Independent directory.', ' Directions included.'];

function fitDescription(core, extras = [], fillers = []) {
  const finish = (str) => (/[.!?]$/.test(str) ? str : `${str}.`);
  const pads = [...fillers, ...DEFAULT_FILLERS.filter((f) => !fillers.includes(f))].slice(0, 6);
  let best = null;
  for (let mask = (1 << extras.length) - 1; mask >= 0; mask--) {
    const base = finish(core + extras.filter((_, i) => mask & (1 << i)).join(''));
    for (let fm = 0; fm < 1 << pads.length; fm++) {
      const str = base + pads.filter((_, i) => fm & (1 << i)).join('');
      if (str.length >= 150 && str.length <= 160) return str;
      if (str.length <= 160 && (!best || str.length > best.length)) best = str;
    }
  }
  if (best) return best;
  return `${core.slice(0, 157).replace(/\s+\S*$/, '')}...`;
}

/* ------------------------------------------------------------------ hours
   Outscraper gives each day as display text ("10AM-6PM", "11 AM–9 PM",
   "Closed", "Open 24 hours", or split windows joined with " / "). These
   helpers only read that text; when a string will not parse, the page
   shows it verbatim and makes no claim derived from it. */

function normaliseHourText(t) {
  return String(t || '').replace(/[–—]/g, '-').replace(/[  ]/g, ' ').replace(/\s+/g, ' ').trim();
}

function toMinutes(h, m, mer) {
  let hour = Number(h) % 12;
  if (mer === 'PM') hour += 12;
  return hour * 60 + Number(m || 0);
}

function parseWindow(text) {
  const m = text.match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?\s*-\s*(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/i);
  if (!m) return null;
  const closeMer = m[6].toUpperCase();
  let openMer = m[3] ? m[3].toUpperCase() : closeMer;
  let open = toMinutes(m[1], m[2], openMer);
  let close = toMinutes(m[4], m[5], closeMer);
  if (!m[3] && open > close) open = toMinutes(m[1], m[2], 'AM');
  if (close <= open) close += 24 * 60;
  return { open, close };
}

function parseDay(text) {
  const t = normaliseHourText(text);
  if (!t) return null;
  if (/^closed$/i.test(t)) return { closed: true };
  if (/24 hours/i.test(t)) return { open: 0, close: 24 * 60, allDay: true };
  const windows = t.split(/\s*[\/,]\s*/).map(parseWindow);
  if (!windows.length || windows.some((w) => !w)) return null;
  return { open: Math.min(...windows.map((w) => w.open)), close: Math.max(...windows.map((w) => w.close)) };
}

function formatMinutes(mins) {
  const m = mins % (24 * 60);
  const h = Math.floor(m / 60);
  const mm = m % 60;
  const mer = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}${mm ? `:${String(mm).padStart(2, '0')}` : ''} ${mer}`;
}

const prettyHours = (t) =>
  esc(normaliseHourText(t).replace(/(\d)(AM|PM)/gi, '$1 $2').replace(/\s*-\s*/g, ' to ').replace(/\s*\/\s*/g, ', '));

const DAY_SHORT = { monday: 'Mon', tuesday: 'Tue', wednesday: 'Wed', thursday: 'Thu', friday: 'Fri', saturday: 'Sat', sunday: 'Sun' };

/** Facts that can be stated safely because every day involved parsed. */
function hoursFacts(l) {
  if (!l.hours) return null;
  const days = DAYS.map((d) => ({ day: d, raw: l.hours[d], parsed: l.hours[d] ? parseDay(l.hours[d]) : null }));
  const known = days.filter((d) => d.parsed);
  const allKnown = known.length === 7;
  const openDays = known.filter((d) => !d.parsed.closed);
  const closedDays = known.filter((d) => d.parsed.closed).map((d) => d.day);
  let latest = null;
  for (const d of openDays) if (!latest || d.parsed.close > latest.parsed.close) latest = d;
  let earliest = null;
  for (const d of openDays) if (!earliest || d.parsed.open < earliest.parsed.open) earliest = d;
  return {
    allKnown,
    openDays: openDays.length,
    closedDays,
    openSunday: days[6].parsed ? !days[6].parsed.closed : null,
    latestEveryDay: allKnown && openDays.length > 1 && latest ? openDays.every((d) => d.parsed.close === latest.parsed.close) : false,
    latest: latest && !latest.parsed.allDay ? { day: latest.day, time: latest.parsed.close } : null,
    earliest: earliest && !earliest.parsed.allDay ? { day: earliest.day, time: earliest.parsed.open } : null,
  };
}

/** Collapses consecutive days with identical hours: "Mon to Fri: 10 AM to 6 PM". */
function groupedHours(l) {
  if (!l.hours) return [];
  const groups = [];
  for (const d of DAYS) {
    const text = normaliseHourText(l.hours[d] || 'Not listed');
    const last = groups[groups.length - 1];
    if (last && last.text === text) last.days.push(d);
    else groups.push({ text, days: [d] });
  }
  return groups.map((g) => ({
    label: g.days.length === 1 ? DAY_SHORT[g.days[0]] : `${DAY_SHORT[g.days[0]]} to ${DAY_SHORT[g.days[g.days.length - 1]]}`,
    text: g.text === 'Not listed' ? 'Not listed' : prettyHours(g.text),
  }));
}

function hoursTable(l) {
  if (!l.hours) return '<p class="missing">Hours are not listed for this business. Call ahead before you go.</p>';
  return `<table class="hours-table" data-hours>
  <tbody>
${DAYS.map((d) => `    <tr data-day="${d}"><th scope="row">${cap(d)}</th><td>${l.hours[d] ? prettyHours(l.hours[d]) : '<span class="missing">Not listed</span>'}</td></tr>`).join('\n')}
  </tbody>
</table>`;
}

function hoursCompact(l) {
  if (!l.hours) return '<span class="missing">Not listed. Call ahead.</span>';
  return groupedHours(l).map((g) => `<span class="hours-line"><b>${g.label}</b> ${g.text}</span>`).join('');
}

function openingHoursSpec(l) {
  if (!l.hours) return undefined;
  const specs = [];
  for (const d of DAYS) {
    const p = l.hours[d] ? parseDay(l.hours[d]) : null;
    if (!p || p.closed) continue;
    const t = (mins) => {
      const m = Math.min(mins, 24 * 60 - 1) % (24 * 60);
      return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    };
    specs.push({ '@type': 'OpeningHoursSpecification', dayOfWeek: cap(d), opens: t(p.open), closes: p.allDay ? '23:59' : t(p.close) });
  }
  return specs.length ? specs : undefined;
}

/* ---------------------------------------------------------------- images */

const IMAGE_SIZES = {
  thumb: { width: 320, height: 220 },
  card: { width: 480, height: 320 },
  hero: { width: 960, height: 540 },
};
const FALLBACK_IMAGES = [
  '/assets/img/fallbacks/chocolate-bar.svg',
  '/assets/img/fallbacks/truffles.svg',
  '/assets/img/fallbacks/hot-chocolate.svg',
  '/assets/img/fallbacks/bonbons.svg',
];
const fallbackImageFor = (l) => FALLBACK_IMAGES[seededHash(l.slug || l.name || '') % FALLBACK_IMAGES.length];

let expiredPhotoCount = 0;
function usablePhoto(l) {
  if (!l.photo) return null;
  const fetched = Date.parse(l.photoFetchedAt || data.exportedAt || data.importedAt || '');
  if (!Number.isFinite(fetched) || (NOW - fetched) / 86400000 > PHOTO_MAX_AGE_DAYS) return null;
  return l.photo;
}
for (const l of listings) if (l.photo && !usablePhoto(l)) expiredPhotoCount++;

function resizedPhotoUrl(url, { width, height }) {
  if (!url.includes('googleusercontent.com')) return url;
  return url.replace(/=w\d+-h\d+[^&]*$/, `=w${width}-h${height}-k-no`);
}

/** The real photo while its signed URL is still fresh, the local fallback
 *  otherwise, and onerror swaps to the fallback if Google revokes it early. */
function listingImage(l, size = 'card', { eager = false } = {}) {
  const preset = IMAGE_SIZES[size];
  const fallback = fallbackImageFor(l);
  const photo = usablePhoto(l);
  const src = photo ? resizedPhotoUrl(photo, preset) : fallback;
  const altText = photo ? `${l.name} in ${l.city}, ${l.stateCode}` : `Illustration standing in for a photo of ${l.name}`;
  return `<img src="${attr(src)}" alt="${attr(altText)}" width="${preset.width}" height="${preset.height}" ${eager ? 'fetchpriority="high"' : 'loading="lazy"'} decoding="async"${photo ? ` referrerpolicy="no-referrer" onerror="this.onerror=null;this.src='${fallback}';this.alt='';"` : ''}>`;
}

/* --------------------------------------------------------------- ranking */

const ratedListings = listings.filter((l) => l.rating && l.reviews);
const globalMean = ratedListings.length
  ? ratedListings.reduce((s, l) => s + l.rating * l.reviews, 0) / ratedListings.reduce((s, l) => s + l.reviews, 0)
  : 4.5;

function rankScore(l) {
  if (!l.rating) return 0;
  const v = l.reviews || 0;
  return (v / (v + RANK_PRIOR_REVIEWS)) * l.rating + (RANK_PRIOR_REVIEWS / (v + RANK_PRIOR_REVIEWS)) * globalMean;
}
for (const l of listings) l.score = rankScore(l);

function rankListings(items) {
  return [...items].sort(
    (a, b) => b.score - a.score || (b.reviews || 0) - (a.reviews || 0) || a.name.localeCompare(b.name)
  );
}

/* ------------------------------------------------------------------ paths */

const RESERVED_ROOT = new Set(['blog', 'states', 'search', 'map', 'find', 'about', 'contact', 'disclaimer', 'privacy', 'terms', 'sitemap', 'assets', 'data']);
const statePath = (s) => `/states/${slugify(s)}/`;
const cityPath = (s, c) => `/${slugify(s)}/${slugify(c)}/`;
const mapPath = (s) => `/map/${slugify(s)}/`;
const findPath = (cat) => `/find/${cat.slug}/`;
const findStatePath = (cat, s) => `/find/${cat.slug}/${slugify(s)}/`;

// Listing URLs nest under their city: /<state>/<city>/<business-name>/.
// Name slugs are de-duplicated per city, once, so every page agrees.
const usedByCity = new Map();
for (const l of rankListings(listings)) {
  const key = `${slugify(l.state)}/${slugify(l.city)}`;
  if (RESERVED_ROOT.has(slugify(l.state))) throw new Error(`State slug collides with a site route: ${l.state}`);
  if (!usedByCity.has(key)) usedByCity.set(key, new Set());
  const used = usedByCity.get(key);
  const base = slugify(l.name) || 'chocolate-shop';
  let s = base;
  let n = 2;
  while (used.has(s)) s = `${base}-${n++}`;
  used.add(s);
  l.url = `/${key}/${s}/`;
}

/* -------------------------------------------------------- data aggregates */

const byState = new Map();
const byCity = new Map();
for (const l of listings) {
  if (!byState.has(l.state)) byState.set(l.state, []);
  byState.get(l.state).push(l);
  const key = `${l.state}|${l.city}`;
  if (!byCity.has(key)) byCity.set(key, []);
  byCity.get(key).push(l);
}
for (const [k, v] of byState) byState.set(k, rankListings(v));
for (const [k, v] of byCity) byCity.set(k, rankListings(v));
const stateNames = [...byState.keys()].sort();

const realCount = (items) => items.filter((l) => !l.sample).length;
const citiesIn = (stateName) =>
  [...byCity.entries()]
    .filter(([k]) => k.startsWith(`${stateName}|`))
    .map(([k, items]) => ({ city: k.split('|')[1], items }))
    .sort((a, b) => b.items.length - a.items.length || a.city.localeCompare(b.city));

const centroid = (items) => ({
  lat: items.reduce((s, l) => s + l.lat, 0) / items.length,
  lng: items.reduce((s, l) => s + l.lng, 0) / items.length,
});
const cityCentroids = new Map([...byCity].map(([k, items]) => [k, centroid(items)]));
const stateCentroids = new Map([...byState].map(([k, items]) => [k, centroid(items)]));

function nearbyCities(stateName, cityName, count) {
  const own = cityCentroids.get(`${stateName}|${cityName}`);
  return [...cityCentroids.entries()]
    .filter(([k]) => k !== `${stateName}|${cityName}` && k.startsWith(`${stateName}|`))
    .map(([k, c]) => ({ city: k.split('|')[1], miles: haversineMiles(own.lat, own.lng, c.lat, c.lng), n: byCity.get(k).length }))
    .sort((a, b) => a.miles - b.miles)
    .slice(0, count);
}

function nearbyStates(stateName, count) {
  const own = stateCentroids.get(stateName);
  return stateNames
    .filter((s) => s !== stateName)
    .map((s) => ({ state: s, miles: haversineMiles(own.lat, own.lng, stateCentroids.get(s).lat, stateCentroids.get(s).lng) }))
    .sort((a, b) => a.miles - b.miles)
    .slice(0, count);
}

function nearbyListings(l, count) {
  return byState.get(l.state)
    .filter((o) => o !== l)
    .map((o) => ({ l: o, miles: haversineMiles(l.lat, l.lng, o.lat, o.lng) }))
    .sort((a, b) => a.miles - b.miles)
    .slice(0, count);
}

const catFor = (feature) => categories.find((c) => c.feature === feature);
const withFeature = (items, cat) => items.filter((l) => (l.features || []).includes(cat.feature));

const stats = { listings: listings.length, states: byState.size, cities: byCity.size };

/* ---------------------------------------------------------- shared blocks */

function ratingHtml(l, { long = false } = {}) {
  if (!l.rating) return '<span class="rating rating-none">No Google rating on file</span>';
  const pct = Math.max(0, Math.min(100, (l.rating / 5) * 100)).toFixed(0);
  const count = l.reviews ? ` <span class="rating-count">(${plural(l.reviews, 'Google review', 'Google reviews')})</span>` : '';
  return `<span class="rating"><span class="stars" style="--pct:${pct}%" role="img" aria-label="Rated ${l.rating.toFixed(1)} out of 5"></span><b>${l.rating.toFixed(1)}</b>${long ? ' out of 5' : ''}${count}</span>`;
}

function websiteLabel(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'Website';
  }
}

const addressOf = (l) => l.fullAddress || [l.street, [l.city, l.stateCode].filter(Boolean).join(', '), l.postalCode].filter(Boolean).join(', ');
const hasStreetAddress = (l) => Boolean(l.street || l.fullAddress);
const directionsUrl = (l) =>
  l.placeId
    ? `https://www.google.com/maps/search/?api=1&amp;query=${encodeURIComponent(l.name)}&amp;query_place_id=${encodeURIComponent(l.placeId)}`
    : `https://www.google.com/maps/dir/?api=1&amp;destination=${l.lat},${l.lng}`;
const telHref = (phone) => `tel:${String(phone).replace(/[^\d+]/g, '')}`;
const EXT = 'target="_blank" rel="nofollow noopener noreferrer"';

function factsList(l) {
  return `<dl class="facts">
  <div><dt>Address</dt><dd>${hasStreetAddress(l) ? esc(addressOf(l)) : '<span class="missing">Street address not listed</span>'}</dd></div>
  <div><dt>Phone</dt><dd>${l.phone ? `<a href="${telHref(l.phone)}">${esc(l.phone)}</a>` : '<span class="missing">Not listed</span>'}</dd></div>
  <div><dt>Website</dt><dd>${l.website ? `<a href="${attr(l.website)}" ${EXT}>${esc(websiteLabel(l.website))}</a>` : '<span class="missing">Not listed</span>'}</dd></div>
  <div><dt>Hours</dt><dd>${hoursCompact(l)}</dd></div>
</dl>`;
}

function chipsFor(l, scopeState = true) {
  const cats = (l.features || []).map(catFor).filter(Boolean);
  if (!cats.length) return '';
  return `<ul class="chips">${cats
    .map((c) => `<li><a class="chip" href="${scopeState ? findStatePath(c, l.state) : findPath(c)}">${esc(c.short)}</a></li>`)
    .join('')}</ul>`;
}

/* ------------------------------------------------- data-grounded summaries
   Every sentence restates something in the listing itself (rating, review
   count and spread, Google description, category tags, parsed hours). If a
   field is missing, the sentence says so instead of filling the gap. */

const OPENERS = [
  (n) => `${n} leads the list`,
  (n) => `Close behind is ${n}`,
  (n, r) => `At number ${r} is ${n}`,
  (n) => `Next up is ${n}`,
  (n, r) => `${n} comes in at number ${r}`,
  (n) => `${n} holds its place here`,
];

function ratingClause(l) {
  if (!l.rating) return ', which has no Google rating on file yet, so it sits below the rated shops';
  const reviews = l.reviews ? ` from ${plural(l.reviews, 'review', 'reviews')}` : '';
  return ` with a ${l.rating.toFixed(1)} average${reviews} on Google`;
}

function hoursSentence(l) {
  const f = hoursFacts(l);
  if (!f) return 'Hours are not listed, so call before you go.';
  const parts = [];
  if (f.allKnown && f.openDays === 7) parts.push('It is open seven days a week');
  else if (f.allKnown && f.closedDays.length && f.closedDays.length < 7) parts.push(`It is closed ${joinNatural(f.closedDays.map((d) => `${cap(d)}s`))}`);
  if (f.latest && f.latest.time >= 19 * 60) {
    const when = f.latestEveryDay ? 'every day it opens' : `on ${cap(f.latest.day)}s`;
    parts.push(`${parts.length ? 'stays' : 'It stays'} open until ${formatMinutes(f.latest.time)} ${f.latestEveryDay && f.openDays === 7 ? 'daily' : when}`);
  }
  if (!parts.length) return 'Check the hours before you go; they vary by day.';
  return `${parts.join(' and ')}.`;
}

function reviewSpreadSentence(l) {
  const r = l.reviewsPerScore;
  if (!r) return '';
  const total = [1, 2, 3, 4, 5].reduce((s, k) => s + (r[k] || 0), 0);
  if (total < 20) return '';
  const fives = Math.round(((r[5] || 0) / total) * 100);
  return ` ${fives}% of its Google reviews are five stars.`;
}

function featureSentence(l) {
  const cats = (l.features || []).map(catFor).filter(Boolean).map((c) => c.short.toLowerCase());
  if (!cats.length) return '';
  return ` Its Google category points to ${joinNatural(cats.slice(0, 3))}.`;
}

function summaryHtml(l, rank) {
  const name = `<strong>${esc(l.name)}</strong>`;
  const opener = rank === 1 ? OPENERS[0](name) : OPENERS[1 + ((rank - 2) % (OPENERS.length - 1))](name, rank);
  const desc = l.description ? ` Google describes it as: "${esc(l.description.replace(/\s+/g, ' ').trim())}"` : '';
  return `${opener}${ratingClause(l)}.${desc}${featureSentence(l)}${reviewSpreadSentence(l)} ${hoursSentence(l)}`;
}

function compactSummary(l) {
  return `${l.rating ? `Rated ${l.rating.toFixed(1)}${l.reviews ? ` from ${plural(l.reviews, 'review', 'reviews')}` : ''}.` : 'No Google rating on file.'} ${hoursSentence(l)}`;
}

/** Per-day "open-close" minutes (x = closed, empty = unknown) plus the
 *  shop's own time zone, so "Open now" is computed in the shop's local time. */
function hoursData(l) {
  if (!l.hours || !l.timeZone) return '';
  const days = DAYS.map((d) => {
    const p = l.hours[d] ? parseDay(l.hours[d]) : null;
    return !p ? '' : p.closed ? 'x' : `${p.open}-${p.close}`;
  });
  if (days.every((d) => d === '')) return '';
  return ` data-tz="${attr(l.timeZone)}" data-h="${days.join('|')}"`;
}

function entryData(l) {
  return `${hoursData(l).trim()} data-name="${attr(l.name.toLowerCase())}" data-city="${attr(l.city.toLowerCase())}" data-score="${l.score.toFixed(4)}" data-reviews="${l.reviews || 0}" data-lat="${l.lat}" data-lng="${l.lng}"`;
}

function renderEntry(l, rank, { showCity = true } = {}) {
  const place = showCity ? `<span class="entry-place">${esc(l.city)}, ${esc(l.stateCode)}</span>` : '';
  return `<li class="entry" id="${attr(l.slug)}" ${entryData(l)}>
  <div class="entry-head"><span class="entry-rank" aria-hidden="true">${rank}</span><h3><a href="${l.url}">${esc(l.name)}</a></h3>${l.sample ? '<span class="tag-sample">Placeholder</span>' : ''}</div>
  <div class="entry-grid">
    <a class="entry-media" href="${l.url}" tabindex="-1" aria-hidden="true">${listingImage(l, 'thumb')}</a>
    <div class="entry-body">
      <p class="entry-meta">${ratingHtml(l)}${place}</p>
      <p class="entry-summary">${summaryHtml(l, rank)}</p>
      ${factsList(l)}
      ${chipsFor(l)}
      <div class="entry-actions">
        <a class="btn btn-primary btn-sm" href="${l.url}">Full details</a>
        <a class="btn btn-outline btn-sm" href="${directionsUrl(l)}" ${EXT}>Directions</a>
        ${l.phone ? `<a class="btn btn-ghost btn-sm" href="${telHref(l.phone)}">Call</a>` : ''}
      </div>
    </div>
  </div>
</li>`;
}

function renderCompactEntry(l, rank, { showCity = true } = {}) {
  return `<li class="entry entry-compact" id="${attr(l.slug)}" ${entryData(l)}>
  <div class="entry-head"><span class="entry-rank" aria-hidden="true">${rank}</span><h3><a href="${l.url}">${esc(l.name)}</a></h3>${l.sample ? '<span class="tag-sample">Placeholder</span>' : ''}</div>
  <p class="entry-meta">${ratingHtml(l)}${showCity ? `<span class="entry-place">${esc(l.city)}, ${esc(l.stateCode)}</span>` : ''}</p>
  <p class="entry-summary">${compactSummary(l)}</p>
  ${factsList(l)}
  ${chipsFor(l)}
</li>`;
}

/* -------------------------------------------------------------------- ads
   Every slot reserves its height in CSS (.ad-slot min-height), so an ad
   arriving late fills space that is already there instead of pushing the
   page down. Units go where the page already breaks: between list entries,
   between sections, after an article's opening. */

function renderAdSlot(type = 'display') {
  const ins = type === 'inFeed'
    ? `<ins class="adsbygoogle" style="display:block" data-ad-client="${AD_CLIENT}" data-ad-slot="${AD_SLOTS.inFeed}" data-ad-format="fluid" data-ad-layout-key="${AD_INFEED_LAYOUT_KEY}"></ins>`
    : `<ins class="adsbygoogle" style="display:block" data-ad-client="${AD_CLIENT}" data-ad-slot="${AD_SLOTS.display}" data-ad-format="auto" data-full-width-responsive="true"></ins>`;
  return `<div class="ad-slot ad-slot-${type}" aria-label="Advertisement"><p class="ad-label">Advertisement</p>${ins}</div>`;
}

/** Numbered list with in-feed units after entry 3, entry 10, and every 15
 *  after that, capped at four per list so it never reads as more ad than list. */
function listWithAds(entriesHtml) {
  const out = [];
  let ads = 0;
  entriesHtml.forEach((html, i) => {
    out.push(html);
    const pos = i + 1;
    if (ads < 4 && pos < entriesHtml.length && (pos === 3 || pos === 10 || (pos > 10 && (pos - 10) % 15 === 0))) {
      out.push(`<li class="entry-ad" aria-hidden="true">${renderAdSlot('inFeed')}</li>`);
      ads++;
    }
  });
  return out.join('\n');
}

function injectInArticleAd(bodyHtml) {
  const idx = bodyHtml.indexOf('</p>');
  if (idx === -1) return bodyHtml;
  const cut = idx + 4;
  return `${bodyHtml.slice(0, cut)}\n${renderAdSlot('display')}${bodyHtml.slice(cut)}`;
}

/* --------------------------------------------------------------- toolbar */

function hubToolbar(items, { cityFilter = true } = {}) {
  const cities = [...new Set(items.map((l) => l.city))].sort();
  return `<div class="toolbar" data-hub-toolbar hidden>
  <label class="toolbar-field"><span>Search this list</span><input type="search" data-filter-q placeholder="Shop name or city" autocomplete="off"></label>
  ${cityFilter && cities.length > 1 ? `<label class="toolbar-field"><span>City</span><select data-filter-city><option value="">All cities</option>${cities.map((c) => `<option value="${attr(c.toLowerCase())}">${esc(c)}</option>`).join('')}</select></label>` : ''}
  <label class="toolbar-field"><span>Sort</span><select data-filter-sort><option value="rank">Our ranking</option><option value="reviews">Most reviewed</option><option value="name">Name A to Z</option><option value="distance">Nearest to me</option></select></label>
  <label class="toolbar-check"><input type="checkbox" data-filter-open> Open now</label>
  <p class="toolbar-count" data-filter-count aria-live="polite"></p>
</div>`;
}

const hubScripts = `<script src="/assets/js/hub-filter.js?v=${ASSET_VERSION}" defer></script>`;

/* --------------------------------------------------- breadcrumbs, JSON-LD */

function breadcrumbs(trail) {
  if (!trail || !trail.length) return '';
  const items = [{ label: 'Home', href: '/' }, ...trail];
  return `<nav class="breadcrumbs" aria-label="Breadcrumb"><ol>${items
    .map((i, idx) => (idx === items.length - 1 ? `<li aria-current="page">${esc(i.label)}</li>` : `<li><a href="${i.href}">${esc(i.label)}</a></li>`))
    .join('')}</ol></nav>`;
}

function breadcrumbJsonLd(trail, currentPath) {
  const items = [{ label: 'Home', href: '/' }, ...trail];
  return {
    '@type': 'BreadcrumbList',
    itemListElement: items.map((i, idx) => ({
      '@type': 'ListItem',
      position: idx + 1,
      name: i.label,
      item: SITE_URL + (idx === items.length - 1 ? currentPath : i.href),
    })),
  };
}

const ORG = { '@type': 'Organization', '@id': `${SITE_URL}/#org`, name: SITE_NAME, url: `${SITE_URL}/`, logo: `${SITE_URL}/assets/img/icon-512.png`, sameAs: Object.values(SOCIAL) };

function pageJsonLd(meta, extraNodes = []) {
  const nodes = [
    {
      '@type': meta.schemaType || 'WebPage',
      '@id': `${SITE_URL}${meta.path}#page`,
      name: meta.title,
      description: meta.description,
      url: SITE_URL + meta.path,
      isPartOf: { '@type': 'WebSite', name: SITE_NAME, url: `${SITE_URL}/` },
      publisher: { '@id': ORG['@id'] },
    },
    ORG,
  ];
  if (meta.trail && meta.trail.length) nodes.push(breadcrumbJsonLd(meta.trail, meta.path));
  return { '@context': 'https://schema.org', '@graph': [...nodes, ...extraNodes] };
}

function faqHtml(items) {
  return `<div class="faq">
${items.map((f) => `  <details><summary>${esc(f.q)}</summary><div class="faq-a"><p>${f.aHtml || esc(f.a)}</p></div></details>`).join('\n')}
</div>`;
}
const faqJsonLd = (items) => ({
  '@type': 'FAQPage',
  mainEntity: items.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
});

/* ------------------------------------------------ paragraph shortening ---
   Caps body paragraphs at roughly three to four rendered lines by breaking
   long ones at sentence boundaries (ported from the reference directory).
   Only bare <p> is touched, a break is only taken where no inline tag is
   open, and sentence detection is conservative: it would rather leave a
   long paragraph alone than cut one mid-sentence. */
const PARA_TARGET_CHARS = 300;
const PARA_MIN_TAIL_CHARS = 90;
const PARA_ABBREVIATIONS = new Set([
  'etc', 'vs', 'al', 'approx', 'est', 'no', 'ft', 'mi', 'lb', 'oz', 'min', 'max',
  'inc', 'ltd', 'co', 'jr', 'sr', 'mr', 'mrs', 'ms', 'dr', 'st', 'mt', 'ave', 'rd', 'blvd',
]);

function sentenceBreaks(inner) {
  const breaks = [];
  let depth = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === '<') {
      const close = inner.indexOf('>', i);
      if (close === -1) break;
      const tag = inner.slice(i, close + 1);
      if (!/^<[^>]*\/>$/.test(tag) && !/^<(br|img|hr|wbr)\b/i.test(tag)) {
        if (tag[1] === '/') depth--; else depth++;
      }
      i = close;
      continue;
    }
    if (depth !== 0) continue;
    if (ch !== '.' && ch !== '!' && ch !== '?') continue;
    if (!/^[.!?]["'”’)]?\s+[A-Z“"'(]/.test(inner.slice(i))) continue;
    if (ch === '.') {
      const before = inner.slice(0, i);
      if (!/[a-z0-9)\]"'”’]$/.test(before)) continue;
      const word = (before.match(/([A-Za-z]+)$/) || [])[1];
      if (word && PARA_ABBREVIATIONS.has(word.toLowerCase())) continue;
    }
    const after = inner.slice(i + 1).match(/^["'”’)]?\s+/);
    breaks.push(i + 1 + (after ? after[0].length : 0));
  }
  return breaks;
}

const stripTags = (html) => html.replace(/<[^>]+>/g, '');

function splitLongParagraphs(html) {
  return html.replace(/<p>([\s\S]*?)<\/p>/g, (whole, inner) => {
    if (stripTags(inner).trim().length <= PARA_TARGET_CHARS) return whole;
    const breaks = sentenceBreaks(inner);
    if (!breaks.length) return whole;
    const sentences = [];
    let prev = 0;
    for (const at of breaks) { sentences.push(inner.slice(prev, at)); prev = at; }
    sentences.push(inner.slice(prev));
    const chunks = [];
    let current = '';
    for (const sentence of sentences) {
      if (current && stripTags(current + sentence).trim().length > PARA_TARGET_CHARS) {
        chunks.push(current);
        current = sentence;
      } else current += sentence;
    }
    if (current) chunks.push(current);
    if (chunks.length < 2) return whole;
    if (stripTags(chunks[chunks.length - 1]).trim().length < PARA_MIN_TAIL_CHARS) chunks[chunks.length - 2] += chunks.pop();
    return chunks.map((c) => `<p>${c.trim()}</p>`).join('\n');
  });
}

/* ------------------------------------------------------- page assembly */

const sitemapEntries = [];
const pageReport = [];

function layoutContent(meta, body) {
  const layout = meta.layout || 'prose';
  if (layout === 'raw') return body;
  const head = `<div class="page-head">
  <div class="${layout === 'wide' ? 'wrap' : 'wrap-narrow'}">
    ${breadcrumbs(meta.trail)}
    <h1>${esc(meta.h1 || meta.title)}</h1>
    ${meta.lede ? `<p class="lede">${meta.lede}</p>` : ''}
  </div>
</div>`;
  return `${head}
<div class="section">
  <div class="${layout === 'wide' ? 'wrap' : 'wrap-narrow prose'}">
${body}
  </div>
</div>`;
}

function render(meta, body, opts = {}) {
  const content = splitLongParagraphs(layoutContent(meta, body));
  const replacements = {
    '{{TITLE}}': esc(meta.title),
    '{{DESCRIPTION}}': attr(meta.description),
    '{{CANONICAL}}': SITE_URL + meta.path,
    '{{ROBOTS}}': meta.noindex ? 'noindex, follow' : 'index, follow, max-image-preview:large, max-snippet:-1',
    '{{SITE_URL}}': SITE_URL,
    '{{SITE_NAME}}': SITE_NAME,
    '{{AD_CLIENT}}': AD_CLIENT,
    '{{OG_TYPE}}': meta.ogType || 'website',
    '{{BODY_CLASS}}': meta.bodyClass || 'page',
    '{{HEAD_EXTRA}}': opts.headExtra || '',
    '{{SCRIPTS}}': opts.scripts || '',
    '{{JSONLD}}': JSON.stringify(opts.jsonld || pageJsonLd(meta)).replace(/</g, '\\u003c'),
    '{{CONTENT}}': content,
    '{{YEAR}}': String(new Date().getFullYear()),
    '{{ASSET_VERSION}}': ASSET_VERSION,
    '{{SOCIAL_INSTAGRAM}}': SOCIAL.instagram,
    '{{SOCIAL_TWITTER}}': SOCIAL.twitter,
    '{{SOCIAL_FACEBOOK}}': SOCIAL.facebook,
  };
  for (const key of ['home', 'blog', 'states', 'about', 'search']) {
    replacements[`{{NAV_${key.toUpperCase()}}}`] = meta.nav === key ? ' aria-current="page"' : '';
  }
  let html = template;
  for (const [token, value] of Object.entries(replacements)) html = html.split(token).join(value);
  const leftover = html.match(/\{\{[A-Z_]+\}\}/);
  if (leftover) throw new Error(`Unfilled token ${leftover[0]} on ${meta.path}`);
  return html;
}

function emit(meta, body, opts = {}) {
  writePage(meta.path, render(meta, body, opts));
  pageReport.push({ path: meta.path, title: meta.title, description: meta.description, noindex: Boolean(meta.noindex) });
  if (!meta.noindex) sitemapEntries.push({ path: meta.path, priority: opts.priority ?? 0.5, lastmod: opts.lastmod || BUILD_DATE });
}

/* ----------------------------------------------------------- page sources */

function readPageFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.html'))
    .map((e) => {
      const raw = readFileSync(join(dir, e.name), 'utf8');
      const match = raw.match(/^<!--meta\s*([\s\S]*?)-->\s*/);
      if (!match) throw new Error(`Missing <!--meta --> block in ${join(dir, e.name)}`);
      return { file: basename(e.name, '.html'), meta: JSON.parse(match[1]), body: raw.slice(match[0].length) };
    });
}

/* ================================================================== build */

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

/* --- blog posts (informational only: no local "near me" intent) ---------- */

const posts = readPageFiles(join(SRC, 'pages/blog'))
  .map((p) => ({ ...p, meta: { ...p.meta, path: `/blog/${p.meta.slug}/` } }))
  .sort((a, b) => (b.meta.date || '').localeCompare(a.meta.date || ''));

function blogTeasers(list) {
  return `<div class="post-grid">
${list.map((p) => `  <article class="post-card">
    <p class="post-card-meta">${esc(new Date(`${p.meta.date}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }))} &middot; ${esc(p.meta.readingTime)}</p>
    <h3><a href="${p.meta.path}">${esc(p.meta.h1 || p.meta.title)}</a></h3>
    <p>${esc(p.meta.excerpt)}</p>
  </article>`).join('\n')}
</div>`;
}

for (const post of posts) {
  const meta = {
    ...post.meta,
    nav: 'blog',
    layout: 'prose',
    ogType: 'article',
    schemaType: 'WebPage',
    trail: [{ label: 'Blog', href: '/blog/' }, { label: post.meta.h1 || post.meta.title }],
  };
  const dateLabel = new Date(`${meta.date}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  const related = posts.filter((p) => p !== post).slice(0, 3);
  const body = `<p class="byline">By the ${SITE_NAME} editors &middot; <time datetime="${meta.date}">${dateLabel}</time> &middot; ${esc(meta.readingTime)}</p>
${injectInArticleAd(post.body.trim())}
${renderAdSlot('display')}
<aside class="callout">
  <h2>Looking for a chocolate shop?</h2>
  <p>Our directory ranks chocolate shops and chocolatiers in every state we cover, with hours, phone numbers and addresses. <a href="/states/">Browse by state</a> or <a href="/">find chocolate near you</a>.</p>
</aside>
${related.length ? `<h2>Keep reading</h2>
<ul class="link-list">
${related.map((p) => `  <li><a href="${p.meta.path}">${esc(p.meta.h1 || p.meta.title)}</a></li>`).join('\n')}
</ul>` : ''}`;
  emit(meta, body, {
    priority: 0.5,
    lastmod: meta.updated || meta.date,
    jsonld: pageJsonLd(meta, [{
      '@type': 'BlogPosting',
      headline: meta.h1 || meta.title,
      description: meta.description,
      datePublished: meta.date,
      dateModified: meta.updated || meta.date,
      mainEntityOfPage: SITE_URL + meta.path,
      author: { '@id': ORG['@id'] },
      publisher: { '@id': ORG['@id'] },
      image: `${SITE_URL}/assets/img/og-image.png`,
    }]),
  });
}

/* --- programmatic state listicles (blog) ----------------------------------
   Three "Best X in <State> (<Year>) List" posts per state, built from the
   same ranked data as the state hub. To stay clear of the hub's "near me"
   intent they carry only the top 10, use "best ... list" titles, and link
   to the hub at the top and bottom for the full directory. A state needs
   LISTICLE_MIN real matching shops or the post is not generated at all:
   no padded lists. */

const LISTICLE_MIN = 3;
const LISTICLE_MAX = 10;
const SEASON_YEAR = new Date().getFullYear();
const LISTICLE_TYPES = [
  {
    key: 'chocolate-shops',
    noun: 'Chocolate Shops',
    nounOne: 'Chocolate Shop',
    lower: 'chocolate shops',
    match: (l) => /chocolat/i.test(`${l.category || ''} ${l.subtypes || ''}`),
    rule: 'Google lists them as a chocolate shop, chocolatier, chocolate cafe or chocolate factory',
  },
  {
    key: 'candy-shops',
    noun: 'Candy Shops',
    nounOne: 'Candy Shop',
    lower: 'candy shops',
    match: (l) => (l.features || []).includes('Candy and confections'),
    rule: 'their Google category or description points to candy or confectionery',
  },
  {
    key: 'gourmet-chocolate-shops',
    noun: 'Gourmet Chocolate Shops',
    nounOne: 'Gourmet Chocolate Shop',
    lower: 'gourmet chocolate shops',
    match: (l) => (l.features || []).includes('Artisan chocolate') || (l.features || []).includes('Truffles and bonbons')
      || /gourmet|handmade|hand-made|artisan|fine chocolate|small[- ]batch/i.test(l.description || ''),
    rule: 'Google tags them as chocolate artisans, they sell truffles or bonbons, or their Google description calls their chocolate handmade, small-batch, artisan or gourmet',
  },
];

const listiclePath = (type, stateName) => `/blog/best-${type.key}-in-${slugify(stateName)}/`;
const stateListicles = new Map(); // stateName -> [{ title, path }]
const listiclePosts = [];
const dataDate = (data.exportedAt || data.importedAt || `${BUILD_DATE}T00:00:00Z`).slice(0, 10);

for (const stateName of stateNames) {
  for (const type of LISTICLE_TYPES) {
    const pool = byState.get(stateName).filter((l) => !l.sample && type.match(l));
    if (pool.length < LISTICLE_MIN) continue;
    const top = pool.slice(0, LISTICLE_MAX);
    const x = top.length;
    const path = listiclePath(type, stateName);
    const h1 = `${x} Best ${x === 1 ? type.nounOne : type.noun} in ${stateName} (${SEASON_YEAR} List)`;
    listiclePosts.push({ type, stateName, top, pool, path, h1 });
    if (!stateListicles.has(stateName)) stateListicles.set(stateName, []);
    stateListicles.get(stateName).push({ title: h1, path });
  }
}

for (const post of listiclePosts) {
  const { type, stateName, top, pool, path, h1 } = post;
  const x = top.length;
  const cities = [...new Set(top.map((l) => l.city))];
  const meta = {
    path,
    title: fitTitle([
      `${x} Best ${type.noun} in ${stateName} (${SEASON_YEAR} List)`,
      `${x} Best ${type.noun} in ${stateName} (${SEASON_YEAR})`,
      `Best ${type.noun} in ${stateName} (${SEASON_YEAR})`,
      `Best ${type.noun}: ${stateName}`,
    ]),
    description: fitDescription(
      `The ${x} best ${type.lower} in ${stateName} for ${SEASON_YEAR}, ranked by Google rating and review volume`,
      [', with hours, phone numbers, addresses and websites', `. Picks from ${plural(cities.length, 'city', 'cities')}.`, ' No paid placements.'],
      [' Updated with fresh data.', ' Directions included.']
    ),
    h1,
    layout: 'prose',
    nav: 'blog',
    ogType: 'article',
    trail: [{ label: 'Blog', href: '/blog/' }, { label: h1 }],
  };
  const hub = statePath(stateName);
  const siblings = (stateListicles.get(stateName) || []).filter((p) => p.path !== path);
  const leader = top[0];
  const intro = `Out of ${plural(pool.length, type.lower.replace(/s$/, ''), type.lower)} we track in ${esc(stateName)}, these ${x} have the strongest weighted Google ratings right now${leader.rating ? `, led by <a href="${leader.url}">${esc(leader.name)}</a> in ${esc(leader.city)} at ${leader.rating.toFixed(1)}` : ''}. The picks span ${joinNatural(cities.slice(0, 5).map(esc))}${cities.length > 5 ? ' and more' : ''}.`;
  const tableRows = top.map((l, i) => `<tr><td>${i + 1}</td><td><a href="#${attr(l.slug)}">${esc(l.name)}</a></td><td>${esc(l.city)}</td><td>${l.rating ? l.rating.toFixed(1) : '<span class="missing">n/a</span>'}</td><td>${l.reviews ? num(l.reviews) : '<span class="missing">n/a</span>'}</td></tr>`).join('\n');

  const faq = [
    {
      q: `What is the best ${type.lower.replace(/s$/, '')} in ${stateName}?`,
      a: leader.rating
        ? `${leader.name} in ${leader.city} tops this list with a ${leader.rating.toFixed(1)} average from ${num(leader.reviews || 0)} Google reviews.`
        : `${leader.name} in ${leader.city} tops this list.`,
    },
    {
      q: 'How was this list ranked?',
      a: `By a weighted Google rating: each shop's average is pulled toward the overall average until it has enough reviews to stand on its own. A shop qualifies when ${type.rule}. No business pays to appear.`,
    },
    {
      q: `Where can I see every ${type.lower.replace(/s$/, '')} in ${stateName}?`,
      a: `The ${stateName} chocolate shop directory lists all ${num(byState.get(stateName).length)} shops we track there, with filters, a city breakdown and an open-now toggle.`,
      aHtml: `The <a href="${hub}">${esc(stateName)} chocolate shop directory</a> lists all ${num(byState.get(stateName).length)} shops we track there, with filters, a city breakdown and an open-now toggle.`,
    },
  ];

  const body = `<p class="byline">By the ${SITE_NAME} editors &middot; Updated <time datetime="${dataDate}">${new Date(`${dataDate}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}</time></p>
<p>${intro}</p>
<p class="callout-inline">Want the full list instead of the top ${x}? See <a href="${hub}">all ${plural(byState.get(stateName).length, 'chocolate shop', 'chocolate shops')} in ${esc(stateName)}</a>, ranked and filterable by city.</p>
${renderAdSlot('display')}
<h2>At a glance</h2>
<div class="table-scroll"><table class="compare">
<thead><tr><th>#</th><th>Shop</th><th>City</th><th>Rating</th><th>Reviews</th></tr></thead>
<tbody>
${tableRows}
</tbody>
</table></div>
<h2>The list</h2>
<ol class="entries">
${listWithAds(top.map((l, i) => renderEntry(l, i + 1)))}
</ol>
<h2>How we picked these</h2>
<p>Every shop here comes from public Google business data, and qualifies because ${type.rule}. We rank by weighted rating so a handful of five-star reviews cannot outrank years of consistent ones. Hours and phone numbers come straight from each listing, and anything missing is marked as missing.</p>
<h2>Questions</h2>
${faqHtml(faq)}
<aside class="callout">
  <h2>More in ${esc(stateName)}</h2>
  <ul class="link-list">
    <li><a href="${hub}">Every chocolate shop in ${esc(stateName)}</a></li>
${siblings.map((p) => `    <li><a href="${p.path}">${esc(p.title)}</a></li>`).join('\n')}
    <li><a href="${mapPath(stateName)}">${esc(stateName)} chocolate shop map</a></li>
  </ul>
</aside>`;

  emit(meta, body, {
    priority: 0.6,
    lastmod: dataDate,
    jsonld: pageJsonLd(meta, [
      {
        '@type': 'BlogPosting',
        headline: h1,
        description: meta.description,
        datePublished: dataDate,
        dateModified: dataDate,
        mainEntityOfPage: SITE_URL + path,
        author: { '@id': ORG['@id'] },
        publisher: { '@id': ORG['@id'] },
        image: `${SITE_URL}/assets/img/og-image.png`,
      },
      {
        '@type': 'ItemList',
        name: h1,
        numberOfItems: x,
        itemListElement: top.map((l, i) => ({ '@type': 'ListItem', position: i + 1, url: SITE_URL + l.url, name: l.name })),
      },
      faqJsonLd(faq),
    ]),
  });
}

/* --- listing pages -------------------------------------------------------- */

function ratingBars(l) {
  const r = l.reviewsPerScore;
  if (!r) return '';
  const total = [1, 2, 3, 4, 5].reduce((s, k) => s + (r[k] || 0), 0);
  if (!total) return '';
  return `<div class="rating-bars" aria-label="Breakdown of Google reviews by star rating">
${[5, 4, 3, 2, 1].map((k) => `  <div class="rating-bar"><span>${k} star</span><span class="bar"><span style="width:${((r[k] || 0) / total * 100).toFixed(1)}%"></span></span><span>${num(r[k] || 0)}</span></div>`).join('\n')}
</div>`;
}

function listingFaq(l) {
  const f = hoursFacts(l);
  const items = [];
  items.push({
    q: `What are ${l.name}'s hours?`,
    a: l.hours
      ? `${groupedHours(l).map((g) => `${g.label}: ${stripTags(g.text)}`).join('; ')}. Hours come from the business's public listing and can change on holidays.`
      : `Hours are not listed for ${l.name}. Call ahead or check the business's own website before visiting.`,
  });
  items.push({
    q: `Where is ${l.name}?`,
    a: hasStreetAddress(l) ? `${l.name} is at ${addressOf(l)}.` : `${l.name} is in ${l.city}, ${l.state}. A street address is not listed in our data, so use the map link for directions.`,
  });
  items.push({
    q: `What is the phone number for ${l.name}?`,
    a: l.phone ? `The listed phone number is ${l.phone}.` : `No phone number is listed for ${l.name} in our data.`,
  });
  items.push({
    q: `Is ${l.name} open on Sundays?`,
    a: f && f.openSunday != null
      ? (f.openSunday ? `Yes. Its listed Sunday hours are ${stripTags(prettyHours(l.hours.sunday))}.` : 'No. Its listing shows it closed on Sundays.')
      : `Sunday hours are not listed for ${l.name}. Call ahead to check.`,
  });
  return items;
}

for (const l of listings) {
  const ST = l.stateCode;
  const titleCandidates = [
    `${l.name} - ${l.city}, ${ST} | Hours and Info`,
    `${l.name} in ${l.city}, ${ST}: Hours and Phone`,
    `${l.name} - ${l.city}, ${ST}`,
    `${l.name} | ${ST}`,
    l.name,
  ];
  const ratingBit = l.rating ? ` Rated ${l.rating.toFixed(1)}${l.reviews ? ` from ${num(l.reviews)} Google reviews` : ''}.` : '';
  const meta = {
    path: l.url,
    title: fitTitle(titleCandidates),
    description: fitDescription(
      `${l.name} in ${l.city}, ${l.state}.${ratingBit}`,
      [' See hours, phone number, address, website and directions', ' before you visit.', ' Plus nearby chocolate shops.', ' Updated regularly.'],
      [' Check hours before you go.', ' Free directory.', ' Independent listings.']
    ),
    h1: l.name,
    layout: 'raw',
    noindex: l.sample,
    trail: [
      { label: 'States', href: '/states/' },
      { label: l.state, href: statePath(l.state) },
      { label: l.city, href: cityPath(l.state, l.city) },
      { label: l.name },
    ],
  };

  const cats = (l.features || []).map(catFor).filter(Boolean);
  const near = nearbyListings(l, 6);
  const cityItems = byCity.get(`${l.state}|${l.city}`);
  const cityRank = cityItems.indexOf(l) + 1;
  const stateRank = byState.get(l.state).indexOf(l) + 1;
  const faq = listingFaq(l);
  const extras = [];
  if (l.priceRange) extras.push(`<div><dt>Price range</dt><dd>${esc(l.priceRange)}</dd></div>`);
  if (l.serviceOptions) extras.push(`<div><dt>Service options</dt><dd>${esc(l.serviceOptions.join(', '))}</dd></div>`);
  if (l.payments) extras.push(`<div><dt>Payments</dt><dd>${esc(l.payments.join(', '))}</dd></div>`);
  if (l.businessStatus && l.businessStatus !== 'OPERATIONAL') extras.push(`<div><dt>Status</dt><dd>${esc(cap(l.businessStatus.toLowerCase().replace(/_/g, ' ')))}</dd></div>`);

  const body = `<div class="page-head">
  <div class="wrap">
    ${breadcrumbs(meta.trail)}
    ${l.sample ? '<p class="notice">This is a placeholder listing used to test the site before real data is imported. It is not a real business.</p>' : ''}
    <h1>${esc(l.name)}</h1>
    <p class="entry-meta">${ratingHtml(l, { long: true })}<span class="entry-place">${esc(l.city)}, ${esc(l.state)}</span></p>
    <p class="lede">Ranked #${stateRank} of ${num(byState.get(l.state).length)} in <a href="${statePath(l.state)}">${esc(l.state)}</a> and #${cityRank} of ${num(cityItems.length)} in <a href="${cityPath(l.state, l.city)}">${esc(l.city)}</a> on our list.</p>
  </div>
</div>
<div class="section">
  <div class="wrap detail-grid">
    <article class="detail-main prose">
      <figure class="detail-hero">${listingImage(l, 'hero', { eager: true })}</figure>
      <h2>About ${esc(l.name)}</h2>
      <p>${summaryHtml(l, stateRank)}</p>
      ${l.category ? `<p>Google lists it as: ${esc(l.category)}${l.subtypes && l.subtypes !== l.category ? ` (${esc(l.subtypes)})` : ''}.</p>` : ''}
      ${cats.length ? `<p>Browse similar shops: ${cats.map((c) => `<a href="${findStatePath(c, l.state)}">${esc(c.name.toLowerCase())} in ${esc(l.state)}</a>`).join(', ')}.</p>` : ''}
      ${renderAdSlot('display')}
      <h2>Hours</h2>
      ${hoursTable(l)}
      ${l.hours ? '<p class="small">Hours come from the business\'s public Google listing at our last data refresh. Holidays, especially around Valentine\'s Day, Easter and December, often change them.</p>' : ''}
      <h2>Ratings</h2>
      ${l.rating ? `<p>${esc(l.name)} has a ${l.rating.toFixed(1)} out of 5 average${l.reviews ? ` from ${plural(l.reviews, 'Google review', 'Google reviews')}` : ''}.${reviewSpreadSentence(l)}</p>${ratingBars(l)}` : '<p class="missing">No Google rating or reviews are on file for this business yet.</p>'}
      <h2>Questions about ${esc(l.name)}</h2>
      ${faqHtml(faq)}
    </article>
    <aside class="detail-side">
      <div class="side-card">
        <h2>Contact and location</h2>
        ${factsList(l)}
        ${extras.length ? `<dl class="facts">${extras.join('')}</dl>` : ''}
        <div class="entry-actions">
          <a class="btn btn-primary btn-sm" href="${directionsUrl(l)}" ${EXT}>Get directions</a>
          ${l.phone ? `<a class="btn btn-outline btn-sm" href="${telHref(l.phone)}">Call</a>` : ''}
          ${l.website ? `<a class="btn btn-outline btn-sm" href="${attr(l.website)}" ${EXT}>Website</a>` : ''}
        </div>
      </div>
      ${renderAdSlot('display')}
    </aside>
  </div>
</div>
<div class="section section-alt">
  <div class="wrap">
    <h2>More chocolate near ${esc(l.name)}</h2>
    <ol class="mini-list">
${near.map(({ l: o, miles }) => `      <li><a href="${o.url}">${esc(o.name)}</a> <span>${esc(o.city)} &middot; ${miles < 0.1 ? 'under 0.1' : miles.toFixed(1)} mi${o.rating ? ` &middot; ${o.rating.toFixed(1)} rating` : ''}</span></li>`).join('\n')}
    </ol>
    <p><a href="${cityPath(l.state, l.city)}">All ${plural(cityItems.length, 'chocolate shop', 'chocolate shops')} in ${esc(l.city)}</a> &middot; <a href="${statePath(l.state)}">All of ${esc(l.state)}</a> &middot; <a href="${mapPath(l.state)}">${esc(l.state)} map</a></p>
  </div>
</div>`;

  const address = {
    '@type': 'PostalAddress',
    streetAddress: l.street || undefined,
    addressLocality: l.city,
    addressRegion: l.stateCode,
    postalCode: l.postalCode || undefined,
    addressCountry: 'US',
  };
  // No aggregateRating: the ratings are Google's, and Google's review
  // snippet rules exclude ratings a page did not collect itself.
  const business = {
    '@type': 'Store',
    '@id': `${SITE_URL}${l.url}#business`,
    name: l.name,
    url: l.website || undefined,
    telephone: l.phone || undefined,
    address,
    geo: { '@type': 'GeoCoordinates', latitude: l.lat, longitude: l.lng },
    openingHoursSpecification: openingHoursSpec(l),
    image: usablePhoto(l) || undefined,
    hasMap: l.mapsUrl || undefined,
  };
  emit(meta, body, { priority: 0.6, jsonld: pageJsonLd(meta, [business]) });
}

/* --- state hubs (the money pages) ----------------------------------------- */

function stateFacts(stateName, items) {
  const facts = [];
  const cities = citiesIn(stateName);
  const withHours = items.filter((l) => hoursFacts(l)?.openSunday != null);
  const sunday = withHours.filter((l) => hoursFacts(l).openSunday);
  const rated = items.filter((l) => l.rating && !l.sample);
  const top = rated[0] ? items.find((l) => l.rating && !l.sample) : null;
  const late = items
    .map((l) => ({ l, f: hoursFacts(l) }))
    .filter((x) => x.f && x.f.latest && x.f.latest.time >= 20 * 60)
    .sort((a, b) => b.f.latest.time - a.f.latest.time);
  const cityAverages = cities
    .map(({ city, items: ci }) => {
      const r = ci.filter((l) => l.rating && l.reviews);
      return { city, n: r.length, avg: r.length ? r.reduce((s, l) => s + l.rating, 0) / r.length : 0 };
    })
    .filter((c) => c.n >= 3)
    .sort((a, b) => b.avg - a.avg);
  return { cities, withHours, sunday, rated, top, late, cityAverages };
}

function stateFaq(stateName, items, f) {
  const out = [];
  if (f.top) {
    out.push({
      q: `What is the top-rated chocolate shop in ${stateName}?`,
      a: `${f.top.name} in ${f.top.city} tops our ${stateName} ranking with a ${f.top.rating.toFixed(1)} average${f.top.reviews ? ` from ${num(f.top.reviews)} Google reviews` : ''}. Our ranking weights rating by review volume, so a perfect score from a handful of reviews does not jump an established favourite.`,
    });
  }
  if (f.cities.length > 1) {
    const c = f.cities[0];
    out.push({
      q: `Which city in ${stateName} has the most chocolate shops?`,
      a: `${c.city} has the most in our directory, with ${plural(c.items.length, 'listing', 'listings')}${f.cities[1] ? `, followed by ${f.cities[1].city} (${num(f.cities[1].items.length)})` : ''}.`,
    });
  }
  if (f.withHours.length) {
    out.push({
      q: `Are chocolate shops in ${stateName} open on Sundays?`,
      a: `${num(f.sunday.length)} of the ${num(f.withHours.length)} ${stateName} shops with Sunday hours listed are open on Sundays. Check each shop's hours above before you go.`,
    });
  }
  if (f.late.length) {
    out.push({
      q: `Which chocolate shops in ${stateName} are open late?`,
      a: `${joinNatural(f.late.slice(0, 3).map((x) => `${x.l.name} (${x.l.city}, until ${formatMinutes(x.f.latest.time)} on ${cap(x.f.latest.day)}s)`))} have the latest listed closing times.`,
    });
  }
  out.push({
    q: `How do I find chocolate near me in ${stateName}?`,
    a: `Use "Nearest to me" in the sort menu on this page to reorder every ${stateName} shop by distance from you, or open your city from the list of cities. Each listing links to directions.`,
  });
  return out;
}

for (const stateName of stateNames) {
  const items = byState.get(stateName);
  const path = statePath(stateName);
  const f = stateFacts(stateName, items);
  const n = items.length;
  const shops = n === 1 ? 'Chocolate Shop' : 'Chocolate Shops';
  const real = realCount(items);

  const meta = {
    path,
    title: fitTitle([
      `Chocolate Near Me: ${n} Top-Rated ${shops} in ${stateName}`,
      `Chocolate Near Me: ${n} Best ${shops} in ${stateName}`,
      `Chocolate Near Me: ${n} ${shops} in ${stateName}`,
      `Chocolate Near Me in ${stateName}: ${n} Top Shops`,
      `Chocolate Near Me: ${stateName}`,
    ]),
    description: fitDescription(
      `Find chocolate near you: ${plural(n, 'chocolate shop', 'chocolate shops and chocolatiers')} in ${stateName}, ranked by Google rating`,
      [', with hours, phone numbers and addresses', ` across ${plural(f.cities.length, 'city', 'cities')}`, '. See who is open today.', ` Updated ${MONTH_YEAR}.`],
      [' Free and independent.', ' Directions included.']
    ),
    h1: `Chocolate Near Me in ${stateName}: ${n} Top-Rated ${shops}`,
    layout: 'raw',
    nav: 'states',
    noindex: real === 0,
    schemaType: 'CollectionPage',
    trail: [{ label: 'States', href: '/states/' }, { label: stateName }],
  };

  const presentCats = categories.map((c) => ({ c, n: withFeature(items, c).length })).filter((x) => x.n);
  const avgRating = f.rated.length ? f.rated.reduce((s, l) => s + l.rating, 0) / f.rated.length : null;

  const lede = `Every chocolate shop, chocolatier and confectioner we track in ${esc(stateName)}, ranked by Google rating weighted by review count. ${f.cities.length > 1 ? `They span ${plural(f.cities.length, 'city', 'cities')}, led by ${esc(f.cities[0].city)} with ${num(f.cities[0].items.length)}.` : `All are in ${esc(f.cities[0].city)}.`} Each entry has hours, phone, address and website, or says plainly when one is not listed.`;

  const statStrip = `<ul class="stat-strip">
  <li><b>${num(n)}</b><span>${n === 1 ? 'shop' : 'shops'} listed</span></li>
  <li><b>${num(f.cities.length)}</b><span>${f.cities.length === 1 ? 'city' : 'cities'}</span></li>
  <li><b>${avgRating ? avgRating.toFixed(1) : 'n/a'}</b><span>average rating</span></li>
  <li><b>${f.withHours.length ? `${num(f.sunday.length)}` : 'n/a'}</b><span>open Sundays</span></li>
</ul>`;

  const rich = items.slice(0, STATE_RICH_ENTRIES).map((l, i) => renderEntry(l, i + 1));
  const compact = items.slice(STATE_RICH_ENTRIES).map((l, i) => renderCompactEntry(l, STATE_RICH_ENTRIES + i + 1));
  const faq = stateFaq(stateName, items, f);
  const near = nearbyStates(stateName, 6);

  const glance = [];
  if (f.top) glance.push(`<li>Top of the ranking: <a href="${f.top.url}">${esc(f.top.name)}</a> in ${esc(f.top.city)}, ${f.top.rating.toFixed(1)} from ${plural(f.top.reviews || 0, 'review', 'reviews')}.</li>`);
  if (f.cityAverages.length) glance.push(`<li>Highest average rating among cities with three or more rated shops: <a href="${cityPath(stateName, f.cityAverages[0].city)}">${esc(f.cityAverages[0].city)}</a> (${f.cityAverages[0].avg.toFixed(2)} across ${num(f.cityAverages[0].n)} shops).</li>`);
  if (f.withHours.length) glance.push(`<li>${num(f.sunday.length)} of ${num(f.withHours.length)} shops with Sunday hours listed open on Sundays.</li>`);
  if (f.late.length) glance.push(`<li>Latest listed closing time: <a href="${f.late[0].l.url}">${esc(f.late[0].l.name)}</a>, ${formatMinutes(f.late[0].f.latest.time)} on ${cap(f.late[0].f.latest.day)}s.</li>`);
  const noHours = items.filter((l) => !l.hours).length;
  if (noHours) glance.push(`<li>${num(noHours)} of ${num(n)} listings have no hours on file. Those entries say so, so call ahead.</li>`);

  const body = `<div class="page-head">
  <div class="wrap">
    ${breadcrumbs(meta.trail)}
    ${real === 0 ? '<p class="notice">Placeholder data: every listing on this page is a stand-in until the real Outscraper export is imported. This page is hidden from search engines until then.</p>' : ''}
    <h1>${esc(meta.h1)}</h1>
    <p class="lede">${lede}</p>
    ${statStrip}
  </div>
</div>
<div class="section">
  <div class="wrap">
    <nav class="jump" aria-label="Browse ${attr(stateName)}">
      <div><h2 class="jump-title">Top cities</h2><ul class="chips">${f.cities.slice(0, 12).map((c) => `<li><a class="chip" href="${cityPath(stateName, c.city)}">${esc(c.city)} <span>${num(c.items.length)}</span></a></li>`).join('')}</ul></div>
      ${presentCats.length ? `<div><h2 class="jump-title">By speciality</h2><ul class="chips">${presentCats.map(({ c, n: cn }) => `<li><a class="chip" href="${findStatePath(c, stateName)}">${esc(c.short)} <span>${num(cn)}</span></a></li>`).join('')}</ul></div>` : ''}
    </nav>
    <h2 id="ranked">The ${plural(n, 'top-rated chocolate shop', 'top-rated chocolate shops')} in ${esc(stateName)}</h2>
    <p class="small">Ranked by Google rating weighted by review volume. Today's hours are highlighted on each listing page. <a href="${mapPath(stateName)}">See them on a map</a>.</p>
    ${hubToolbar(items)}
    <ol class="entries" data-hub-list>
${listWithAds([...rich, ...compact])}
    </ol>
    <p class="empty" data-filter-empty hidden>No shops match that search. Clear the search box to see the full list.</p>
  </div>
</div>
${renderAdSlot('display').replace('class="ad-slot', 'class="wrap ad-slot')}
<div class="section section-alt">
  <div class="wrap">
    <h2>Chocolate shops by city in ${esc(stateName)}</h2>
    <ul class="city-grid">
${f.cities.map((c) => `      <li><a href="${cityPath(stateName, c.city)}">${esc(c.city)}</a> <span>${num(c.items.length)}</span></li>`).join('\n')}
    </ul>
  </div>
</div>
<div class="section">
  <div class="wrap-narrow prose">
    <h2>${esc(stateName)} chocolate at a glance</h2>
    <ul>
${glance.join('\n')}
    </ul>
    <h2>Questions about chocolate shops in ${esc(stateName)}</h2>
    ${faqHtml(faq)}
    ${(stateListicles.get(stateName) || []).length ? `<h2>${esc(stateName)} best-of lists</h2>
    <ul class="link-list">
${stateListicles.get(stateName).map((p) => `      <li><a href="${p.path}">${esc(p.title)}</a></li>`).join('\n')}
    </ul>` : ''}
    <h2>How this list works</h2>
    <p>Listings come from public Google business data, refreshed on a regular schedule. We rank by a weighted rating: a shop's Google average, pulled toward the overall average until it has enough reviews to stand on its own. No business pays for placement.</p>
    <p>Speciality tags such as truffles or fudge come from each shop's own Google category and description. Spotted something wrong? <a href="/contact/">Tell us</a> and we will fix it.</p>
    ${near.length ? `<h2>Nearby states</h2>
    <ul class="chips">${near.map((s) => `<li><a class="chip" href="${statePath(s.state)}">${esc(s.state)}</a></li>`).join('')}</ul>` : ''}
  </div>
</div>`;

  const jsonld = pageJsonLd(meta, [
    {
      '@type': 'ItemList',
      name: meta.h1,
      numberOfItems: n,
      itemListOrder: 'https://schema.org/ItemListOrderDescending',
      itemListElement: items.slice(0, 50).map((l, i) => ({ '@type': 'ListItem', position: i + 1, url: SITE_URL + l.url, name: l.name })),
    },
    faqJsonLd(faq),
  ]);
  emit(meta, body, { priority: 0.9, jsonld, scripts: hubScripts });

  // /<state>/ is the natural parent of /<state>/<city>/; send anyone who
  // trims a city URL to the state hub instead of a 404. vercel.json and
  // dist/_redirects make this a real 301; this page covers any other host.
  const stub = `/${slugify(stateName)}/`;
  writePage(stub, `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(stateName)} chocolate shops</title><meta name="robots" content="noindex, follow"><link rel="canonical" href="${SITE_URL}${path}"><meta http-equiv="refresh" content="0; url=${path}"></head><body><p><a href="${path}">Chocolate shops in ${esc(stateName)}</a></p></body></html>`);
}

/* --- city hubs ------------------------------------------------------------ */

for (const [key, items] of byCity) {
  const [stateName, cityName] = key.split('|');
  const ST = items[0].stateCode;
  const path = cityPath(stateName, cityName);
  const n = items.length;
  const shops = n === 1 ? 'Chocolate Shop' : 'Chocolate Shops';
  const real = realCount(items);
  const meta = {
    path,
    title: fitTitle([
      `Chocolate Near Me in ${cityName}, ${ST}: ${n} Top ${shops}`,
      `Chocolate Near Me: ${n} ${shops} in ${cityName}, ${ST}`,
      `Chocolate Shops in ${cityName}, ${ST} (${n})`,
      `Chocolate in ${cityName}, ${ST}`,
    ]),
    description: fitDescription(
      `Chocolate near you in ${cityName}, ${stateName}: ${plural(n, 'chocolate shop', 'chocolate shops and chocolatiers')} ranked by Google rating`,
      [', with hours, phone numbers, addresses and websites', '. See who is open today.', ` Updated ${MONTH_YEAR}.`],
      [' Directions included.', ' Free and independent.']
    ),
    h1: `Chocolate Near Me in ${cityName}, ${ST}: ${n} Top ${shops}`,
    layout: 'raw',
    nav: 'states',
    noindex: real < CITY_INDEX_MIN,
    schemaType: 'CollectionPage',
    trail: [{ label: 'States', href: '/states/' }, { label: stateName, href: statePath(stateName) }, { label: cityName }],
  };
  const near = nearbyCities(stateName, cityName, 8);
  const entries = items.map((l, i) => (i < CITY_RICH_ENTRIES ? renderEntry(l, i + 1, { showCity: false }) : renderCompactEntry(l, i + 1, { showCity: false })));
  const presentCats = categories.map((c) => ({ c, n: withFeature(items, c).length })).filter((x) => x.n);
  const top = items.find((l) => l.rating && !l.sample);

  const body = `<div class="page-head">
  <div class="wrap">
    ${breadcrumbs(meta.trail)}
    ${real === 0 ? '<p class="notice">Placeholder data: these listings are stand-ins until the real Outscraper export is imported.</p>' : ''}
    <h1>${esc(meta.h1)}</h1>
    <p class="lede">${n === 1 ? `The one chocolate shop we track in ${esc(cityName)} so far` : `All ${num(n)} chocolate shops we track in ${esc(cityName)}`}, ranked by Google rating weighted by review count.${top ? ` ${esc(top.name)} currently leads with a ${top.rating.toFixed(1)}.` : ''} Hours, phone numbers, addresses and websites are below, and missing details are marked as missing.</p>
    ${presentCats.length ? `<ul class="chips">${presentCats.map(({ c, n: cn }) => `<li><a class="chip" href="${findStatePath(c, stateName)}">${esc(c.short)} <span>${num(cn)}</span></a></li>`).join('')}</ul>` : ''}
  </div>
</div>
<div class="section">
  <div class="wrap">
    ${n > 3 ? hubToolbar(items, { cityFilter: false }) : ''}
    <ol class="entries" data-hub-list>
${listWithAds(entries)}
    </ol>
    <p class="empty" data-filter-empty hidden>No shops match that search.</p>
  </div>
</div>
<div class="section section-alt">
  <div class="wrap">
    ${near.length ? `<h2>Chocolate shops near ${esc(cityName)}</h2>
    <ul class="city-grid">
${near.map((c) => `      <li><a href="${cityPath(stateName, c.city)}">${esc(c.city)}</a> <span>${num(c.n)} &middot; ${Math.round(c.miles)} mi</span></li>`).join('\n')}
    </ul>` : ''}
    <p><a href="${statePath(stateName)}">See all ${plural(byState.get(stateName).length, 'chocolate shop', 'chocolate shops')} in ${esc(stateName)}</a> &middot; <a href="${mapPath(stateName)}">${esc(stateName)} map</a></p>
  </div>
</div>`;
  const jsonld = pageJsonLd(meta, [{
    '@type': 'ItemList',
    name: meta.h1,
    numberOfItems: n,
    itemListElement: items.slice(0, 50).map((l, i) => ({ '@type': 'ListItem', position: i + 1, url: SITE_URL + l.url, name: l.name })),
  }]);
  emit(meta, body, { priority: 0.7, jsonld, scripts: n > 3 ? hubScripts : '' });
}

/* --- /find/ speciality pages ---------------------------------------------- */

const presentCategories = categories.filter((c) => withFeature(listings, c).length);

for (const cat of presentCategories) {
  const all = rankListings(withFeature(listings, cat));
  const statesWith = stateNames.map((s) => ({ s, items: rankListings(withFeature(byState.get(s), cat)) })).filter((x) => x.items.length);

  // National page: speciality intro, the top shops nationally, state links.
  const meta = {
    path: findPath(cat),
    title: fitTitle([`${cat.name} Near Me: Find One by State`, `${cat.name} Near Me`, cat.name]),
    description: fitDescription(
      `Find ${cat.name.toLowerCase()} near you. ${plural(all.length, 'shop', 'shops')} across ${plural(statesWith.length, 'state', 'states')}, ranked by Google rating`,
      [', with hours, phone numbers and addresses', '. Pick your state to narrow it down.', ` Updated ${MONTH_YEAR}.`],
      [' Free and independent.', ' Directions included.']
    ),
    h1: `${cat.name} Near Me`,
    lede: esc(cat.intro),
    layout: 'wide',
    noindex: realCount(all) === 0,
    schemaType: 'CollectionPage',
    trail: [{ label: 'Find', href: '/find/' }, { label: cat.name }],
  };
  const top = all.slice(0, 25);
  const body = `<h2>Pick a state</h2>
<ul class="city-grid">
${statesWith.map(({ s, items }) => `  <li><a href="${findStatePath(cat, s)}">${esc(s)}</a> <span>${num(items.length)}</span></li>`).join('\n')}
</ul>
${renderAdSlot('display')}
<h2>Top-rated nationwide</h2>
<ol class="entries">
${listWithAds(top.map((l, i) => renderCompactEntry(l, i + 1)))}
</ol>
<p><a href="/find/">All specialities</a> &middot; <a href="/states/">Browse by state</a></p>`;
  emit(meta, body, { priority: 0.6 });

  for (const { s, items } of statesWith) {
    const n = items.length;
    const m = {
      path: findStatePath(cat, s),
      title: fitTitle([`${cat.name} Near Me in ${s} (${n})`, `${cat.name} in ${s} (${n})`, `${cat.short} in ${s}`]),
      description: fitDescription(
        `${cat.name} near you in ${s}: ${plural(n, 'shop', 'shops')} ranked by Google rating`,
        [', with hours, phone numbers, addresses and websites', '. Every listing says when a detail is missing.', ` Updated ${MONTH_YEAR}.`],
        [' Free and independent.', ' Directions included.']
      ),
      h1: `${cat.name} Near Me in ${s}`,
      lede: `${n === 1 ? 'The one shop' : `All ${num(n)} shops`} in our ${esc(s)} directory whose Google category or description points to ${esc(cat.short.toLowerCase())}, ranked by weighted rating. ${esc(cat.intro.split('. ')[0])}.`,
      layout: 'wide',
      noindex: realCount(items) < FIND_STATE_INDEX_MIN,
      schemaType: 'CollectionPage',
      trail: [{ label: 'Find', href: '/find/' }, { label: cat.name, href: findPath(cat) }, { label: s }],
    };
    const b = `${n > 3 ? hubToolbar(items) : ''}
<ol class="entries" data-hub-list>
${listWithAds(items.map((l, i) => (i < STATE_RICH_ENTRIES ? renderEntry(l, i + 1) : renderCompactEntry(l, i + 1))))}
</ol>
<p class="empty" data-filter-empty hidden>No shops match that search.</p>
<p><a href="${statePath(s)}">All chocolate shops in ${esc(s)}</a> &middot; <a href="${findPath(cat)}">${esc(cat.name)} in other states</a></p>`;
    emit(m, b, { priority: 0.5, scripts: n > 3 ? hubScripts : '' });
  }
}

/* --- /map/<state>/ ---------------------------------------------------------- */

const mapHead = `<link rel="stylesheet" href="/assets/vendor/leaflet/leaflet.css?v=${ASSET_VERSION}">`;
const mapScripts = `<script src="/assets/vendor/leaflet/leaflet.js?v=${ASSET_VERSION}" defer></script>
<script src="/assets/js/map.js?v=${ASSET_VERSION}" defer></script>`;

function mapData(items) {
  return JSON.stringify(items.map((l) => ({ n: l.name, u: l.url, a: l.lat, o: l.lng, c: l.city, r: l.rating || null }))).replace(/</g, '\\u003c');
}

for (const stateName of stateNames) {
  const items = byState.get(stateName);
  const n = items.length;
  const cities = citiesIn(stateName);
  const meta = {
    path: mapPath(stateName),
    title: fitTitle([`Map of Chocolate Shops in ${stateName} (${n})`, `${stateName} Chocolate Shop Map`, `Chocolate Map: ${stateName}`]),
    description: fitDescription(
      `Interactive map of ${plural(n, 'chocolate shop', 'chocolate shops and chocolatiers')} in ${stateName}. Zoom to your area, tap a pin for the shop, then open its hours and directions`,
      ['.', ' or the full ranked list.'],
      [' Free.', ' No sign-up.']
    ),
    h1: `Map of Chocolate Shops in ${stateName}`,
    lede: `Every shop in our ${esc(stateName)} directory on one map. For hours and rankings, see the <a href="${statePath(stateName)}">${esc(stateName)} chocolate shop list</a>.`,
    layout: 'wide',
    noindex: realCount(items) === 0,
    trail: [{ label: 'Map', href: '/map/' }, { label: stateName }],
  };
  const body = `<div class="map-frame" id="map" data-map-src="map-data" role="region" aria-label="Map of chocolate shops in ${attr(stateName)}"><p class="map-loading">Loading map...</p></div>
<script type="application/json" id="map-data">${mapData(items)}</script>
<p class="small">Map data &copy; OpenStreetMap contributors. Pin positions come from each business's public listing.</p>
<h2>Shops on this map, by city</h2>
<div class="map-index">
${cities.map((c) => `  <section><h3><a href="${cityPath(stateName, c.city)}">${esc(c.city)}</a></h3><ul>${c.items.map((l) => `<li><a href="${l.url}">${esc(l.name)}</a></li>`).join('')}</ul></section>`).join('\n')}
</div>`;
  emit(meta, body, { priority: 0.4, headExtra: mapHead, scripts: mapScripts });
}

/* --- static pages (index, states, map, find, search, blog, legal...) ------ */

function stateGrid(linkFor = statePath) {
  return `<ul class="state-grid">
${stateNames.map((s) => `  <li><a href="${linkFor(s)}">${esc(s)} <span>${num(byState.get(s).length)}</span></a></li>`).join('\n')}
</ul>`;
}

function categoryChips() {
  return `<ul class="chips chips-lg">${presentCategories.map((c) => `<li><a class="chip" href="${findPath(c)}">${esc(c.short)} <span>${num(withFeature(listings, c).length)}</span></a></li>`).join('')}</ul>`;
}

function findIndex() {
  return `<ul class="find-grid">
${presentCategories.map((c) => `  <li><h2><a href="${findPath(c)}">${esc(c.name)}</a></h2><p>${esc(c.intro.split('. ')[0])}.</p><p class="small">${plural(withFeature(listings, c).length, 'shop', 'shops')} listed</p></li>`).join('\n')}
</ul>`;
}

function topRatedCards(count = 6) {
  const pool = rankListings(listings.filter((l) => !l.sample && l.rating)).slice(0, count);
  const list = pool.length ? pool : rankListings(listings).slice(0, count);
  return `<ol class="card-grid">
${list.map((l) => `  <li class="card"><a class="card-media" href="${l.url}" tabindex="-1" aria-hidden="true">${listingImage(l, 'card')}</a><div class="card-body"><h3><a href="${l.url}">${esc(l.name)}</a></h3><p class="entry-meta">${ratingHtml(l)}</p><p class="small">${esc(l.city)}, ${esc(l.state)}</p></div></li>`).join('\n')}
</ol>`;
}

function htmlSitemap() {
  return `<h2>Main pages</h2>
<ul class="link-list cols">
  <li><a href="/">Home</a></li><li><a href="/states/">States</a></li><li><a href="/find/">Find by speciality</a></li><li><a href="/map/">Maps</a></li><li><a href="/search/">Search</a></li><li><a href="/blog/">Blog</a></li><li><a href="/about/">About</a></li><li><a href="/contact/">Contact</a></li><li><a href="/disclaimer/">Disclaimer</a></li><li><a href="/privacy/">Privacy</a></li><li><a href="/terms/">Terms</a></li>
</ul>
<h2>Blog</h2>
<ul class="link-list">
${posts.map((p) => `  <li><a href="${p.meta.path}">${esc(p.meta.h1 || p.meta.title)}</a></li>`).join('\n')}
</ul>
<h2>State best-of lists</h2>
<ul class="link-list cols">
${listiclePosts.map((p) => `  <li><a href="${p.path}">${esc(p.h1)}</a></li>`).join('\n')}
</ul>
<h2>Specialities</h2>
<ul class="link-list cols">
${presentCategories.map((c) => `  <li><a href="${findPath(c)}">${esc(c.name)}</a></li>`).join('\n')}
</ul>
<h2>States and cities</h2>
${stateNames.map((s) => `<h3><a href="${statePath(s)}">${esc(s)}</a></h3>
<ul class="link-list cols">${citiesIn(s).map((c) => `<li><a href="${cityPath(s, c.city)}">${esc(c.city)}</a></li>`).join('')}</ul>`).join('\n')}`;
}

const tokens = {
  '{{STATE_GRID}}': () => stateGrid(),
  '{{MAP_STATE_GRID}}': () => stateGrid(mapPath),
  '{{CATEGORY_CHIPS}}': categoryChips,
  '{{FIND_INDEX}}': findIndex,
  '{{TOP_RATED}}': () => topRatedCards(6),
  '{{BLOG_TEASERS}}': () => blogTeasers(posts),
  '{{STATE_LISTS}}': () => stateNames.filter((sn) => stateListicles.has(sn)).map((sn) => `<section class="state-lists"><h3><a href="${statePath(sn)}">${esc(sn)}</a></h3><ul>${stateListicles.get(sn).map((p) => `<li><a href="${p.path}">${esc(p.title)}</a></li>`).join('')}</ul></section>`).join('\n'),
  '{{BLOG_TEASERS_HOME}}': () => blogTeasers(posts.slice(0, 3)),
  '{{FAQ}}': () => faqHtml(faqs),
  '{{HTML_SITEMAP}}': htmlSitemap,
  '{{AD_DISPLAY}}': () => renderAdSlot('display'),
  // Drop the banner photo at src/assets/img/hero-chocolate.jpg; until it
  // exists the hero shows the logo mark rather than a broken image.
  '{{HERO_IMAGE}}': () => (existsSync(join(SRC, 'assets/img/hero-chocolate.jpg'))
    ? '<img src="/assets/img/hero-chocolate.jpg" alt="Broken pieces of dark chocolate with toasted nuts on a white table" width="1333" height="2000" fetchpriority="high" decoding="async">'
    : '<img class="hero-mark" src="/assets/img/logo-mark.svg" alt="" width="320" height="320">'),
  '{{STAT_LISTINGS}}': () => num(stats.listings),
  '{{STAT_STATES}}': () => num(stats.states),
  '{{STAT_CITIES}}': () => num(stats.cities),
  '{{CONTACT_EMAIL}}': () => CONTACT_EMAIL,
  '{{BUILD_DATE}}': () => BUILD_DATE,
  '{{SAMPLE_BANNER}}': () => (sampleCount === listings.length
    ? '<p class="notice">Preview: the directory is running on placeholder listings until the first Outscraper import. No real business is described anywhere on this site yet.</p>'
    : ''),
};

function expandTokens(html) {
  return html.replace(/\{\{[A-Z_]+\}\}/g, (t) => (tokens[t] ? tokens[t]() : t));
}

const staticPages = readPageFiles(join(SRC, 'pages'));
for (const page of staticPages) {
  const meta = { ...page.meta };
  for (const k of ['title', 'description', 'h1', 'lede']) if (meta[k]) meta[k] = expandTokens(meta[k]);
  const body = expandTokens(page.body);
  if (meta.path === '/404/') {
    // No canonical on the error page: it is served at whatever URL missed.
    writeFileSync(join(DIST, '404.html'), render({ ...meta, path: '/404/', noindex: true }, body).replace(/<link rel="canonical"[^>]*>\n/, ''));
    continue;
  }
  let jsonld;
  if (meta.path === '/') {
    jsonld = {
      '@context': 'https://schema.org',
      '@graph': [
        {
          '@type': 'WebSite',
          '@id': `${SITE_URL}/#website`,
          name: SITE_NAME,
          url: `${SITE_URL}/`,
          publisher: { '@id': ORG['@id'] },
          potentialAction: { '@type': 'SearchAction', target: `${SITE_URL}/search/?q={search_term_string}`, 'query-input': 'required name=search_term_string' },
        },
        ORG,
        faqJsonLd(faqs),
      ],
    };
  }
  emit(meta, body, {
    priority: meta.path === '/' ? 1.0 : meta.path === '/states/' ? 0.9 : 0.4,
    jsonld,
    scripts: (meta.scripts || []).map((s) => `<script src="/assets/js/${s}?v=${ASSET_VERSION}" defer></script>`).join('\n'),
  });
}

/* --- client data ----------------------------------------------------------- */

mkdirSync(join(DIST, 'data'), { recursive: true });
writeFileSync(
  join(DIST, 'data/near-me.json'),
  JSON.stringify(listings.map((l) => [l.name, l.url, Math.round(l.lat * 1e4) / 1e4, Math.round(l.lng * 1e4) / 1e4, l.city, l.stateCode, l.rating || 0, l.reviews || 0]))
);
writeFileSync(
  join(DIST, 'data/search-index.json'),
  JSON.stringify([
    ...stateNames.map((s) => ({ t: 'State', n: s, p: `${num(byState.get(s).length)} shops`, u: statePath(s) })),
    ...[...byCity].map(([k, items]) => ({ t: 'City', n: k.split('|')[1], p: `${k.split('|')[0]}, ${num(items.length)} shops`, u: cityPath(...k.split('|')) })),
    ...presentCategories.map((c) => ({ t: 'Speciality', n: c.name, p: 'All states', u: findPath(c) })),
    ...posts.map((p) => ({ t: 'Guide', n: p.meta.h1 || p.meta.title, p: 'Blog', u: p.meta.path })),
    ...listiclePosts.map((p) => ({ t: 'Guide', n: p.h1, p: `Blog, ${p.stateName}`, u: p.path })),
    ...rankListings(listings).map((l) => ({ t: 'Shop', n: l.name, p: `${l.city}, ${l.stateCode}`, u: l.url })),
  ])
);

/* --- assets, robots, sitemap, ads.txt, manifest, redirects --------------- */

cpSync(join(SRC, 'assets'), join(DIST, 'assets'), { recursive: true });
if (existsSync(join(SRC, 'assets/img/favicon.ico'))) cpSync(join(SRC, 'assets/img/favicon.ico'), join(DIST, 'favicon.ico'));

writeFileSync(
  join(DIST, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${sitemapEntries.map((e) => `  <url><loc>${SITE_URL}${e.path}</loc><lastmod>${e.lastmod}</lastmod><priority>${e.priority.toFixed(1)}</priority></url>`).join('\n')}
</urlset>
`
);

writeFileSync(join(DIST, 'robots.txt'), `User-agent: *\nAllow: /\nDisallow: /data/\n\nSitemap: ${SITE_URL}/sitemap.xml\n`);
writeFileSync(join(DIST, 'ads.txt'), 'google.com, pub-9332749804326149, DIRECT, f08c47fec0942fa0\n');
writeFileSync(join(DIST, '_redirects'), stateNames.map((s) => `/${slugify(s)}  ${statePath(s)}  301`).join('\n') + '\n');
writeFileSync(
  join(DIST, 'site.webmanifest'),
  JSON.stringify({
    name: SITE_NAME,
    short_name: 'Chocolate',
    description: 'Find chocolate shops and chocolatiers near you.',
    start_url: '/',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#4A2C1D',
    icons: [
      { src: '/assets/img/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/assets/img/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
  }, null, 2)
);
writeFileSync(join(DIST, 'data/page-report.json'), JSON.stringify(pageReport));

console.log(`Built ${pageReport.length} pages (${sitemapEntries.length} indexable, in sitemap.xml)`);
console.log(`  listings: ${listings.length} (${sampleCount} placeholder), states: ${stateNames.length}, cities: ${byCity.size}, posts: ${posts.length} guides + ${listiclePosts.length} state lists, specialities: ${presentCategories.length}`);
if (sampleCount) console.log(`  note: ${sampleCount} placeholder listings are noindex and excluded from sitemap.xml`);
if (expiredPhotoCount) console.log(`  warning: ${expiredPhotoCount} Google photo URLs are older than ${PHOTO_MAX_AGE_DAYS} days and were replaced with local fallbacks. Re-import to refresh them.`);
console.log(`Output: ${DIST}`);
