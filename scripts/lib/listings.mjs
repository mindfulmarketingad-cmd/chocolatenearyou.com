/** Shared helpers for listing data: slugs, states, normalisation. */

export const STATES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
  CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia',
  FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois',
  IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana',
  ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
  MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada',
  NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
  NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon',
  PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota',
  TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia',
  WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
};

export const STATE_CODE_BY_NAME = Object.fromEntries(
  Object.entries(STATES).map(([code, name]) => [name.toLowerCase(), code])
);

export const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

export function slugify(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90)
    .replace(/-+$/g, '');
}

/** Ensures slugs stay unique across the dataset. */
export function uniqueSlug(base, taken) {
  let slug = base || 'chocolate-shop';
  let n = 2;
  while (taken.has(slug)) slug = `${base}-${n++}`;
  taken.add(slug);
  return slug;
}

export function resolveStateCode(stateRaw, usStateRaw) {
  for (const candidate of [usStateRaw, stateRaw]) {
    const raw = String(candidate || '').trim();
    if (!raw) continue;
    const upper = raw.toUpperCase();
    if (STATES[upper]) return upper;
    const byName = STATE_CODE_BY_NAME[raw.toLowerCase()];
    if (byName) return byName;
  }
  return '';
}

/** Emoji pictographs (plus the joiners and variation selectors that build
 *  them) are stripped from business text. Trademark signs are kept. */
const EMOJI = /(?![\u00a9\u00ae\u2122])[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u200d\ufe0f\u20e3]/gu;
export const stripEmoji = (value) => String(value ?? '').replace(EMOJI, '').replace(/\s{2,}/g, ' ').trim();

const PLACEHOLDER_VALUES = new Set(['none', 'n/a', 'na', 'null', 'undefined', '-', '--', 'nan']);

/**
 * Outscraper fills empty cells with literal placeholder text ("None" is the
 * most common) rather than leaving them blank. Trims and maps those to null
 * so they are never published as if they were real data.
 */
export function cleanField(value) {
  const trimmed = stripEmoji(value);
  if (!trimmed || PLACEHOLDER_VALUES.has(trimmed.toLowerCase())) return null;
  return trimmed;
}

/**
 * Outscraper exports working hours either as JSON ({"Monday":"9AM-6PM"} or
 * {"Monday":["9AM-12PM","1-6PM"]}) or, in its older format, as
 * "Monday: 9AM-6PM | Tuesday: Closed". Normalises both to lowercase day keys.
 */
export function parseWorkingHours(value) {
  if (!value) return null;
  if (typeof value === 'object') return normaliseHourKeys(value);
  const text = String(value).trim();
  if (!text || PLACEHOLDER_VALUES.has(text.toLowerCase())) return null;
  try {
    const parsed = JSON.parse(text.replace(/'/g, '"'));
    if (parsed && typeof parsed === 'object') return normaliseHourKeys(parsed);
  } catch {
    /* fall through to the old pipe-separated format */
  }
  const out = {};
  for (const part of text.split('|')) {
    const m = part.match(/^\s*([A-Za-z]+)\s*[:,]\s*(.+?)\s*$/);
    if (m) out[m[1].toLowerCase()] = m[2];
  }
  return normaliseHourKeys(out);
}

function normaliseHourKeys(obj) {
  const out = {};
  for (const [key, val] of Object.entries(obj || {})) {
    const day = String(key).trim().toLowerCase();
    if (!DAYS.includes(day)) continue;
    const text = Array.isArray(val) ? val.map((v) => String(v).trim()).join(' / ') : String(val ?? '').trim();
    if (text) out[day] = text;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Visitor-facing feature tags, derived only from the business's own Google
 * name, category, subtypes and description. A tag is a pointer to look
 * closer, never a claim beyond what those fields already say.
 */
const FEATURE_RULES = [
  // Not matched on names: "Chocolate Factory" is a franchise brand, not a
  // description of how the chocolate is made.
  [/\bchocolate artisan\b|bean[- ]to[- ]bar|craft chocolate|single[- ]origin|chocolate maker|chocolatier/i, 'Artisan chocolate', 'detail'],
  [/truffle|bonbon|bon bon|praline|ganache/i, 'Truffles and bonbons'],
  [/fudge/i, 'Fudge'],
  [/hot chocolate|hot cocoa|drinking chocolate|\bcaf[eé]\b|\bcoffee\b|espresso|chocolate cafe/i, 'Hot chocolate and cafe'],
  [/candy|confection|sweet shop|taffy|brittle|lollipop/i, 'Candy and confections'],
  [/strawberr|chocolate[- ]covered|chocolate[- ]dipped|\bdipped\b/i, 'Chocolate-dipped treats'],
  [/\bgift\b|gift (shop|basket)|corporate gift/i, 'Gifts'],
  [/\btours?\b|tour operator|\bclass(es)?\b|workshop|tasting/i, 'Tours, tastings and classes'],
  [/vegan|dairy[- ]free|plant[- ]based|sugar[- ]free|gluten[- ]free/i, 'Vegan and dietary options'],
  [/ice cream|gelato|frozen yogurt/i, 'Ice cream and gelato'],
];

/** `name` is matched only by rules not flagged 'detail'. */
export function deriveFeatures(name, ...details) {
  const detailText = details.filter(Boolean).join(' ');
  const allText = `${name || ''} ${detailText}`;
  const found = [];
  for (const [pattern, label, scope] of FEATURE_RULES) {
    if (pattern.test(scope === 'detail' ? detailText : allText) && !found.includes(label)) found.push(label);
  }
  return found;
}

/** Rows that never mention chocolate or confectionery are almost always
 *  noise from a broad Outscraper query (a bakery chain, a grocery store). */
export const RELEVANCE_PATTERN = /chocolat|cocoa|cacao|candy|confection|fudge|truffle|bonbon|praline|sweet shop/i;

export function isRelevant(row) {
  return RELEVANCE_PATTERN.test([row.name, row.category, row.type, row.subtypes, row.description].filter(Boolean).join(' '));
}

/** Outscraper's `about` column holds nested JSON attributes; pull out the
 *  accepted payment methods and the service options it lists as true. */
function parseAbout(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch {
    try {
      return JSON.parse(String(value).replace(/'/g, '"').replace(/\bTrue\b/g, 'true').replace(/\bFalse\b/g, 'false'));
    } catch {
      return null;
    }
  }
}

function trueKeys(group) {
  if (!group || typeof group !== 'object') return null;
  const keys = Object.entries(group).filter(([, on]) => on === true).map(([k]) => k.trim());
  return keys.length ? keys : null;
}

export function parseReviewsPerScore(value, discrete) {
  let obj = value;
  if (typeof value === 'string' && value.trim()) {
    try { obj = JSON.parse(value); } catch { obj = null; }
  } else if (typeof value !== 'object' || value === null) {
    obj = null;
  }
  const out = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let found = false;
  const source = obj || discrete || {};
  for (const star of [1, 2, 3, 4, 5]) {
    const raw = source[star] ?? source[String(star)];
    if (raw === '' || raw == null) continue;
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) { out[star] = Math.round(n); found = true; }
  }
  return found ? out : null;
}

function normaliseUrl(value) {
  const v = cleanField(value);
  if (!v) return null;
  if (/^https?:\/\//i.test(v)) return v;
  if (/^[a-z0-9.-]+\.[a-z]{2,}(\/.*)?$/i.test(v)) return `https://${v}`;
  return null;
}

/** Final shape consumed by the site build. Every field is either copied from
 *  the export or null; nothing is filled in with a guess. */
export function normaliseListing(input, taken, { importedAt = null } = {}) {
  const stateCode = resolveStateCode(input.state, input.us_state || input.state_code || input.stateCode);
  const city = cleanField(input.city) || '';
  const name = stripEmoji(input.name);
  if (!name) return null;

  const lat = Number(input.lat ?? input.latitude);
  const lng = Number(input.lng ?? input.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) return null;

  const slug = uniqueSlug(slugify([name, city, stateCode].filter(Boolean).join(' ')), taken);
  const rating = Number(input.rating);
  const reviews = Number(input.reviews);
  const about = parseAbout(input.about);
  const photo = cleanField(input.photo);

  return {
    id: String(input.place_id || input.google_id || slug),
    slug,
    name,
    category: cleanField(input.category) || cleanField(input.type),
    subtypes: cleanField(input.subtypes),
    description: cleanField(input.description),
    street: cleanField(input.street),
    city: city || null,
    state: STATES[stateCode] || null,
    stateCode: stateCode || null,
    postalCode: cleanField(input.postal_code ?? input.postalCode),
    fullAddress: cleanField(input.full_address ?? input.fullAddress ?? input.address),
    lat,
    lng,
    phone: cleanField(input.phone),
    website: normaliseUrl(input.site || input.website),
    rating: Number.isFinite(rating) && rating > 0 ? Math.round(rating * 10) / 10 : null,
    reviews: Number.isFinite(reviews) && reviews > 0 ? Math.round(reviews) : null,
    reviewsPerScore: input.reviewsPerScore || parseReviewsPerScore(input.reviews_per_score, {
      1: input.reviews_per_score_1, 2: input.reviews_per_score_2, 3: input.reviews_per_score_3,
      4: input.reviews_per_score_4, 5: input.reviews_per_score_5,
    }),
    hours: parseWorkingHours(input.working_hours || input.hours || input.working_hours_old_format),
    priceRange: cleanField(input.range || input.price_range || input.priceRange),
    timeZone: cleanField(input.time_zone || input.timeZone),
    verified: input.verified === true || String(input.verified).toLowerCase() === 'true',
    photo,
    // Google photo URLs are signed and stop resolving after roughly four
    // weeks. The build stops using a photo once it is older than
    // PHOTO_MAX_AGE_DAYS and falls back to a local image instead.
    photoFetchedAt: photo ? (input.photoFetchedAt || importedAt) : null,
    mapsUrl: cleanField(input.location_link || input.mapsUrl),
    placeId: cleanField(input.place_id || input.placeId),
    payments: Array.isArray(input.payments) ? input.payments : trueKeys(about && (about.Payments || about.payments)),
    serviceOptions: Array.isArray(input.serviceOptions)
      ? input.serviceOptions
      : trueKeys(about && (about['Service options'] || about.service_options)),
    businessStatus: cleanField(input.business_status || input.businessStatus),
    features: Array.isArray(input.features) && input.features.length
      ? input.features
      : deriveFeatures(name, input.category, input.type, input.subtypes, input.description),
    sample: Boolean(input.sample),
  };
}
