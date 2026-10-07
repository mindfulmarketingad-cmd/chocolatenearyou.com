/**
 * Imports an Outscraper "Google Maps / Places" export into data/listings.json.
 *
 *   node scripts/import-outscraper.mjs path/to/outscraper-export.csv
 *   node scripts/import-outscraper.mjs path/to/outscraper-export.json
 *   node scripts/import-outscraper.mjs path/to/outscraper-export.xlsx   (needs: npm install xlsx)
 *
 * Flags:
 *   --keep-samples   keep the placeholder rows alongside the import
 *   --no-filter      keep rows that never mention chocolate/candy/confectionery
 *   --exported-at=2026-10-07T17:43:33Z
 *                    when Outscraper produced the file. Google photo URLs are
 *                    signed at export time, so photo expiry counts from here.
 *                    Read from the default "Outscraper-YYYYMMDDHHMMSS" file
 *                    name when the flag is absent; falls back to now.
 *
 * The import REPLACES data/listings.json. Rows without a name or usable
 * coordinates are skipped, CLOSED_PERMANENTLY rows are dropped, and every
 * missing field is stored as null so the pages can say "not listed" instead
 * of guessing.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normaliseListing, isRelevant } from './lib/listings.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_FILE = resolve(ROOT, 'data/listings.json');

/** RFC 4180 CSV parser (quoted fields, embedded commas and newlines). */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const src = text.replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === ',') { row.push(field); field = ''; continue; }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const headers = rows[0].map(normaliseHeader);
  return rows
    .slice(1)
    .filter((r) => r.some((cell) => cell.trim() !== ''))
    .map((r) => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? '').trim()])));
}

const normaliseHeader = (h) => String(h).trim().toLowerCase().replace(/\s+/g, '_');

async function readRows(source) {
  const ext = extname(source).toLowerCase();
  if (ext === '.xlsx' || ext === '.xls') {
    let XLSX;
    try {
      XLSX = (await import('xlsx')).default;
    } catch {
      console.error('Reading .xlsx needs the optional "xlsx" package: npm install xlsx\nOr export the sheet as CSV from Outscraper and import that instead.');
      process.exit(1);
    }
    const workbook = XLSX.readFile(source);
    return XLSX.utils
      .sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { defval: '' })
      .map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [normaliseHeader(k), typeof v === 'string' ? v.trim() : v])));
  }
  if (ext === '.json') {
    const parsed = JSON.parse(readFileSync(source, 'utf8'));
    return Array.isArray(parsed) ? parsed.flat() : parsed.listings || parsed.data || [];
  }
  return parseCsv(readFileSync(source, 'utf8'));
}

async function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  const keepSamples = args.includes('--keep-samples');
  const noFilter = args.includes('--no-filter');

  if (!file) {
    console.error('Usage: node scripts/import-outscraper.mjs <export.csv|export.json|export.xlsx> [--keep-samples] [--no-filter]');
    process.exit(1);
  }
  const source = resolve(process.cwd(), file);
  if (!existsSync(source)) {
    console.error(`Import file not found: ${source}`);
    process.exit(1);
  }

  const importedAt = new Date().toISOString();
  const flag = args.find((a) => a.startsWith('--exported-at='));
  const stamp = source.match(/Outscraper-(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/);
  const exportedAt = flag
    ? new Date(flag.split('=')[1]).toISOString()
    : stamp
      ? new Date(`${stamp[1]}-${stamp[2]}-${stamp[3]}T${stamp[4]}:${stamp[5]}:${stamp[6]}Z`).toISOString()
      : importedAt;
  const rows = await readRows(source);
  const taken = new Set();
  const seenIds = new Set();
  const listings = [];
  const skipped = [];

  for (const row of rows) {
    if (String(row.business_status || '').toUpperCase() === 'CLOSED_PERMANENTLY') {
      skipped.push({ name: row.name, reason: 'permanently closed' });
      continue;
    }
    if (!noFilter && !isRelevant(row)) {
      skipped.push({ name: row.name, reason: 'no chocolate/confectionery signal (use --no-filter to keep)' });
      continue;
    }
    const id = row.place_id || row.google_id;
    if (id && seenIds.has(id)) {
      skipped.push({ name: row.name, reason: 'duplicate place_id' });
      continue;
    }
    const listing = normaliseListing(row, taken, { importedAt: exportedAt });
    if (!listing) {
      skipped.push({ name: row.name || '(unnamed)', reason: 'missing name or coordinates' });
      continue;
    }
    if (!listing.state || !listing.city) {
      skipped.push({ name: listing.name, reason: 'missing US state or city' });
      continue;
    }
    if (id) seenIds.add(id);
    listings.push(listing);
  }

  let kept = [];
  if (keepSamples && existsSync(DATA_FILE)) {
    kept = (JSON.parse(readFileSync(DATA_FILE, 'utf8')).listings || []).filter((l) => l.sample);
  }

  const all = [...listings, ...kept];
  all.sort((a, b) => (a.state || '').localeCompare(b.state || '') || a.name.localeCompare(b.name));

  writeFileSync(
    DATA_FILE,
    `${JSON.stringify({ source: 'outscraper', importedAt, exportedAt, count: all.length, sampleCount: all.filter((l) => l.sample).length, listings: all }, null, 2)}\n`
  );

  console.log(`Imported ${listings.length} listings from ${file} (exported ${exportedAt})`);
  if (kept.length) console.log(`Kept ${kept.length} placeholder listings (--keep-samples)`);
  if (skipped.length) {
    console.log(`Skipped ${skipped.length} rows:`);
    for (const s of skipped.slice(0, 20)) console.log(`  - ${s.name}: ${s.reason}`);
    if (skipped.length > 20) console.log(`  ...and ${skipped.length - 20} more`);
  }
  console.log('Photo URLs from Google expire after about four weeks; re-import (or rebuild within that window) to keep them live.');
  console.log('Now run: npm run build');
}

if (import.meta.url === `file://${process.argv[1]}`) main();
