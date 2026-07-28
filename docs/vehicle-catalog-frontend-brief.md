# Public vehicle catalog — frontend brief

Five public read endpoints powering the guest booking flow's
year → make → model → series → overview cascade at
`workshop.rodz.com.au/book`. All **live now**, no auth required.

Full endpoint reference: [`vehicle-seo-payload-endpoint.md`](./vehicle-seo-payload-endpoint.md) sibling; guest-flow spec is at `booking-frontend-guest-flow.md`.

---

## One route, five actions

Backend note: because the shared HttpApi is at AWS's 300-route cap,
all five endpoints share a single route (`/{action}`) with an internal
dispatcher. This is transparent to you — the wire contract is
identical to five separate routes.

```
GET /public/vehicle-catalog/years
GET /public/vehicle-catalog/makes?year=YYYY
GET /public/vehicle-catalog/models?year=YYYY&make=slug
GET /public/vehicle-catalog/series?year=YYYY&make=slug&model=slug
GET /public/vehicle-catalog/overview?year=YYYY&make=slug&model=slug&km=NNN
```

All responses set `Cache-Control` — cache-friendly at Cloudflare's
edge, no need to layer your own SWR.

---

## `/years` — step 1

Returns the year picker range. Deep cache (24h) — the list changes
once a year.

```json
{ "years": [2027, 2026, 2025, /* … */ 1961, 1960] }
```

---

## `/makes?year=YYYY` — step 2

Makes with at least one model available in the given year. Sorted
**popular-first, then alphabetical** — render the `popular: true`
entries as quick-pick chips above the searchable list.

```json
{
  "year": 2017,
  "makes": [
    { "slug": "ford",    "name": "Ford",           "popular": true  },
    { "slug": "holden",  "name": "Holden",         "popular": true  },
    /* … */
    { "slug": "mahindra","name": "Mahindra",       "popular": false }
  ]
}
```

Popular flag hard-coded false for makes only present pre-1990.

---

## `/models?year=YYYY&make=slug` — step 3

Same popular-first sort as makes.

```json
{
  "year": 2017,
  "make": "suzuki",
  "models": [
    { "slug": "jimny",   "name": "Jimny",   "popular": true  },
    { "slug": "swift",   "name": "Swift",   "popular": true  },
    { "slug": "vitara",  "name": "Vitara",  "popular": true  },
    { "slug": "baleno",  "name": "Baleno",  "popular": false },
    { "slug": "ignis",   "name": "Ignis",   "popular": false },
    { "slug": "s-cross", "name": "S-Cross", "popular": false }
  ]
}
```

Returns `404 NOT_FOUND` if `make` slug doesn't exist. Empty models
array is valid (make exists but nothing sold that year).

---

## `/series?year=YYYY&make=slug&model=slug` — step 3.5 (optional)

Series (generations) for the model in the given year. **Empty array is
valid and expected for most modern models** — skip this picker step
when the array is empty.

Only populated for models with meaningful generation distinctions
(Falcon XA/XB/…, Skyline R32/R34, 3 Series E30/E46/…). Modern
Corollas / Yarises / Ceratos return `[]`.

```json
{
  "year": 1973,
  "make": "ford",
  "model": "falcon",
  "series": [
    { "slug": "xa", "name": "XA", "yearStart": 1972, "yearEnd": 1973, "popular": true },
    { "slug": "xb", "name": "XB", "yearStart": 1973, "yearEnd": 1976, "popular": true }
  ]
}
```

Returns `404 NOT_FOUND` if the make or model slug doesn't resolve.

---

## `/overview?year=YYYY&make=slug&model=slug[&km=NNN]` — the wow moment

Step 4 (no km yet) and step 6 (km known) both hit this endpoint.

**Without `km`:**

```json
{
  "year": 2017,
  "make": "suzuki",
  "model": "vitara",
  "displayName":              "2017 Suzuki Vitara",
  "intro":                    "Nice — a 2017 Suzuki Vitara.",
  "personalisedIntro":        null,
  "suggestedServiceTypeIds":  [],
  "genericMaintenancePreview": []
}
```

**With `km` (and when we have a per-model AI profile for that combo):**

```json
{
  "year": 2017,
  "make":  "suzuki",
  "model": "vitara",
  "km":    82000,
  "displayName":       "2017 Suzuki Vitara",
  "intro":             "Nice — a 2017 Suzuki Vitara.",
  "personalisedIntro": "With 82k on the clock, Vitaras at this mileage are typically due for spark plug replacement, automatic transmission fluid service.",
  "suggestedServiceTypeIds": [],
  "genericMaintenancePreview": [
    { "atKm": 100000, "task": "Spark Plug Replacement",              "priority": "watch" },
    { "atKm": 150000, "task": "Automatic Transmission Fluid Service","priority": "watch" }
  ]
}
```

### Behaviour to know

- **Unknown make/model → `200` with nulls, not `404`.** Render step 4
  with a generic "OK — a {year} {make} {model}, got it. Let's grab a
  few details." The frontend already has the raw user input; the
  backend just couldn't enrich it.
- **`intro` is always populated for known models** (`"Nice — a
  {year} {make} {model}."`, or `"Sweet — a classic {year} …"` for
  `year < 1990`).
- **`personalisedIntro` is `null`** when no `km` was sent, or when the
  model has no `vehicle_model_profiles` row yet, or when nothing on
  the maintenance list is `recommended` (i.e. all items are >10k km
  away — nothing urgent to mention).
- **`genericMaintenancePreview`** is derived from
  `vehicle_model_profiles.common_repairs`. Items sorted by ascending
  `atKm`; capped at 5. Each item has:
  - `atKm` — the next milestone at or after the requested `km`
  - `task` — human name from `common_repairs.name`
  - `priority: 'recommended'` when `atKm - km ≤ 10000`, else `'watch'`
- **`suggestedServiceTypeIds`** is always `[]` for now. Mapping to
  workshop service_types.id is a separate design pass — planned but
  not in scope for this launch.

### Errors

| Status | Code            | When |
|--------|-----------------|------|
| `400`  | `BAD_REQUEST`   | Missing/invalid `year`, negative `km`, missing `make` / `model`. |
| `404`  | `NOT_FOUND`     | Only on `/models` and `/series` when the make/model slug doesn't exist. Never on `/overview` (see graceful degradation above). |

---

## Cache-Control

| Endpoint | Header |
|----------|--------|
| `/years` | `public, max-age=86400, s-maxage=86400` |
| `/makes`, `/models`, `/series` | `public, max-age=3600, s-maxage=86400` |
| `/overview` (no km) | `public, max-age=3600, s-maxage=86400` |
| `/overview` (with km) | `public, max-age=600, s-maxage=3600` |

Feel free to layer client-side caching / SWR on top — the endpoints
are idempotent and cheap.

---

## Slug conventions

- Lowercase ASCII, hyphenated, no punctuation.
- `mercedes-benz`, `alfa-romeo`, `mg-b`, `3-series`, `s-cross`, `landcruiser-prado`
- Slugs are the canonical id — always URL-safe, never spaces.
- Names (`Mercedes-Benz`, `Alfa Romeo`, `MG B`) are the display strings.

---

## Live examples

```bash
BASE=https://fzzrkscwd7.execute-api.ap-southeast-2.amazonaws.com/public/vehicle-catalog

curl -sS "$BASE/years" | jq
curl -sS "$BASE/makes?year=2017" | jq
curl -sS "$BASE/models?year=2017&make=suzuki" | jq
curl -sS "$BASE/series?year=1973&make=ford&model=falcon" | jq       # returns XA + XB
curl -sS "$BASE/series?year=2017&make=toyota&model=corolla" | jq    # returns [] — skip step
curl -sS "$BASE/overview?year=2017&make=suzuki&model=vitara&km=82000" | jq
```

---

## Not in scope

- **`suggestedServiceTypeIds`** — always `[]`. Mapping common repairs
  to your service-types picker is a follow-up.
- **Staff catalog admin UI** — step 3 of the catalog rollout; brief
  will land separately once the endpoints ship. Custom classic models
  (personal imports, obscure trims) get hand-added there.
- **Rate limiting** — no server-side cap. Fine to add ~60 req/min/IP
  at Cloudflare if scraping becomes a concern; the endpoints all
  cache heavily so real users won't ever see 429s.
