# Vehicle profile — `searchIndex` toggle

Adds a per-vehicle "Allow search engines to find this vehicle" toggle so
owners can decide whether their magic-link vehicle profile is indexed by
Google et al. Extends the existing `publicProfileSettings` object with one
new boolean; every response that already exposes those settings picks it
up for free. **Defaults to `true`** — new vehicles are indexable out of
the box.

Context: we're about to prerender `/vehicle/:token` on the edge (Cloudflare
Pages Function) so search crawlers can index them. The `searchIndex` flag
tells the Function whether to emit the real content + Vehicle schema
(`true`) or a `<meta name="robots" content="noindex, nofollow">` stub
(`false`). Backend doesn't render the HTML — it just carries the flag
through the API.

## Data model

Extend the JSON-column `public_profile_settings` on `vehicles`:

```jsonc
{
  "history":       true,
  "photos":        true,
  "chat":          true,
  "maintenance":   true,
  "modifications": true,
  "searchIndex":   true   // NEW — default true for existing and new rows
}
```

**Migration:** existing rows should treat a missing `searchIndex` key as
`true` (the default). No backfill needed — the read path can default when
constructing the response object.

**No new column.** `public_profile_settings` is a JSON blob today; keep
adding keys to it rather than splintering into columns.

## Read paths — one new field on every response that carries settings

Every endpoint that returns `publicProfileSettings` now includes the new
key. No shape change; the frontend just picks up an extra boolean.

- `GET /c/vehicles/{id}` (customer, owner-authed)
- `GET /customers/{customerId}/vehicles/{vehicleId}` (staff)
- `GET /logbook/{token}/vehicle` (public magic-link — **required** so the
  Cloudflare Function can gate the robots meta)
- `GET /vehicles/:profileId/profile` (staff for-sale listing)

Response shape unchanged, plus:

```json
{
  ...
  "publicProfileSettings": {
    "history":       true,
    "photos":        true,
    "chat":          true,
    "maintenance":   true,
    "modifications": true,
    "searchIndex":   true
  }
}
```

## Write path — same PATCH, one more accepted key

`PATCH /c/vehicles/{id}` (and the staff equivalent) already accepts a
partial `publicProfileSettings`. Add `searchIndex` to the whitelist:

```http
PATCH /c/vehicles/7
Authorization: Bearer <customerToken>
Content-Type: application/json

{
  "publicProfileSettings": { "searchIndex": false }
}
```

- Owner-only (existing guard).
- Non-boolean values → `422 VALIDATION_ERROR` (server enforces the type on
  every key in the settings blob).
- Response: the full updated vehicle object with the new
  `publicProfileSettings.searchIndex` value.

## Cache purge

**Required on every write that flips `searchIndex`.** The public magic-link
page is edge-cached by the Cloudflare Pages Function; the `<meta robots>`
tag it emits depends on this flag. Reuse the existing purge trigger that
fires on `PATCH /c/vehicles/:id*` — no new purge hook needed.

If `searchIndex` was already true, we can skip the crawler-notify step;
if it flipped from true → false, kick off a background job (or manual
step) to notify Google Search Console + Bing Webmaster Tools to
de-index. Not in scope for v1 — the `noindex` meta tag will get picked
up on the next crawl.

## Frontend integration

Only the vehicle profile's **Settings tab → Public Profile Visibility**
card gets the new toggle. Same optimistic-write pattern as the existing
history/photos/chat/maintenance toggles — flip the local ref, PATCH,
roll back on failure.

- Default state: **on** — the toggle renders in the "green/enabled"
  position for new vehicles.
- Label: "Search engines"
- Hint: "Allow Google and others to find and link to this vehicle's
  public profile."

Non-owners never see this toggle (Settings tab is owner-only already).

## Testing notes

- `GET /c/vehicles/{id}` on a vehicle whose blob doesn't have `searchIndex`
  yet → response has `searchIndex: true` (default kicks in on read).
- `PATCH /c/vehicles/{id}` with `{ publicProfileSettings: { searchIndex: false } }`
  → returns updated object with `searchIndex: false`; other settings
  untouched.
- `PATCH .../publicProfileSettings: { searchIndex: "false" }` → `422` (type
  check).
- `GET /logbook/{token}/vehicle` for a vehicle with `searchIndex: false` →
  response reflects it so the Pages Function can render `noindex`.

---

## Follow-up (out of scope for this brief)

The Cloudflare Pages Function that renders the SSR shell for
`/vehicle/:token` reads `publicProfileSettings.searchIndex` from the
public logbook response and:

- `true`  → emit real `<title>`, `<meta og:*>`, `<meta description>`,
  visible summary content, and `<script type="application/ld+json">` with
  a `Vehicle` schema.
- `false` → emit the same content for hydration purposes but add
  `<meta name="robots" content="noindex, nofollow">` in the head. The
  page still works for anyone with the link, but crawlers won't index it.

Function implementation lives in a separate brief — see
`docs/endpoints/vehicle-prerender-pages-function.md` (todo).
