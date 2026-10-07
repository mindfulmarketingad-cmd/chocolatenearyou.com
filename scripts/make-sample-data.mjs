/**
 * Writes a small PLACEHOLDER dataset to data/listings.json so the build runs
 * end to end before the first Outscraper import.
 *
 *   node scripts/make-sample-data.mjs
 *
 * Nothing here describes a real business. Every row is named "Placeholder
 * Chocolate Shop", carries "sample": true, and has no street address, phone,
 * website, hours, rating or reviews. Coordinates are the approximate centre
 * of a real city so the maps and city pages have somewhere to sit. The build
 * marks every sample row (and any hub made only of sample rows) noindex and
 * leaves it out of sitemap.xml.
 */
import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normaliseListing } from './lib/listings.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// [city, state code, approx city-centre lat, lng, how many placeholder rows]
const CITIES = [
  ['San Francisco', 'CA', 37.7749, -122.4194, 5],
  ['Los Angeles', 'CA', 34.0522, -118.2437, 2],
  ['Chicago', 'IL', 41.8781, -87.6298, 3],
  ['Portland', 'OR', 45.5152, -122.6784, 2],
  ['New York', 'NY', 40.7128, -74.006, 3],
  ['Austin', 'TX', 30.2672, -97.7431, 1],
];

// Category strings only: they drive the filter chips so every chip and
// /find/ page is exercised by the build. They are not claims about a shop.
const CATEGORY_MIX = [
  'Chocolate shop, truffles and gift boxes',
  'Chocolate artisan',
  'Candy store, fudge',
  'Chocolate cafe, hot chocolate',
  'Chocolate shop, chocolate-dipped strawberries',
];

const taken = new Set();
const rows = [];
let n = 0;
for (const [city, state, lat, lng, count] of CITIES) {
  for (let i = 0; i < count; i++) {
    n++;
    const jitter = (k) => ((n * 37 + k * 11) % 20 - 10) / 1000;
    rows.push(
      normaliseListing(
        {
          name: `Placeholder Chocolate Shop ${n}`,
          category: 'Chocolate shop',
          subtypes: CATEGORY_MIX[(n - 1) % CATEGORY_MIX.length],
          description: 'Placeholder listing used to test the site build. This is not a real business; it will be replaced by the Outscraper import.',
          city,
          us_state: state,
          latitude: lat + jitter(1),
          longitude: lng + jitter(2),
          sample: true,
        },
        taken
      )
    );
  }
}

writeFileSync(
  resolve(ROOT, 'data/listings.json'),
  `${JSON.stringify({ source: 'placeholder', importedAt: null, count: rows.length, sampleCount: rows.length, listings: rows }, null, 2)}\n`
);
console.log(`Wrote ${rows.length} placeholder listings to data/listings.json`);
