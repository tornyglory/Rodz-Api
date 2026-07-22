# Vehicle Profile — Stories Tab (Frontend brief)

Focused brief for the "Stories" tab on the customer vehicle profile screen. This is the entry point for everything Stories-related in the authenticated app. Full endpoint reference + composer + detail screens are in `docs/customer-stories-frontend-brief.md` — treat that as the reference doc; this brief covers just the tab.

**Backend status:** Sprint 1 + 2 + 3 delivered. Everything below is live.

---

## What this tab is

A chronological feed of the vehicle's stories, owned by the current customer. Two lifecycle states share the same list:

- **Draft** — only visible to the owner. Composer state. Not shareable, not visible on the public logbook.
- **Published** — visible in the authenticated app to the owner (this tab, plus deep links from push notifications). Additionally visible on the public logbook to anyone with the URL when `publicProfileSettings.stories !== false` AND the story's own `isPublic` is true.

Both share the same card design — a small draft pill distinguishes drafts.

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

Only one endpoint powers the list itself:

### `GET /c/vehicles/{vehicleId}/stories`

Returns every non-deleted story on the vehicle owned by the caller — drafts and published, mixed. Ordered newest event date first at the backend, so the frontend can render as-received.

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
      "coverMediaUrl": "https://imagedelivery.net/…/thumbnail",
      "mediaCount":    12,
      "commentCount":  7,
      "reactions": {
        "counts":     { "like": 12, "love": 3, "fire": 8, "wow": 1, "thinking": 2 },
        "myReaction": null
      }
    }
  ]
}
```

- `coverMediaUrl` is the thumbnail URL of the media with the lowest `sort_order` (photo `thumbnail`, video poster). `null` if no media attached.
- `mediaCount` — total non-deleted media count, for the "+11 more" badge on the card.
- `commentCount` and `reactions.counts` — live counts, safe to display.
- Full `media` array and `comments` array are **NOT** returned by this endpoint — fetch them via `GET /c/stories/{id}` when the user opens a specific story.

**Loading strategy:** call once on tab mount. No pagination in v1 — a customer with 200 stories is unlikely. If it becomes a real concern, we'll add `?limit=&before=` keyset pagination (same shape as comments list).

**Cache:** treat as fresh-on-mount. Invalidate + refetch after:
- Creating a new story (composer save/publish returns to this tab)
- Deleting a story
- Publishing a draft
- Editing a story
- Coming back from the detail screen after reactions/comments were added/removed (so counts stay in sync)

---

## Screen layout

```
┌─────────────────────────────────────────────┐
│  ← Vehicle Profile                          │
│                                             │
│  ┌─────┐  ┌────────┐  ┌────────┐  ┌───────┐ │
│  │About│  │Service │  │Modific.│  │Stories│ │  <- tab bar
│  └─────┘  └────────┘  └────────┘  └───────┘ │
│                                             │
│  Stories                     [ + New Story ]│  <- section header
│  ─────────────────────────────────────────  │
│                                             │
│  ┌───────────────────────────────────────┐  │
│  │ [thumbnail]  6-month respray done     │  │  <- story card
│  │              30 Jun 2026 • 🔥 8 · 💬 7 │  │
│  │              +11 more                 │  │
│  └───────────────────────────────────────┘  │
│                                             │
│  ┌───────────────────────────────────────┐  │
│  │ [thumbnail]  New wheels reveal  [Draft]│  │
│  │              12 Jun 2026              │  │
│  └───────────────────────────────────────┘  │
│                                             │
│  ┌───────────────────────────────────────┐  │
│  │ [thumbnail]  Track day at Sandown     │  │
│  │              3 Mar 2026 • ❤️ 3 · 💬 2 │  │
│  └───────────────────────────────────────┘  │
└─────────────────────────────────────────────┘
```

### Header

- Title "Stories" (existing tab-title style).
- Trailing "+ New Story" button — primary style, right-aligned. Tap → composer (see full brief § "Story composer").
- Optional subtitle when the vehicle has stories: "N stories on this vehicle". Skip when empty (redundant with the empty state).

### Story card

One per story. Tap → detail screen (see full brief § "Story detail (published)"). Height ~88px for a comfortable list on mobile.

- **Leading thumbnail** — square 64×64. Use `coverMediaUrl` when present; fallback to a placeholder icon (📸 or 🎬) when null. If the story only has videos and none are `ready` yet, use the placeholder + a small "Processing" spinner overlay.
- **Title line** — bold, `title`, single-line truncated with ellipsis. If `status === 'draft'`, append a small "Draft" pill (grey outline, 10pt) — makes it obvious the owner still needs to publish.
- **Meta line** — smaller, secondary colour:
  - Formatted `eventDate` (e.g. "30 Jun 2026" or "6 months ago" — match the app's existing relative-date style).
  - If `mediaCount > 1`, "+N more" after the date.
  - If published AND (`reactions.counts` total > 0 OR `commentCount > 0`), the highest-count reaction emoji + count, then `💬 <commentCount>`.
  - "(edited)" in parens if `isEdited` is true.

**Long-press / swipe:** exposes Delete + (if draft) Publish. Match existing swipe patterns from Modifications tab.

**Loading state:** skeleton cards (3–4) while the fetch is in-flight.

### Empty state

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

- Centered vertically in the tab.
- Copy: "Document what happens to your car — a paint job, new wheels, a track day. Shows up on your public logbook too."
- CTA identical to the header button.

---

## What tapping a card does

Same as tapping any story anywhere in the app: navigate to the story detail screen (see `docs/customer-stories-frontend-brief.md` § "Story detail (published)" and § "Story composer"). Behaviour differs based on status:

- **Draft** → open composer, prefilled. Composer supports Save / Publish / Delete.
- **Published** → open read-view. Owner sees "Edit" and "Delete" affordances; visitors (from push deep link) see comment/react affordances only.

Both flows are already spec'd in the main brief — this tab just needs to route.

---

## Errors + edge cases

| Scenario | UI |
|----------|-----|
| 200 with empty array | Empty state (above) |
| 401 (JWT expired) | Existing global handler — re-auth |
| 403 (not the owner of this vehicle — shouldn't happen from the profile screen but be defensive) | Toast "You don't have access to this vehicle's stories." + navigate back |
| 500 or network error | Existing global error toast + retry button in-place of the card list |

**Optimistic UX after composer save:**
- On successful `POST /c/vehicles/:id/stories` (from composer): navigate back to this tab, prepend the new story to the list optimistically, then refetch in the background to reconcile counts and cover URL (server-side thumbnail generation runs async for videos).
- On successful publish: update the affected card in-place (status → `published`, drop the Draft pill).

---

## Not on this tab in v1

- Sort/filter controls (all stories, newest event date, that's it)
- Search within stories
- Pinning a story to the top
- Bulk actions (multi-select delete etc.)

If real usage shows a need, we'll add. But we're building for the fifth story someone writes, not the fiftieth.

---

## Cross-references

- **Full endpoint spec + composer + detail screens:** `docs/customer-stories-frontend-brief.md`
- **Data model / schema:** `docs/schema.md` (§ Vehicle stories)
- **Design decisions & sprint history:** `docs/vehicle-stories-plan.md`
