# `GET /logbook/{token}/stories/{storyId}/seo-payload`

Story-scoped SEO payload consumed by the Cloudflare Pages Function
(actually a Worker in front of Azure SWA — see
[`prerender-cloudflare-function.md`](./prerender-cloudflare-function.md))
at `/vehicle/{token}/stories/{storyId}`. Enables full server-side render
for individual stories so each one is independently indexable by
Google Discover / news carousel and shareable with proper preview cards.

**Currently the Worker falls back to the vehicle-scoped seo-payload's
`storiesPreview` array**, which only covers the top 3 stories per vehicle.
This endpoint unlocks SSR for every published story regardless of position.

Related briefs:
- [`vehicle-seo-payload-endpoint.md`](./vehicle-seo-payload-endpoint.md) — the vehicle payload; this endpoint mirrors its shape.
- [`prerender-cloudflare-function.md`](./prerender-cloudflare-function.md) — Worker implementation reference.

Handler: `src/vehicles/logbook-story-seo-payload.ts`
Route registration: `cdk/lib/rodz-api-stack3.ts`

---

## Route

```
GET /logbook/{token}/stories/{storyId}/seo-payload
```

**Public.** No auth header. Same threat model as the vehicle seo-payload —
the magic-link token is the entire access control, and only published
(`is_public = 1`) stories are surfaced. Draft / private stories return `404`.

`storyId` is a positive integer (the raw `stories.id`). The response
`story.id` is prefixed as `s-{n}` to match the vehicle-payload preview
convention.

---

## Gating order

Enforced in this order to match the existing `logbook-story-detail.ts`:

1. Vehicle 404/410 — bad or soft-deleted token.
2. `publicProfileSettings.stories === false` → 404 (whole stories section hidden at the vehicle level).
3. Story 404 — missing, draft, `is_public = 0`, or soft-deleted.
4. `publicProfileSettings.searchIndex === false` → 200 minimal payload.
5. Otherwise → full payload.

---

## Minimal payload (`searchIndex: false`)

Same-shape wire contract as the vehicle minimal payload:

```json
{
  "searchIndex":  false,
  "vehicle":      { "year": 2024, "make": "Toyota", "model": "Corolla", "logbookToken": "…" },
  "story":        { "id": "s-39", "title": "Video Test" },
  "lastMutation": "2026-07-27T03:42:05.000Z"
}
```

The Worker emits `<meta name="robots" content="noindex, nofollow">` and skips the rich HTML.

---

## Full payload (`searchIndex: true`)

Verified live response:

```jsonc
{
  "searchIndex":  true,
  "lastMutation": "2026-07-27T03:42:05.000Z",

  "vehicle": {
    "year":         2024,
    "make":         "Toyota",
    "model":        "Corolla",
    "logbookToken": "2514582785332ab87a7c467e960f7e02eb570ea4d18dfa101a315295c1920426",
    "coverUrl":     "https://imagedelivery.net/…/…/public",
    "avatarUrl":    "https://imagedelivery.net/…/…/public"
  },

  "story": {
    "id":                   "s-39",
    "title":                "Video Test",
    "preview":              "Heya",           // first 200 chars of body
    "body":                 "Heya",           // full stories.description
    "eventDate":            "2026-07-27",
    "coverUrl":             null,             // first attached image, if any
    "hasVideo":             true,
    "reactionsCount":       0,
    "videoUrl":             "https://cdn.rodz.com.au/story-clips/39/…mp4",
    "videoDurationSeconds": 14.88
  },

  "ownerCard": {
    "displayName":  "Neville R.",
    "city":         "Frankston South",
    "avatarUrl":    "https://imagedelivery.net/…/…/public",
    "memberSince":  "2026-06"
  }
}
```

### Field notes

- **`story.body`** — full `stories.description`. `story.preview` is the
  first 200 characters — same convention as the vehicle payload's
  `storiesPreview.items[].preview`.
- **`story.videoUrl`** — populated **only when both**:
  1. `video_assets.process_status = 'ready'`
  2. `video_assets.visibility = 'public'`
  
  Anything else (pending, failed, private, shared-link) keeps
  `hasVideo` true but `videoUrl` null. Crawlers can't do anything with
  a signed private URL anyway. Locked down by
  `tests/unit/logbookStorySeoPayload.unit.test.ts:shapeVideoUrl`.
- **`story.videoDurationSeconds`** — from `video_assets.duration_seconds`.
  Decimal seconds; convert to ISO 8601 `PTnS` for `VideoObject.duration`
  in JSON-LD on the Worker side.
- **`ownerCard`** — same shape and gating as the vehicle payload
  (`publicProfileSettings.chat` acts as v1 proxy). Omitted when not
  visible or when the owner has no first name on file.
- **`lastMutation`** — GREATEST(`vehicles.updated_at`,
  `stories.updated_at`, `video_assets.updated_at`). Story reactions
  today don't bump `stories.updated_at`; if crawler freshness on
  reaction counts matters later, add a trigger or bump on reaction
  write.

---

## Errors

| Status | Code            | When                                                                       |
|--------|-----------------|----------------------------------------------------------------------------|
| `404`  | `NOT_FOUND`     | Token doesn't exist, storyId missing/draft/`is_public = 0`, or stories toggle off. |
| `410`  | `GONE`          | Vehicle soft-deleted.                                                      |
| `422`  | `VALIDATION_ERROR` | Non-integer storyId in the URL.                                         |
| `500`  | `INTERNAL_ERROR` | DB unavailable — Worker will serve stale-while-revalidate.               |

**Never `403`** — no auth on this endpoint.

---

## Caching

Response headers identical to the vehicle payload:

```
Cache-Control: public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400
```

Backend Redis cache: 5-minute TTL keyed on `seo:story:${token}:${storyId}`.
Entry stores its own `lastMutation`; a newer mutation short-circuits
the cache and reshapes.

### CDN purge on write

For v1 we lean on `stories.updated_at` bumping to change the cache key,
same shortcut as the vehicle payload. Any handler that writes to
`stories`, `story_media`, or the parent `vehicles` row bumps their
`updated_at` via existing triggers. If crawler freshness on video
processing lags, extend the video-processor to bump the parent story's
`updated_at` on `process_status = 'ready'`.

If crawler freshness proves a problem, add a Cloudflare purge call on
story writes — needs `CF_ZONE_ID` + `CF_PURGE_TOKEN` on `sharedEnv`.

---

## Testing checklist (verified live on 2026-07-28)

- [x] Existing story (`s-39` on token `251458…0426`) → 200 with full payload, `videoUrl` present, `videoDurationSeconds: 14.88`
- [x] Non-existent story ID → `404 NOT_FOUND`
- [x] Non-existent token → `404 NOT_FOUND`
- [ ] Draft / private story (`is_public = 0` or `status != 'published'`) → `404 NOT_FOUND` (covered by SQL; not exercised live — needs a test row)
- [ ] Parent vehicle with `searchIndex: false` → minimal payload (not exercised live)
- [ ] Video with `visibility = 'private'` → `videoUrl: null`, `hasVideo: true` (unit-tested; not exercised live)
- [ ] Cache hit on second request within 5 min (same `lastMutation`)

---

## Volume / cost notes

- One request per story page view (Worker cache absorbs repeat crawls).
- Story pages are indexed less often than vehicle profiles (Google
  discovers them via the vehicle's `storiesPreview` initially, then via
  the sitemap).
- If story count grows past a few thousand, add a dedicated
  `/sitemap-stories.xml` — the current `/vehicles/public-index` only
  lists vehicles.
