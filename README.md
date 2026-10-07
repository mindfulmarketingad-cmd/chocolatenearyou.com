# chocolatenearyou.com

**Chocolate Near Me**: a directory of chocolate shops, chocolatiers and candy
stores across the United States. Fully static: one Node script reads a
listings JSON file plus HTML templates with JSON front-matter and writes every
page to `dist/` at build time. No framework, no database, no runtime
dependencies, nothing rendered per request.

Architecture copied from `pumpkinpatchesnearme.com`.

```bash
npm run build     # generate dist/ (about 5 seconds for ~5,200 pages)
npm run verify    # check links, meta lengths, canonicals, H1s, emoji, rel attributes
npm test          # build + verify
npm run dev       # build, then preview at http://localhost:4173
```

Deploy `dist/` to any static host. `vercel.json` and `netlify.toml` already
point at the build command and output directory.

---

## Where the listing data goes

`data/listings.json` is the dataset the build reads. It currently holds
**3,142 real listings** imported from the Outscraper export of 2026-10-07
(chocolate shops and candy shops, 51 states including DC).

To refresh it with a new export:

```bash
npm install --no-save xlsx                                   # only needed for .xlsx files
node scripts/import-outscraper.mjs ~/Downloads/Outscraper-20261107120000xxxx.xlsx
npm test                                                     # rebuild + verify
```

CSV and JSON exports work without `xlsx`. The import **replaces**
`data/listings.json`. It:

- drops `CLOSED_PERMANENTLY` rows and duplicate `place_id`s
- drops rows that never mention chocolate, cocoa, candy, confectionery, fudge or
  truffles (`--no-filter` keeps them)
- maps Outscraper's placeholder text (`None`, `N/A`, ...) to `null`, so pages say
  "not listed" instead of publishing filler
- strips emoji from business names and descriptions (trademark signs are kept)
- derives speciality tags (truffles, fudge, artisan, ...) only from Google's own
  category, subtypes and description. "Artisan" ignores business names, because
  "Chocolate Factory" is a franchise brand, not a production method.

`LISTINGS_FILE=path/to/other.json npm run build` builds from a different file
without replacing the committed one.

With no real data (a fresh clone, say), `npm run sample-data` writes 16
clearly marked placeholder listings: no addresses, phones, hours, ratings or
reviews. Placeholder listings, and any hub made only of them, are `noindex`
and left out of `sitemap.xml`.

### Google photo URLs expire

Outscraper's `photo` URLs are signed by Google and stop working after roughly
four weeks. The importer records the export time (read from the
`Outscraper-YYYYMMDDHHMMSS` file name, or `--exported-at=`). After
`PHOTO_MAX_AGE_DAYS` (25) the build stops emitting those URLs and uses local
illustrations in `src/assets/img/fallbacks/` instead. If Google revokes a URL
early, the `onerror` handler swaps in the same fallback, so a page never shows a
broken image. Re-import monthly to keep real photos.

### Missing fields

Every field is either from the export or `null`. Templates handle `null`
explicitly: "Street address not listed", "Hours are not listed for this
business. Call ahead before you go.", "No Google rating on file". Summaries are
assembled only from fields that exist.

---

## URL structure and internal linking

```
/                                  homepage: near-me button, state grid, specialities, top rated, FAQ
/states/                           state hub
/states/<state>/                   STATE PAGE (money page): full ranked listicle
/<state>/<city>/                   city listicle
/<state>/<city>/<shop>/            listing page
/find/  /find/<speciality>/  /find/<speciality>/<state>/     filter-chip targets
/map/   /map/<state>/              Leaflet maps (self-hosted Leaflet, OSM tiles)
/blog/  /blog/<guide>/             informational guides
/blog/best-<type>-in-<state>/      top-10 state listicles (chocolate, candy, gourmet)
/search/                           client-side search over /data/search-index.json
/about/ /contact/ /disclaimer/ /privacy/ /terms/ /sitemap/
/sitemap.xml /robots.txt /ads.txt /site.webmanifest /404.html
```

Links run Home > Hub > Individual, and every page links back up through
breadcrumbs (with `BreadcrumbList` JSON-LD). On top of that:

- **Every state page is one click from the homepage** (state grid), so link
  equity reaches the money pages directly.
- **Sideways links**: listing pages link the six nearest shops; city pages
  link the eight nearest cities; state pages link the six nearest states.
  Crawl depth stays at three clicks or fewer, and thin pages are never orphaned.
- **`/<state>/` redirects to `/states/<state>/`** (301 in `vercel.json` and
  `dist/_redirects`, plus a meta-refresh stub for other hosts), because a
  visitor who trims a city URL lands on the natural parent.
- **Blog listicles link up**: each top-10 post links to its state page at the
  top and bottom and to its sibling lists. The state page links back down to them.

### Indexing rules

- Placeholder listings: `noindex`.
- City pages with fewer than 2 real listings: built (so links resolve) but `noindex`.
- `/find/<speciality>/<state>/` with fewer than 3 real listings: `noindex`.
- `noindex` pages are excluded from `sitemap.xml`. `verify` enforces this.

### Titles and descriptions

Titles stay under 60 characters and descriptions land at 150-160.
`fitTitle()` and `fitDescription()` in `build.mjs` pick from several phrasings
rather than truncating, and `npm run verify` fails the build on any indexable
page outside those limits. State hubs are titled for the generic head term
("Chocolate Near Me: 284 Top-Rated Chocolate Shops in California"), because
Google matches them to the searcher's location rather than to state-qualified
queries.

### Ranking

A Bayesian weighted rating: each shop's Google average is pulled toward the
dataset mean with a prior of 25 reviews (`RANK_PRIOR_REVIEWS`). One function,
`rankListings()`, is used for every list.

---

## Project layout

```
data/listings.json            the dataset (generated by the importer)
scripts/
  build.mjs                   the static site generator
  verify.mjs                  post-build checks
  import-outscraper.mjs       Outscraper XLSX/CSV/JSON importer
  make-sample-data.mjs        placeholder dataset
  make-icons.mjs              favicon/app icons/OG image from logo-mark.svg (needs Playwright)
  serve.mjs                   local preview server
  lib/listings.mjs            normalisation, feature tags, slugs
src/
  templates/base.html         page shell with {{TOKEN}} placeholders
  pages/*.html                static pages, each with a JSON <!--meta --> block
  pages/blog/*.html           hand-written guides
  data/categories.json        specialities (tag -> /find/ page)
  data/faqs.json              homepage FAQ (HTML + FAQPage JSON-LD)
  assets/css/style.css        design system (white + cocoa brown)
  assets/js/                  site.js, hub-filter.js, near-me.js, search.js, map.js
  assets/img/                 logo, icons, OG image, fallback illustrations
  assets/vendor/leaflet/      Leaflet 1.9.4 (BSD-2)
```

### Adding a page

```html
<!--meta
{
  "path": "/your-page/",
  "title": "Under 60 characters",
  "description": "150 to 160 characters.",
  "h1": "Visible heading",
  "lede": "Optional intro.",
  "layout": "prose",
  "trail": [{ "label": "Your page" }]
}
-->
<p>Body HTML. Tokens such as {{STATE_GRID}} or {{AD_DISPLAY}} are expanded.</p>
```

Blog guides go in `src/pages/blog/` with `slug`, `date`, `excerpt` and
`readingTime` instead of `path`. Keep them informational. Local "near me"
intent belongs to the state pages.

### Homepage banner

Put the banner photo at `src/assets/img/hero-chocolate.jpg` (portrait,
1333x2000 or similar). The build picks it up automatically. Until then the
hero shows the logo mark.

---

## Ads

- `ads.txt`: `google.com, pub-9332749804326149, DIRECT, f08c47fec0942fa0`
- The AdSense loader is in `base.html`. Slots are placed between list entries
  (after #3, #10, then every 15, at most four per list), between hub
  sections, after a post's first paragraph, and in the listing sidebar.
- Every slot reserves its height in CSS (`.ad-slot` `min-height`), so late
  ads cause no layout shift.
- `AD_SLOTS` in `build.mjs` reuses existing ad units from the same publisher
  account. Swap in site-specific units for separate reporting.

## Before going live

- [ ] Add the homepage banner at `src/assets/img/hero-chocolate.jpg`
- [ ] Confirm the social profile URLs in `SOCIAL` (build.mjs) exist, or change them
- [ ] Point `CONTACT_EMAIL` at a mailbox you monitor
- [ ] Submit `https://chocolatenearyou.com/sitemap.xml` in Search Console
- [ ] Set up Google's consent message (CMP) in AdSense for EEA/UK visitors
- [ ] Re-import monthly so photos and hours stay fresh
- [ ] Have Privacy, Terms and Disclaimer reviewed. They are drafts, not legal advice.
