# Vehicle Stories — Frontend brief

Frontend spec for the Vehicle Stories feature. Backend delivered end-to-end — Sprint 1 (draft/publish + media), Sprint 2 (comments + reactions + push), and Sprint 3 (public logbook endpoints) are all live.

**Backing plan / schema:** `docs/vehicle-stories-plan.md`, `docs/schema.md` (§ Vehicle stories).

---

## Feature summary

Facebook-style event posts anchored to a vehicle. Owner composes a **draft** with title, description, event date, photos and videos → hits **Publish** → any authenticated Rodz customer can then react (five-emoji set) and comment. Owners get a push notification when someone comments (mute-able).

Discovery in v1 is URL-only — no feed, no "for you." Owners share the story link (car forum, marketplace listing, DM to a friend) and viewers land on it.

---

## Auth + base URLs

Every endpoint in this brief lives under the **customer JWT authorizer**. Include `Authorization: Bearer <jwt>` on every request.

Base URL: same customer API root the app already uses. Routes shown below start with `/c/...`.

---

## Endpoint catalogue

### Story CRUD

| Method | Path | Notes |
|--------|------|-------|
| `POST` | `/c/vehicles/{vehicleId}/stories` | Create draft. Body: `{ title, description?, eventDate, isPublic? }`. Returns `201 { story }`. |
| `GET`  | `/c/vehicles/{vehicleId}/stories` | List all own-stories on the vehicle (drafts + published). Card-ready payload per story: base fields + first 4 `media`, `mediaCount`, `reactions`, `commentCount`, and the 2 most recent `comments`. See `docs/customer-vehicle-stories-tab-frontend-brief.md` for the full shape and card design. |
| `GET`  | `/c/stories/{id}` | Full detail — includes media + reactions summary + first page of comments. Ownership-gated (returns 404 for non-owners in v1). |
| `PATCH` | `/c/stories/{id}` | Partial update. Any subset of `{ title, description, eventDate, isPublic }`. |
| `POST` | `/c/stories/{id}/publish` | Draft → published. **422** with `pendingVideoAssetIds` if any attached video is still processing — poll and retry. |
| `DELETE` | `/c/stories/{id}` | Soft-delete. Cascades to media, comments, reactions. |

### Media

| Method | Path | Notes |
|--------|------|-------|
| `GET`  | `/c/stories/{id}/videos/upload-url?contentType=video/mp4` | Returns `{ uploadUrl, r2Key, videoAssetId }`. PUT the file to `uploadUrl` directly from the browser. |
| `POST` | `/c/stories/{id}/media` | Attach. Body: `{ imageId }` (Cloudflare image id — reuse existing upload flow) OR `{ videoAssetId }` (the id returned by upload-url). Fires the video post-process Lambda for video attachments (thumbnail + duration). |
| `PATCH` | `/c/stories/{id}/media/reorder` | Body: `{ mediaIds: [id, id, ...] }` — full ordered array. |
| `DELETE` | `/c/stories/{id}/media/{mediaId}` | Detach. Drafts hard-delete the underlying R2 object; published stories retain it for audit. |

### Comments

| Method | Path | Notes |
|--------|------|-------|
| `POST` | `/c/stories/{id}/comments` | Body: `{ body }`. Returns `201 { comment }`. Fires async push to the story owner (skipped if commenter is the owner). |
| `GET`  | `/c/stories/{id}/comments?before={commentId}&limit={n}` | Keyset pagination, newest first. `limit` defaults to 20, capped at 100. `before` is the id of the oldest comment already loaded. Response: `{ comments, nextBefore }` — `nextBefore` is `null` on the last page. |
| `PATCH` | `/c/stories/{id}/comments/{commentId}` | Body: `{ body }`. **Author only** — 403 for anyone else, including the story owner. |
| `DELETE` | `/c/stories/{id}/comments/{commentId}` | Soft-delete. **Author OR story owner** — owners can moderate. |

### Reactions

| Method | Path | Notes |
|--------|------|-------|
| `PUT`  | `/c/stories/{id}/reactions` | Body: `{ kind }` — one of `like`, `love`, `fire`, `wow`, `thinking`. Upsert — switching kinds replaces the existing row. Returns `{ reactions }` (full summary + viewer's new `myReaction`). |
| `DELETE` | `/c/stories/{id}/reactions` | Removes viewer's reaction. Idempotent — returns 200 even if none existed. Returns `{ reactions }`. |

No separate `GET /reactions/summary` — the summary is embedded on `GET /c/stories/{id}` and returned by every PUT/DELETE reaction call. Use those responses to update optimistic UI state.

### Notification prefs

| Method | Path | Notes |
|--------|------|-------|
| `GET`  | `/c/me/notification-prefs` | Response includes `storyComment: boolean` (default `true`). |
| `PATCH` | `/c/me/notification-prefs` | Body: `{ storyComment: false }` (any subset). Mutes the story-comment push. |

Add "Story comments" as a toggle to the existing notification-prefs settings screen alongside "Booking updates", "Quote ready", etc.

### Public logbook (no auth)

Anonymous endpoints served under the shared logbook token — the same URL space as `/logbook/{token}/vehicle`, `/logbook/{token}/modifications`, etc. **No JWT.** Used by anyone with the shareable link.

| Method | Path | Notes |
|--------|------|-------|
| `GET`  | `/logbook/{token}/stories` | List all **published + public** stories on the vehicle. Two-level gate: `publicProfileSettings.stories` must not be false AND per-story `is_public = 1`. Response shape below. |
| `GET`  | `/logbook/{token}/stories/{id}` | Full detail — media + reactions counts + first 20 comments. 404 if the token doesn't own the story (cross-vehicle guessing guard) or if the story is draft / not public. |

**Interaction endpoints stay JWT-gated.** A public viewer without a Rodz account can read the story, watch the video, and see counts — but they can't comment or react. The frontend should show a "Sign in with Rodz to react or comment" CTA at that point.

The public response omits `customerId`, `reactions.myReaction`, and comment `isMine` fields — there's no viewer identity. It **adds** an `author: { name, avatarUrl }` card so viewers know whose story they're on (name is first-initial + last name, e.g. "S. Rodda").

```json
// GET /logbook/{token}/stories/{id}
{
  "story": {
    "id":            42,
    "vehicleId":     24,
    "title":         "6-month respray finally done",
    "description":   "Started stripping in January…",
    "eventDate":     "2026-06-30",
    "isPublic":      true,
    "status":        "published",
    "publishedAt":   "2026-07-05T10:22:14.000Z",
    "createdAt":     "2026-06-01T09:00:00.000Z",
    "updatedAt":     "2026-07-05T10:22:14.000Z",
    "isEdited":      false,

    "author": {
      "name":       "S. Rodda",
      "avatarUrl":  "https://cdn.rodz.com.au/avatars/…"
    },

    "media": [ /* same shape as authenticated */ ],

    "reactions": {
      "counts": { "like": 12, "love": 3, "fire": 8, "wow": 1, "thinking": 2 }
      // note: no myReaction on public
    },

    "commentCount": 7,
    "comments": [
      {
        "id":        501,
        "body":      "Colour looks incredible",
        "author":    { "name": "N. Rodda", "avatarUrl": "…" },
        "createdAt": "2026-07-05T11:15:22.000Z",
        "updatedAt": "2026-07-05T11:15:22.000Z",
        "isEdited":  false
        // note: no isMine on public
      }
    ]
  }
}
```

The list endpoint returns `{ stories: [...] }` where each entry has the same shape as `story` above but **without** the `comments` array (only `commentCount`) — keeps the list response light. Fetch the detail endpoint when the user opens a specific story.

---

## Response shapes

### Story (from `GET /c/stories/:id`, `POST /publish`, `POST /media`, etc.)

```json
{
  "story": {
    "id":            42,
    "vehicleId":     24,
    "customerId":    26,
    "title":         "6-month respray finally done",
    "description":   "Started stripping in January…",
    "eventDate":     "2026-06-30",
    "isPublic":      true,
    "status":        "published",
    "publishedAt":   "2026-07-05T10:22:14.000Z",
    "createdAt":     "2026-06-01T09:00:00.000Z",
    "updatedAt":     "2026-07-05T10:22:14.000Z",
    "isEdited":      false,

    "media": [
      {
        "id":            123,
        "mediaType":     "image",
        "sortOrder":     0,
        "cfImageId":     "abc123-xyz",
        "url":           "https://imagedelivery.net/…/abc123-xyz/public",
        "thumbnailUrl":  "https://imagedelivery.net/…/abc123-xyz/thumbnail"
      },
      {
        "id":              124,
        "mediaType":       "video",
        "sortOrder":       1,
        "videoAssetId":    55,
        "processStatus":   "ready",
        "durationSeconds": 47.2,
        "width":           1920,
        "height":          1080,
        "url":             "https://…?signed",
        "urlExpiresAt":    "2026-07-05T10:37:14.000Z",
        "thumbnailUrl":    "https://cdn.rodz.com.au/video-thumbnails/55.jpg"
      }
    ],

    "reactions": {
      "counts":     { "like": 12, "love": 3, "fire": 8, "wow": 1, "thinking": 2 },
      "myReaction": "fire"
    },

    "commentCount": 7,
    "comments": [
      {
        "id":         501,
        "body":       "Colour looks incredible",
        "author":     { "name": "S. Chen", "avatarUrl": "https://…/avatar.jpg" },
        "createdAt":  "2026-07-05T11:15:22.000Z",
        "updatedAt":  "2026-07-05T11:15:22.000Z",
        "isEdited":   false,
        "isMine":     false
      }
    ]
  }
}
```

### Notes on the shape

- `myReaction` is `null` if the viewer hasn't reacted.
- `reactions.counts` is always zero-filled — all five keys are present even if zero.
- `commentCount` is the total non-deleted count; `comments` is the first page only (up to 20). Load more via the paginated comments endpoint.
- `isEdited` on a story = `status === 'published' && updatedAt > publishedAt`.
- `isEdited` on a comment = `updatedAt > createdAt` (~1s slack absorbed by the backend).
- `isMine` on a comment = the viewer is the author. Use it to gate edit/delete buttons.
- Video `url` is a presigned R2 URL — refresh by re-fetching the story if the viewer keeps the page open past `urlExpiresAt` (~15 min TTL).

---

## Screens

### 1. Story composer (draft)

Entry point: "New story" button on the vehicle profile / logbook screen.

**Fields:**
- Title (required, 200 char max)
- Description (optional, 2000 char max, multi-line)
- Event date (required, date picker, defaults to today)
- Is public toggle (default on) — small "Show on my public profile" hint

**Media section** (below fields):
- Grid of thumbnails, drag-to-reorder.
- "Add photo" — opens native image picker → existing Cloudflare Images upload flow → `POST /media` with `{ imageId }`.
- "Add video" — GET the presigned URL, PUT the file (show progress bar), then `POST /media` with `{ videoAssetId }`. Show a "Processing…" spinner on the thumbnail until the story detail response reports `processStatus === 'ready'`.
- Photo cap: 20. Video cap: 5. Total cap: 20. Show limits in the UI once the user is close.

**Buttons:**
- "Save draft" — closes the composer. Story remains `draft`, not visible to anyone else.
- "Publish" — hits `/publish`. If it returns 422 with `pendingVideoAssetIds`, show a toast: "One or more videos are still processing. Try again in a moment." — auto-retry after 5s. Otherwise transition to the published story detail screen.

**Draft indicator:** while the story is `draft`, show a "Draft" pill in the header. Add a "Delete draft" button in the composer menu.

### 2. Story detail (published)

Layout, top to bottom:
- Header: title, "(edited)" if applicable, author byline (owner name + avatar), event date, "N days ago" timestamp.
- Media carousel — full-bleed photos, videos with native player + poster (`thumbnailUrl`). Swipe/arrow between items in `sortOrder`.
- Description block.
- Reactions bar: five emoji chips with count. Tapping a chip:
  - If viewer has no reaction: `PUT /reactions { kind }`, optimistic count +1.
  - If viewer has same reaction: `DELETE /reactions`, optimistic count -1.
  - If viewer has a different reaction: `PUT /reactions { kind }`, optimistic old-kind -1 and new-kind +1.
  - Use the response payload (full summary) to reconcile — this handles the case where another user reacted in the meantime.
- Comment count + "See all comments" link.
- Composer input (only for authenticated viewers, which is everyone in this app since we're behind the JWT authorizer).
- First page of comments (up to 20 newest).

### 3. Comment thread screen

Loaded when the user taps "See all comments" or a specific `#comment-{id}` deep link.

- Header: story title.
- Comment composer at the top or bottom (match existing chat UX in the app).
- Newest-first list. On scroll to bottom, fetch next page: `GET /comments?before={oldestLoadedId}&limit=20`.
- Each comment:
  - Author name + avatar
  - Body
  - Relative timestamp + `(edited)` if `isEdited`
  - If `isMine` — expose Edit + Delete in a menu
  - If the viewer is the story owner but comment isn't theirs — expose Delete only (moderation)
- Optimistic add: append the comment to the list immediately, replace with server response when the POST returns.

### 4. Push notifications received

When a customer receives a `story_comment` push, the deep link is `/stories/{id}#comment-{commentId}`. The app should:
- Land the user on the story detail screen with that story loaded.
- Scroll to and highlight the referenced comment (fetch further pages if needed to locate it).
- Mark the notification as read in the existing notification-centre backing store (already wired via `notification_events`).

---

## Error handling

| Status | Meaning | UI |
|--------|---------|-----|
| 401 | JWT missing/expired | Existing global handler — re-auth flow |
| 403 | Wrong actor (e.g. non-author trying to PATCH comment) | Toast: "You can only edit your own comments." |
| 404 | Story or comment not found | Toast + navigate back |
| 422 | Validation (e.g. body too long, invalid reaction kind) OR publish rejected (videos not ready) | Show error message from response `error.message`. For publish, show the `pendingVideoAssetIds` and offer auto-retry. |
| 500 | Backend error | Existing global handler — generic retry toast |

---

## Optimistic UI notes

- **Comments create:** append with a temp id, replace on 201.
- **Reactions:** always fire the request but update counts + `myReaction` immediately. Reconcile from response.
- **Comment edit/delete:** update/hide instantly, roll back on error.
- The reactions endpoint responses always carry the full summary so you don't need a separate re-fetch to reconcile.

---

## Limits (backend-enforced)

- Title: 200 chars
- Description: 2000 chars
- Comment body: 1000 chars
- Media per story: 20
- Videos per story: 5
- Photos per story: 20
- Video max duration: 3 min
- Video max size: 100 MB

Enforce the same limits in the frontend as `maxLength` on inputs and pre-upload checks on file size + duration (via `<video>.duration` after metadata loads) so the backend rejection is a fallback, not the first line of defence.

---

## Not in v1 (do not implement)

- Story feed / discovery
- @mentions in comments
- Reactions on comments (👍 a reply)
- Replies-to-comments (threaded)
- Sharing via native share sheet with Open Graph metadata
