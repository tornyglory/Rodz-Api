# `GET /logbook/{token}/seo-payload` — consolidated prerender payload

Purpose-built read endpoint for the Cloudflare Pages Function that
server-renders `/vehicle/{token}` for search engines and social crawlers.
One request returns **everything** the Function needs to emit a
content-rich HTML page in a single edge fetch — no fan-out calls, no
LLM round-trips, no async waterfalls.

Related: [`vehicle-search-index-toggle-frontend-brief.md`](./vehicle-search-index-toggle-frontend-brief.md) — the gating flag this endpoint honours.

Handler: `src/vehicles/logbook-seo-payload.ts`
Route registration: `cdk/lib/rodz-api-stack3.ts`
Sitemap sibling: [`GET /vehicles/public-index`](#get-vehiclespublic-index--sitemap-feed) (bottom of this doc)

---

## Why a new endpoint?

The Function is on Cloudflare's edge; every API call it makes costs
p50 latency users notice. Composing the payload backend-side lets us:

- Do 4–5 DB reads in one connection instead of 4–5 HTTPS hops from the
  edge.
- Guarantee tight sub-fields (previews, top-N joins) without shipping
  the full logbook / modification list / stories to the Function and
  wasting bytes.
- Encode duplicate-content policy (**never leak shared AI facts as
  prose**) in one place instead of relying on the Function to remember.
- Return one canonical `lastMutation` timestamp so the edge cache key
  can bust cleanly when anything the SEO page cares about changes.

---

## Route

```
GET /logbook/{token}/seo-payload
```

**Public.** No auth header. Same threat model as `GET /logbook/{token}/vehicle`
today — the token is the entire access control.

### Gate — `searchIndex`

If `publicProfileSettings.searchIndex === false`, respond `200` with a
**minimal payload**:

```json
{
  "searchIndex":  false,
  "vehicle":      { "rego": "…", "regoState": "VIC", "year": …, "make": "…", "model": "…" },
  "lastMutation": "2026-07-26T12:34:56.000Z"
}
```

The Function will emit `<meta name="robots" content="noindex, nofollow">`
and skip the rich HTML entirely.

If `searchIndex === true`, respond with the full payload below.

---

## Response — 200 (full payload)

See handler for the exact shape. Key fields:

- **`lastMutation`** — the most recent `updated_at` across everything
  the payload reflects (vehicle row, override, gallery, published
  stories, top logbook entries, top mods). Cloudflare Pages Function
  keys its edge cache on `${token}:${lastMutation}` so a fresh write
  bypasses stale HTML naturally.

- **`aiOverview.source`** — critical for duplicate-content policy:
  - `"override"` → the owner has regenerated with a tone; the text is
    **unique to this vehicle**. Safe to render as visible prose.
  - `"base"` → nobody has regenerated; the text is the shared per-
    (make, model, year) narrative. **`text` is `null`** — the Function
    must fall back to `description` / `ownerDescription` for body prose.
  - `null` → no AI profile exists for this model yet.

  This is how we prevent Google penalising us for a thousand near-
  identical body copies of "The 2017 Suzuki Vitara is…". Locked down
  by unit test at `tests/unit/logbookSeoPayload.unit.test.ts`.

- **`ownerCard`** — first name + last-initial (`"Neville R."`).
  Never full name / never email. Owner-card visibility is derived from
  `publicProfileSettings.chat` as a v1 proxy (extend to a dedicated
  `ownerCard` flag later if needed).

- **`serviceHistoryPreview`** — top 10 newest from `vehicle_service_history`.
  Omitted entirely when `publicProfileSettings.history === false`.

- **`modificationsPreview`** — top 5 by `cost_aud` DESC from
  `vehicle_modifications` where `is_public = 1 AND deleted_at IS NULL`.
  Omitted when `publicProfileSettings.modifications === false`.

- **`storiesPreview`** — top 3 newest from `stories` where
  `status = 'published' AND is_public = 1 AND deleted_at IS NULL`.
  Omitted when `publicProfileSettings.stories === false`.

- **`gallery`** — up to 20 items from `vehicle_gallery_images`. Omitted
  when `publicProfileSettings.photos === false`.

- **Image URLs** — always the Cloudflare Images `imagedelivery.net`
  form. Cover/gallery use `public`, mod thumbs use `thumbnail`.

### What must NOT appear in this payload

These come from the shared `vehicle_model_profiles` table (same for
every 2017 Vitara). Rendering them as body prose across thousands of
pages is the exact "duplicate content" trap that gets sites demoted.

- `engineSpecs` (oil type, coolant, brake fluid, spark plugs)
- `tyreSpecs` (recommended sizes, pressures)
- `commonRepairs`, `serviceNotes`, `knownIssues` (base form)

The `overview` field also falls under this rule when
`aiOverview.source === "base"`. Only the **override** version may be
surfaced as body prose.

None of this data is lost — the Function still emits structured data
via the `Vehicle` JSON-LD schema (`engineDisplacement`, etc.) where
Google indexes it without penalising the body content.

---

## Cache-Control

```
Cache-Control: public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400
```

Backend cache: 5-minute Redis cache keyed on `seo:${token}`. The cached
entry stores its own `lastMutation`; a request with a newer vehicle
`updated_at` bypasses the cache and reshapes.

### CDN purge on write

For v1, no explicit CDN purge trigger — we lean on
`vehicles.updated_at` bumping on every write. Every mutation that
should invalidate the SEO page (vehicle edit, override regenerate,
gallery, mods, stories) touches `vehicles.updated_at` via the existing
handlers. The `lastMutation`-in-cache-key pattern makes the API cache
self-invalidating.

If crawler freshness proves a problem later, add a Cloudflare purge
call on `PATCH /c/vehicles/{id}*` — needs `CF_ZONE_ID` +
`CF_PURGE_TOKEN` on `sharedEnv`.

---

## Errors

| Status | Code            | When                                                     |
|--------|-----------------|----------------------------------------------------------|
| `404`  | `NOT_FOUND`     | Token doesn't map to a vehicle (never existed / rotated).|
| `410`  | `GONE`          | Vehicle soft-deleted.                                    |
| `500`  | `INTERNAL_ERROR`| DB unavailable — Function should serve stale-while-revalidate. |

**Never `403`** — no auth on this endpoint. Everything is either
publicly renderable (searchIndex=true → full payload) or minimally
identifiable (searchIndex=false → minimal payload with a robots gate).

---

## Testing checklist

- [ ] Token that doesn't exist → `404 NOT_FOUND`
- [ ] Token whose vehicle is soft-deleted → `410 GONE`
- [ ] Vehicle with `searchIndex: false` → 200 with minimal payload
      (only `searchIndex`, `vehicle`, `lastMutation`)
- [ ] Vehicle with `searchIndex: true` and no override → response has
      `aiOverview: { source: "base", tone: null, text: null }`
      (the base text is *not* leaked) — verified by
      `tests/unit/logbookSeoPayload.unit.test.ts`
- [ ] Owner regenerates with `tone: "enthusiast"` → response has
      `aiOverview: { source: "override", tone: "enthusiast", text: "…" }`
- [ ] `publicProfileSettings.history === false` → response omits
      `serviceHistoryPreview` entirely
- [ ] `publicProfileSettings.modifications === false` → response
      omits `modificationsPreview` entirely
- [ ] `publicProfileSettings.photos === false` → response omits
      `gallery` entirely
- [ ] Second request within 5 min returns from Redis cache (same
      `lastMutation`)

---

# `GET /vehicles/public-index` — sitemap feed

Lightweight companion endpoint for the Cloudflare Pages Function that
generates `/sitemap.xml`. Returns just what the Function needs to emit
`<url>` entries for every indexable vehicle.

## Route

```
GET /vehicles/public-index
```

**Public.** No auth.

## Response — 200

```json
{
  "items": [
    { "token": "5c06f294…", "updatedAt": "2026-07-26T12:34:56.000Z" },
    { "token": "a1b2c3d4…", "updatedAt": "2026-07-25T09:14:20.000Z" }
  ]
}
```

Filter is `is_active = 1 AND logbook_token IS NOT NULL AND
public_profile_settings.searchIndex IS NOT false`. Missing key
defaults to indexable (per the shared parser).

## Cache-Control

Same as `seo-payload` — `public, max-age=3600, s-maxage=3600,
stale-while-revalidate=86400`. The sitemap doesn't need per-second
freshness; a new vehicle appearing an hour late is fine.

## Consumer expectations

The Pages Function should:
1. Fetch this endpoint.
2. Emit `<url><loc>https://rodz.com.au/vehicle/{token}</loc><lastmod>{updatedAt}</lastmod></url>` per item.
3. Cache the resulting XML at the edge (1h fits fine).

Submit the sitemap URL to Google Search Console + Bing Webmaster Tools
once the Pages Function ships.
