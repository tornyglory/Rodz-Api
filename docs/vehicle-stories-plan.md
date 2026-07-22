# Vehicle Stories — Plan

Facebook-style event posts anchored to a vehicle: title + description + user-picked event date + attached photos/videos. Comments + emoji reactions from authenticated Rodz customers. Shows on the vehicle's public logbook page when the owner opts in.

**Product framing:** enthusiast documentation surface — "here's what happened to my car." A 6-month respray. New wheels reveal. Track-day video montage. Discovery via URL sharing (car forum posts, Facebook Marketplace listing, DM to a friend, QR code at a car meet).

**Status (2026-07-23):** Sprint 1 (draft/publish + media) and Sprint 2 (comments + reactions + push) **DELIVERED**. Sprint 3 (public logbook endpoints) still pending. Frontend brief lives at `docs/customer-stories-frontend-brief.md`.

---

## Design decisions (locked)

| # | Decision | Chosen |
|---|----------|--------|
| 1 | Commenter identity | **Authenticated Rodz customers only** — comment/react endpoints require customer JWT |
| 2 | Reaction set | Fixed 5 emojis — 👍 like, ❤️ love, 🔥 fire, 😲 wow, 🤔 thinking. One per viewer per story (Facebook-style). |
| 3 | New-story default | **`draft`** — owner explicitly hits Publish. Publish rejects if any attached video is still `process_status !== 'ready'` |
| 4 | Notifications | Push on new comment; reactions silent. New `story_comment` topic in `customer_notification_prefs` (default on, mute-able) |
| 5 | Post-publish editing | Editable freely, viewers see "(edited)" when `updated_at > published_at` — standard modern-social pattern |
| 6 | Discovery | Public URL only in v1 — no feed. Discovery via customer sharing the `/logbook/:token/stories/:id` URL |
| 7 | Limits | Description 2000 chars · 20 media per story · 5 videos × 3 min × 100 MB · 20 photos × existing customer image limit |

**Two-level public gate:**
- `publicProfileSettings.stories` (new key, defaults `true`) — section-level toggle
- `stories.is_public` per row — per-story toggle
- Both must be `true` for the story to show on the public logbook

---

## Data model

### `stories`

```sql
CREATE TABLE stories (
  id                BIGINT UNSIGNED   NOT NULL AUTO_INCREMENT PRIMARY KEY,
  vehicle_id        BIGINT UNSIGNED   NOT NULL,
  customer_id       BIGINT UNSIGNED   NOT NULL,
  title             VARCHAR(200)      NOT NULL,
  description       TEXT              NULL,             -- max 2000 chars (enforced at handler)
  event_date        DATE              NOT NULL,         -- user-picked; when it happened
  is_public         TINYINT(1)        NOT NULL DEFAULT 1,   -- per-row public gate
  status            ENUM('draft','published') NOT NULL DEFAULT 'draft',
  published_at      DATETIME          NULL,             -- set on first publish; unchanged on subsequent edits
  created_at        DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at        DATETIME          NULL,

  KEY idx_vehicle_event (vehicle_id, deleted_at, event_date DESC),
  KEY idx_customer      (customer_id, deleted_at),
  KEY idx_status        (status, deleted_at, published_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

**"(edited)" detection:** `updated_at > published_at` when `status = 'published'`.

### `story_media`

Media rows reference either a Cloudflare image ID (photos, existing pipeline) or a `video_assets.id` (videos, existing R2 pipeline). One media row per attachment. Sort order manually managed.

```sql
CREATE TABLE story_media (
  id                BIGINT UNSIGNED   NOT NULL AUTO_INCREMENT PRIMARY KEY,
  story_id          BIGINT UNSIGNED   NOT NULL,
  media_type        ENUM('image','video') NOT NULL,
  cf_image_id       VARCHAR(80)       NULL,             -- set when media_type='image'
  video_asset_id    BIGINT UNSIGNED   NULL,             -- FK-ish to video_assets when media_type='video'
  sort_order        SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  created_at        DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at        DATETIME          NULL,

  KEY idx_story (story_id, deleted_at, sort_order),
  CONSTRAINT fk_story_media_story FOREIGN KEY (story_id) REFERENCES stories(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

Constraint at handler level: exactly one of `cf_image_id` or `video_asset_id` set per row. Enforced in code, not DB, because MySQL doesn't have partial constraints and a CHECK on it is verbose.

### `story_comments`

```sql
CREATE TABLE story_comments (
  id                BIGINT UNSIGNED   NOT NULL AUTO_INCREMENT PRIMARY KEY,
  story_id          BIGINT UNSIGNED   NOT NULL,
  customer_id       BIGINT UNSIGNED   NOT NULL,         -- author
  body              TEXT              NOT NULL,         -- max 1000 chars enforced at handler
  created_at        DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at        DATETIME          NULL,

  KEY idx_story (story_id, deleted_at, created_at DESC),
  KEY idx_customer (customer_id, deleted_at),
  CONSTRAINT fk_story_comment_story FOREIGN KEY (story_id) REFERENCES stories(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

Flat threading — no parent_comment_id. If replies-to-replies become important later, we add.

### `story_reactions`

```sql
CREATE TABLE story_reactions (
  id                BIGINT UNSIGNED   NOT NULL AUTO_INCREMENT PRIMARY KEY,
  story_id          BIGINT UNSIGNED   NOT NULL,
  customer_id       BIGINT UNSIGNED   NOT NULL,
  kind              ENUM('like','love','fire','wow','thinking') NOT NULL,
  created_at        DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  UNIQUE KEY uk_story_customer (story_id, customer_id),   -- one per customer per story
  KEY idx_story (story_id),
  CONSTRAINT fk_story_reaction_story FOREIGN KEY (story_id) REFERENCES stories(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

Changing your reaction = `INSERT ... ON DUPLICATE KEY UPDATE kind = VALUES(kind)`. Removing = `DELETE`. No `deleted_at` because reactions don't need audit trail.

### `video_assets.context_type` — new value

```sql
ALTER TABLE video_assets
  MODIFY context_type ENUM('quote','chat','vehicle','modification','invoice','story') NOT NULL;
```

Adds `story`. Story videos live at `story-clips/{storyId}/{videoId}.mp4` in R2. Same post-process pipeline (thumbnail extraction, dimension/duration verification) as quote clips.

### `customer_notification_prefs` — new column

```sql
ALTER TABLE customer_notification_prefs
  ADD COLUMN story_comment TINYINT(1) NOT NULL DEFAULT 1 AFTER quiet_hours_end;
```

Owner can mute via the existing `PATCH /c/me/notification-prefs` endpoint.

### `publicProfileSettings.stories`

Extend `src/shared/publicProfileSettings.ts`:
- Interface: add `stories: boolean`
- Defaults: `stories: true`
- Parser: same "default true, only false if explicitly false" logic as the other keys
- Sanitiser: accept `stories` boolean in patch

Staff-side "unknown keys" check auto-updates via `Object.keys(PUBLIC_PROFILE_DEFAULTS)`.

---

## Endpoint surface

All under the customer JWT authorizer unless noted.

### Story CRUD

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/c/vehicles/{vehicleId}/stories` | Create (starts as `draft`) |
| `GET`  | `/c/vehicles/{vehicleId}/stories` | List own vehicle's stories (drafts + published) |
| `GET`  | `/c/stories/{id}` | Get one — full story including media, comment/reaction summaries |
| `PATCH` | `/c/stories/{id}` | Update title/description/event_date/is_public |
| `POST` | `/c/stories/{id}/publish` | Transition draft → published. Rejects with 422 if any video is still processing. |
| `DELETE` | `/c/stories/{id}` | Soft-delete story + cascade to media/comments/reactions |

### Media attach

| Method | Path | Purpose |
|--------|------|---------|
| `GET`  | `/c/stories/{id}/videos/upload-url?contentType=video/mp4` | R2 presigned PUT URL |
| `POST` | `/c/stories/{id}/media` | Attach — body carries `imageId` or `videoAssetId` |
| `PATCH` | `/c/stories/{id}/media/reorder` | Reorder — body carries ordered array of media ids |
| `DELETE` | `/c/stories/{id}/media/{mediaId}` | Detach + hard-delete underlying R2 object if draft |

**Image upload** — reuses the existing customer image-upload endpoint (whatever it is; I'll wire to the same shared Cloudflare Images token). Frontend gets a `cf_image_id`, POSTs to `/media` with `{ imageId: '...' }`.

**Video upload** — `story-clips/{storyId}/{uuid}.mp4` prefix. Post-process (thumbnail extraction, dimension/duration) runs same as quote clips. Attached to the story via `POST /media` with `{ videoAssetId: <id> }`.

### Comments

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/c/stories/{id}/comments` | Add — body carries `body`. Fires async push to story owner (skipped when commenter is the owner). |
| `GET`  | `/c/stories/{id}/comments?before={commentId}&limit={n}` | List — keyset pagination, newest first. Returns commenter first-name-last-initial + avatar. Response includes `nextBefore` cursor (null on last page). |
| `PATCH` | `/c/stories/{id}/comments/{commentId}` | Edit — comment author only (403 for non-authors, even the story owner) |
| `DELETE` | `/c/stories/{id}/comments/{commentId}` | Soft-delete — comment author OR story owner (owner moderation power) |

### Reactions

| Method | Path | Purpose |
|--------|------|---------|
| `PUT`  | `/c/stories/{id}/reactions` | Upsert — body carries `kind`. Switching kinds replaces the row via `ON DUPLICATE KEY UPDATE`. Returns full summary + viewer's new `myReaction`. |
| `DELETE` | `/c/stories/{id}/reactions` | Remove own reaction. Idempotent — always returns 200 with the current summary regardless of whether a row existed. |

No separate `GET /reactions/summary` endpoint — the summary is always embedded on the story GET response (and returned by PUT/DELETE reactions so the frontend can update optimistic state without a re-fetch).

### Public (via logbook token)

| Method | Path | Purpose |
|--------|------|---------|
| `GET`  | `/logbook/{token}/stories` | List published + public stories on the vehicle |
| `GET`  | `/logbook/{token}/stories/{id}` | One story with media + comments + reactions summary |

Public endpoints respect the two-level gate: `publicProfileSettings.stories === true` AND `stories.is_public === true` AND `stories.status === 'published'`.

Interaction endpoints (comment/react) always require customer JWT — a public viewer without a Rodz account can read but can't engage.

---

## Response shape

`GET /c/stories/{id}` and `GET /logbook/{token}/stories/{id}` return the same shape:

```json
{
  "id":              42,
  "vehicleId":       9,
  "customerId":      17,      // omitted on the public endpoint
  "title":           "6-month respray finally done",
  "description":     "Started stripping in January…",
  "eventDate":       "2026-06-30",
  "isPublic":        true,
  "status":          "published",
  "publishedAt":     "2026-07-05T10:22:14.000Z",
  "updatedAt":       "2026-07-05T10:22:14.000Z",
  "isEdited":        false,       // derived: updated_at > published_at

  "author": {
    "name":          "N. Rodda",
    "avatarUrl":     "https://cdn.rodz.com.au/avatars/17/xyz.jpg"
  },

  "media": [
    {
      "id":            123,
      "mediaType":     "image",
      "url":           "https://imagedelivery.net/…/hash/public",
      "thumbnailUrl":  "https://imagedelivery.net/…/hash/thumbnail",
      "sortOrder":     0
    },
    {
      "id":            124,
      "mediaType":     "video",
      "videoAssetId":  55,
      "url":           "https://<r2endpoint>/…?signed",   // presigned; refresh endpoint like quote videos
      "urlExpiresAt":  "2026-07-05T10:37:14.000Z",
      "thumbnailUrl":  "https://cdn.rodz.com.au/video-thumbnails/55.jpg",
      "durationSeconds": 47.2,
      "width":         1920,
      "height":        1080,
      "processStatus": "ready",
      "sortOrder":     1
    }
  ],

  "reactions": {
    "counts":     { "like": 12, "love": 3, "fire": 8, "wow": 1, "thinking": 2 },
    "myReaction": "fire"    // null on the public endpoint when the viewer has no account
  },

  "commentCount": 7,
  "comments": [               // first page embedded; further pages via /comments endpoint
    {
      "id":         501,
      "body":       "Colour looks incredible",
      "author":     { "name": "S. Chen", "avatarUrl": "…" },
      "createdAt":  "2026-07-05T11:15:22.000Z",
      "updatedAt":  "2026-07-05T11:15:22.000Z",
      "isEdited":   false,
      "isMine":     false      // helps the frontend decide to show edit/delete buttons
    }
  ]
}
```

**Notes:**
- On public endpoints, `customerId` and `myReaction` and `isMine` are omitted (no viewer identity).
- Video URLs are presigned for now — same 15-min TTL as quote clips. Would be cleaner to make story videos `visibility: 'public'` and serve via `cdn.rodz.com.au` (free egress), but that means the R2 object is hitchable anywhere. Decide in Sprint 1.
- Photos always public via `imagedelivery.net` (existing pattern).

---

## Publish flow

`POST /c/stories/{id}/publish`:

1. Load story. If not draft → 422.
2. Check every attached video: query `video_assets` for `context_type='story' AND context_id=storyId`. If any has `process_status !== 'ready'` → return 422 with a list of the still-processing video ids. Frontend can poll and retry.
3. Otherwise: `UPDATE stories SET status='published', published_at=NOW() WHERE id=?`.
4. Cache-purge the vehicle context (assistant needs to know about the new story? probably not for chat — but future-proof.)
5. Return the fresh story object.

Draft-first + this guard eliminates the "half-processed video" edge case entirely.

---

## Sprint plan

### Sprint 1 — schema + core CRUD + media — **DELIVERED (commit `f78ad1b`)**

- `docs/migrations/stories_and_story_media.sql`
- `docs/migrations/story_video_context_type.sql` (ALTER video_assets.context_type)
- `docs/migrations/notification_prefs_story_comment.sql` (ALTER customer_notification_prefs)
- Extended `src/shared/publicProfileSettings.ts` with `stories: boolean`
- `src/customer/vehicles/stories/{_helpers,create,list,get,update,publish,delete}.ts`
- `src/customer/vehicles/stories/{video-upload-url,media-attach,media-reorder,media-delete}.ts`
- CDK routes in Stack 3 with customer authorizer

Shipped: customer can create a draft story on their vehicle, attach photos + videos, reorder, and publish.

### Sprint 2 — comments + reactions + notifications — **DELIVERED (commit `4652049`)**

- `docs/migrations/story_comments_and_reactions.sql`
- Comment handlers: `comment-create.ts`, `comment-list.ts`, `comment-update.ts`, `comment-delete.ts`
- Reaction handlers: `reaction-set.ts` (PUT upsert), `reaction-remove.ts` (DELETE)
- `notify-comment.ts` async Lambda invoked (`InvocationType: Event`) from comment-create — routes through the shared `pushToCustomer` helper for prefs/dedupe/rate-limits
- `story_comment` added to `PushType` union + `PREF_COLUMN` map in `src/shared/push.ts`
- `GET /c/me/notification-prefs` + `PATCH` extended for `storyComment`
- `GET /c/stories/:id` + `POST /c/stories/:id/publish` now return real `reactions.counts`, `reactions.myReaction`, `commentCount`, and first page of `comments` (Sprint 1 placeholders removed)

Verified 45/45 checks in `scripts/smoke-stories-sprint2.mjs` against prod.

### Sprint 3 — public logbook + frontend brief

- `src/vehicles/logbook-stories.ts` — public list + detail endpoints
- Extend `parsePublicProfileSettings` + defaults with `stories: true` (already covered in Sprint 1)
- Update the public-profile-visibility brief with the new toggle
- New `docs/customer-stories-frontend-brief.md` — full frontend spec (record UX, upload flow, story-composer UI, comment/reaction UX)

**Ships**: stories visible on `/logbook/:token/stories` for anyone with the URL. Frontend engineer has a spec to build against.

### Later — post-v1 ideas (not doing yet)

- Discovery feed (chronological or "For You")
- Story sharing via native iOS/Android share sheet with pre-populated Open Graph metadata (adds SEO markup work)
- Replies-to-comments (threaded)
- @mentions of the story owner in comments → push notification
- Reactions on comments (👍 a reply)
- "Highlights" — a curated subset of a vehicle's stories pinned to the top of its public page
- Story analytics — how many views, where they came from
- Story templates — pre-populated stories for common milestones ("100k km celebration", "new tyres", etc.)

---

## Open non-blockers to flag

**Video visibility for story videos** — presigned URL (matches quote clips) or fully public via `cdn.rodz.com.au` (free egress, hitchable)? Presigned is safer but adds refresh complexity for the public logbook viewer. Recommend: **public** for story videos because they're already meant for anonymous public viewing, matches the mod-showcase pattern. Punt to Sprint 1 implementation — trivial to change.

**Comment length** — set at 1000 chars. Long enough for a real comment, short enough that nobody writes an essay. Adjust based on real usage.

**Rate limiting** — comment spam is a real risk even with authenticated users. Suggest a soft cap of 5 comments/minute per customer per story to prevent someone stress-testing the notification system. Handler-side check via `checkAndRecord`. Not v1-blocking.
