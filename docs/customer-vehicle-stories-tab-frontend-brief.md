# Vehicle Profile — Stories Tab (Frontend brief)

Focused brief for the "Stories" tab on the customer vehicle profile screen. Full endpoint reference + composer + detail screens are in `docs/customer-stories-frontend-brief.md` — treat that as the reference doc; this brief covers just the tab.

**Backend status:** Sprint 1 + 2 + 3 delivered. Everything below is live.

---

## What this tab is

A **Facebook-style feed** of the vehicle's stories, owned by the current customer. Each story is a full post card — hero media, title, description, media grid, reactions bar, and a preview of the top comments — not a compact list row.

Two lifecycle states share the same feed:

- **Draft** — only visible to the owner. Composer state. Not shareable, not visible on the public logbook.
- **Published** — visible in the authenticated app to the owner (this tab, plus deep links from push notifications). Additionally visible on the public logbook to anyone with the URL when `publicProfileSettings.stories !== false` AND the story's own `isPublic` is true.

Both use the same card design — a small "Draft" pill in the header distinguishes them.

Ordered: newest **event date** first (not publish date, not created date — the user-picked `eventDate` is what matters, so "6 months ago I did X" sorts correctly regardless of when they got around to writing it up).

---

## Base URL & auth

```
https://fzzrkscwd7.execute-api.ap-southeast-2.amazonaws.com
```

```
Authorization: Bearer <customer_jwt>
```

Vehicle ownership is enforced at the endpoint level — cross-owner reads return 403. Frontend does not need a separate check.

---

## Endpoint used by this tab

Only one endpoint powers the feed:

### `GET /c/vehicles/{vehicleId}/stories`

Returns every non-deleted story on the vehicle owned by the caller — drafts and published, mixed. Ordered newest event date first at the backend, so the frontend can render as-received.

Each row is **card-ready** — the endpoint returns the first 4 media items (fully shaped), reaction counts + viewer's own reaction, comment count, and the 2 most recent comments inline. The whole feed renders from this one call.

**Response 200:**
```json
{
  "stories": [
    {
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
          "url":           "https://imagedelivery.net/…/hash/public",
          "thumbnailUrl":  "https://imagedelivery.net/…/hash/thumbnail"
        },
        {
          "id":            124,
          "mediaType":     "video",
          "sortOrder":     1,
          "videoAssetId":  55,
          "processStatus": "ready",
          "url":           "https://…?signed",
          "urlExpiresAt":  "2026-07-05T10:37:14.000Z",
          "thumbnailUrl":  "https://cdn.rodz.com.au/video-thumbnails/55.jpg",
          "durationSeconds": 47.2,
          "width":         1920,
          "height":        1080
        }
        // …up to 4 items
      ],
      "mediaCount": 12,

      "reactions": {
        "counts":     { "like": 12, "love": 3, "fire": 8, "wow": 1, "thinking": 2 },
        "myReaction": null
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
        // …up to 2 items, most recent first
      ]
    }
  ]
}
```

**Key fields:**
- `media` — first 4 media items by `sortOrder`, fully shaped (photo URLs unsigned, video URLs presigned + poster + `processStatus`). Use `media[0]` as the hero; `media[1..3]` fill the grid beneath.
- `mediaCount` — total count. If `mediaCount > media.length`, show "+N more" overlay on the last grid tile.
- `reactions.myReaction` — the current customer's own reaction, or `null`. Owners can react to their own stories (no restriction) — use it to highlight the active chip.
- `comments` — the 2 most recent (newest first). Full list via `GET /c/stories/{id}/comments`.

**Loading strategy:** call once on tab mount. No pagination in v1 — a customer with 200 stories is unlikely. If it becomes a concern, we'll add `?limit=&before=` (same shape as comments list).

**Cache:** treat as fresh-on-mount. Invalidate + refetch after:
- Creating a new story (composer save/publish returns to this tab)
- Deleting a story
- Publishing a draft
- Editing a story
- Coming back from the detail screen (so counts + previews stay in sync)

Interactions that happen **on** a card (react, quick-comment) should update the local card in place — no full refetch required, because the reaction PUT/DELETE and comment POST all return the fresh summary/comment payload.

---

## Screen layout

```
┌─────────────────────────────────────────────┐
│  ← Vehicle Profile                          │
│                                             │
│  About  Service  Modifications  Stories     │  <- tab bar
│  ─────                                      │
│                                             │
│  Stories                     [ + New Story ]│  <- section header
│  ─────────────────────────────────────────  │
│                                             │
│  ╭─────────────────────────────────────────╮│
│  │ 👤 Spencer • 30 Jun 2026 • (edited)    ⋮││  <- post header
│  │                                         ││
│  │ 6-month respray finally done            ││  <- title
│  │ Started stripping in January and now…   ││  <- description
│  │                                         ││
│  │ ┌─────────────────────────────────────┐ ││
│  │ │                                     │ ││
│  │ │           HERO IMAGE / VIDEO        │ ││  <- media[0]
│  │ │                                     │ ││
│  │ └─────────────────────────────────────┘ ││
│  │ ┌────┐ ┌────┐ ┌────┐                    ││
│  │ │ 📷 │ │ 🎥 │ │+8  │                    ││  <- media[1..3] + overflow
│  │ └────┘ └────┘ └────┘                    ││
│  │                                         ││
│  │ 👍 12  ❤️ 3  🔥 8  😲 1  🤔 2          ││  <- reactions bar (tap to toggle)
│  │                                         ││
│  │ ─────────────────────────────────────── ││
│  │ 💬 See all 7 comments                   ││
│  │                                         ││
│  │ [S] S. Chen                             ││
│  │     Colour looks incredible             ││  <- comment preview [0]
│  │                                         ││
│  │ [N] N. Rodda                            ││
│  │     Any tips on the paint prep?         ││  <- comment preview [1]
│  │                                         ││
│  │ [Y] Write a comment…                    ││  <- inline composer
│  ╰─────────────────────────────────────────╯│
│                                             │
│  ╭─────────────────────────────────────────╮│
│  │ 👤 Spencer • 12 Jun 2026 [Draft]       ⋮││
│  │  … next story card …                    ││
│  ╰─────────────────────────────────────────╯│
└─────────────────────────────────────────────┘
```

### Section header

- Title "Stories" (existing tab-title style).
- Trailing "+ New Story" primary button → composer (see full brief § "Story composer").
- No subtitle needed — the feed itself tells the story.

### Post card (the whole thing scrolls as one unit)

#### 1. Post header

- Circular avatar (customer's own avatar — you already have this in local session state).
- Author name (first name; full name in accessible label). On this tab the author is always the current customer, but the header still needs to render for visual consistency with the future public feed.
- Interpunct-separated meta: formatted `eventDate` (match existing "30 Jun 2026" / "6 months ago" convention).
- "(edited)" in parentheses if `isEdited === true`.
- **Draft pill** when `status === 'draft'` — small pill, secondary style, sits after the date.
- Trailing "⋮" overflow menu — reveals Edit / Delete (drafts also: Publish).

#### 2. Body

- Title — bold, ~18pt, up to 2 lines with ellipsis if longer.
- Description — regular weight, `description`. Show first ~3 lines with a "See more" toggle if longer (Facebook-style clamp). `null` = skip.

#### 3. Media grid

Use `media` array from the response. Rendering rules:

| media.length | Layout |
|---|---|
| 0 | Skip the grid entirely (rare — text-only story) |
| 1 | Single full-bleed hero, respecting aspect ratio (limit to 16:9 or 4:3 max height so long portrait doesn't dominate) |
| 2 | Hero on top, one thumbnail below full-width (or two side-by-side depending on aspect) |
| 3 | Hero + two smaller thumbnails in a strip below |
| 4 | Hero + three thumbnails in a strip below |

**When `mediaCount > 4`**, overlay "+N" as a dark tint + centred count on the **last** tile in the strip (Facebook pattern). Tapping that tile navigates to the detail screen with the media carousel focused on the 5th item.

**Video hero:** show `thumbnailUrl` as the poster with a large centred play button overlay. Tap → detail screen (native player, full media carousel). Do not autoplay in the feed — bandwidth, distraction, and mixed video/photo grids need consistent tap semantics.

**Video still processing** (`processStatus !== 'ready'`): render the thumbnail if present, otherwise a media placeholder. Overlay a small "Processing" pill in the corner and disable tap. Refetch the tab in the background every ~10s until all previewed videos are ready.

**Tap any tile** (photo or non-processing video) → detail screen. The detail screen owns the full media carousel with swipe/pinch.

#### 4. Reactions bar

Renders the five emoji chips: 👍 like, ❤️ love, 🔥 fire, 😲 wow, 🤔 thinking.

- Show each chip with its count from `reactions.counts`. Chips with 0 count still render — the whole set is always visible.
- The chip matching `reactions.myReaction` is highlighted (filled background, primary tint).
- Tap a chip:
  - No current reaction → `PUT /c/stories/{id}/reactions { kind }`, optimistically bump count +1 and mark active.
  - Same chip already active → `DELETE /c/stories/{id}/reactions`, decrement -1, unmark.
  - Different chip active → `PUT ... { kind }`, decrement old, increment new, swap active.
- Reconcile from the response payload (endpoint always returns the full summary).

#### 5. Comments section

- Divider above.
- "💬 See all N comments" — tappable, opens the detail screen with the comment thread expanded. Hide entirely when `commentCount === 0` (still show the composer below).
- Render the up-to-2 `comments` entries below, oldest of the two first (or newest first — match Facebook: **newest first**, already the case). Each comment row:
  - Small avatar (from `author.avatarUrl` or initial-badge fallback)
  - Author name (bold)
  - Body
  - "(edited)" if `isEdited`
  - If `isMine` — expose Edit / Delete via long-press or a subtle "⋮"
  - If NOT `isMine` but the current user is the story owner — expose Delete only (moderation)
- **Inline composer** at the bottom:
  - Avatar (viewer's) + placeholder "Write a comment…"
  - Tapping expands into a multi-line input with Send button.
  - Submit → `POST /c/stories/{id}/comments { body }`. On 201, prepend to the comments list optimistically (matches "newest first" ordering) and bump `commentCount`. If it pushes total > 2, the oldest previewed comment drops off — that's fine, feed still reads correctly.
  - 422 → surface the error message inline under the composer.

### Empty feed state

When `stories` is an empty array:

```
┌─────────────────────────────────────────────┐
│                                             │
│         🚗                                  │
│                                             │
│   No stories yet                            │
│                                             │
│   Document what happens to your car —       │
│   a paint job, new wheels, a track day.     │
│   Shows up on your public logbook too.      │
│                                             │
│   [  + Write your first story  ]            │
│                                             │
└─────────────────────────────────────────────┘
```

- Centered vertically.
- CTA identical to the section-header button.

### Loading state

Skeleton cards (3 of them, matching the general card layout) while the fetch is in flight.

---

## What tapping does (routing)

- **Post header (title / body / hero)** → story detail screen (see main brief).
- **Any media tile** → story detail with the media carousel focused on that item.
- **"See all N comments"** → story detail with the comment thread scrolled into view.
- **Overflow "⋮"** → context menu: Edit (opens composer) / Publish (drafts only) / Delete.

**Draft cards** open the composer directly instead of a read-view. The composer supports Save / Publish / Delete.

---

## Errors + edge cases

| Scenario | UI |
|----------|-----|
| 200 with empty array | Empty state |
| 401 (JWT expired) | Existing global handler — re-auth |
| 403 (not the owner of this vehicle — defensive) | Toast "You don't have access to this vehicle's stories." + navigate back |
| 500 or network error | Existing global error toast + retry button in-place of the feed |

**Optimistic UX flows:**
- Composer save → prepend new card to the feed; refetch in background to reconcile media processing state + counts.
- Publish (from card overflow) → update the card in-place, drop Draft pill.
- Delete (from card overflow) → remove card immediately, tolerate the delete request in background.
- React on card → update the reactions bar in-place from the API response.
- Comment on card → prepend to the card's inline comments list, bump `commentCount`.

---

## Not on this tab in v1

- Sort / filter controls
- Search across stories
- Pinning a story to the top
- Bulk actions (multi-select delete etc.)

If real usage shows a need, we'll add. But we're building for the fifth story someone writes, not the fiftieth.

---

## Cross-references

- **Full endpoint spec + composer + detail screens:** `docs/customer-stories-frontend-brief.md`
- **Data model / schema:** `docs/schema.md` (§ Vehicle stories)
- **Design decisions & sprint history:** `docs/vehicle-stories-plan.md`
