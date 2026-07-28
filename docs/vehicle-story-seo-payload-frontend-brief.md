# Story SEO payload — frontend brief

Story-scoped SEO endpoint is **live**. Your existing Worker fallback
(prefer this endpoint, fall back to the vehicle payload's
`storiesPreview` on 404) starts getting hits the moment you point at it.

Full reference: [`vehicle-story-seo-payload-endpoint.md`](./vehicle-story-seo-payload-endpoint.md).
Sibling: [`vehicle-seo-payload-endpoint.md`](./vehicle-seo-payload-endpoint.md).

---

## Endpoint

```
GET /logbook/{token}/stories/{storyId}/seo-payload
```

`storyId` is the raw numeric id (e.g. `39`). Response `story.id` comes
back prefixed as `s-39` to match the preview convention.

**No auth.** Same `Cache-Control` as the vehicle payload:

```
public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400
```

---

## What you get

**When `searchIndex: true`:**

```ts
{
  searchIndex:  true
  lastMutation: string

  vehicle: {
    year: number; make: string; model: string
    logbookToken: string
    coverUrl:  string | null
    avatarUrl: string | null
  }

  story: {
    id:                   string   // "s-39"
    title:                string
    preview:              string | null   // first 200 chars of body
    body:                 string | null   // full body — safe for noscript prose
    eventDate:            string | null   // "YYYY-MM-DD"
    coverUrl:             string | null   // first attached image
    hasVideo:             boolean
    reactionsCount:       number
    videoUrl:             string | null   // see nullability below
    videoDurationSeconds: number | null   // decimal seconds
  }

  ownerCard?: {         // omitted when hidden or owner has no first name
    displayName: string        // "Neville R."
    city:        string | null
    avatarUrl:   string | null
    memberSince: string        // "YYYY-MM"
  }
}
```

**When `searchIndex: false`** (minimal):

```ts
{
  searchIndex:  false
  vehicle:      { year, make, model, logbookToken }
  story:        { id, title }
  lastMutation: string
}
```

→ Inject `<meta robots noindex>` and skip the rich HTML.

---

## Two things to know

**1. `videoUrl` is `null` unless the video is `ready` AND `public`.**

`hasVideo` tells you a video exists on the story. `videoUrl` tells you
whether you can render a crawlable URL. When it's null (still processing,
private, or shared-link visibility), skip the `<video>` element in the
noscript block and omit `contentUrl` from JSON-LD's `VideoObject`. Use
`embedUrl` = the story page URL as the weaker fallback.

**2. `videoDurationSeconds` is decimal.**

Convert to ISO 8601 `PT{n}S` for `VideoObject.duration`:

```ts
const iso = data.story.videoDurationSeconds != null
  ? `PT${Math.round(data.story.videoDurationSeconds)}S`
  : undefined
```

---

## Errors

| Status | Meaning | What to render |
|--------|---------|---------------|
| `404`  | Token or story missing / draft / private / stories toggle off | SPA with `noindex` meta — don't 404 the page itself |
| `410`  | Vehicle soft-deleted | Same as 404 |
| `422`  | Non-integer `storyId` in the URL | Same as 404 |
| `5xx`  | Backend down | Fall through to bare SPA (crawlers re-crawl later) |

---

## JSON-LD suggestion

For story pages you want a nested `VideoObject` inside an `Article`:

```jsonc
{
  "@context": "https://schema.org",
  "@type":    "Article",
  "headline": data.story.title,
  "datePublished": data.story.eventDate,
  "dateModified":  data.lastMutation,
  "articleBody":   data.story.body,
  "image":         data.story.coverUrl ? [data.story.coverUrl] : undefined,
  "author": data.ownerCard
    ? { "@type": "Person", "name": data.ownerCard.displayName }
    : undefined,
  "video": data.story.hasVideo ? {
    "@type": "VideoObject",
    "name":  data.story.title,
    "thumbnailUrl": data.story.coverUrl ?? data.vehicle.coverUrl,
    "uploadDate":   data.story.eventDate,
    "duration":     data.story.videoDurationSeconds != null
                    ? `PT${Math.round(data.story.videoDurationSeconds)}S`
                    : undefined,
    "contentUrl":   data.story.videoUrl ?? undefined,   // omit when private
    "embedUrl":     `${SITE_URL}/vehicle/${data.vehicle.logbookToken}/stories/${storyId}`,
  } : undefined,
}
```

---

## Testing

```bash
# Live smoke — a real story with a public video
curl -sS https://fzzrkscwd7.execute-api.ap-southeast-2.amazonaws.com/logbook/2514582785332ab87a7c467e960f7e02eb570ea4d18dfa101a315295c1920426/stories/39/seo-payload | jq

# Nonexistent story
curl -sS -w "\n%{http_code}\n" .../stories/999999/seo-payload    # → 404
```

Google's [Rich Results Test](https://search.google.com/test/rich-results)
validates the Article + VideoObject markup once you're live on a
preview URL.

---

## Not in scope (yet)

- **Dedicated story sitemap** (`/sitemap-stories.xml`). Fine for now —
  Google finds stories via the vehicle payload's `storiesPreview`.
  Add when story count crosses ~few thousand.
- **Cache purge on reaction / edit.** Response staleness is bounded by
  the 5-min Redis TTL + 1h edge cache. If we need faster crawler
  freshness on reaction counts, we'll add a Cloudflare purge hook —
  needs backend env vars.
