# Public Logbook — Stories (Frontend brief)

Focused brief for adding the Stories surface to the **magic-link customer app** — the public logbook viewer someone lands on when they open a shared link like `http://localhost:5177/logbook/{token}/profile`.

Companion doc to `docs/customer-stories-frontend-brief.md` (authenticated app) and `docs/customer-vehicle-stories-tab-frontend-brief.md` (owner's Stories tab on the vehicle profile). This one covers **only** the read-only, magic-link-authed public surface.

**Backend status:** Sprint 3 delivered. Both endpoints below are live and verified against prod (25/25 smoke checks passed in `scripts/smoke-stories-sprint3.mjs`).

---

## What this surface is

Someone shares a Rodz logbook link — on Facebook Marketplace, a car forum, in a DM to a mate, via a QR code at a car meet. The recipient clicks, opens the customer app in magic-link mode (no Rodz account required), and sees the vehicle profile plus its story feed. Stories is the storytelling / trust-signal surface — a paint job, new wheels, track day, respray. Watermarked videos + photos + owner's caption + reactions/comments happen back on the owner's authenticated app; the public viewer sees the finished product.

**In v1: read-only.** Anonymous viewers can browse stories, see reaction counts, see the top 2 comments, and watch videos (already watermarked). They **cannot** post reactions or comments. That's a signup CTA moment — see § Sign-in CTAs below.

---

## Auth model

**No JWT.** The magic-link token in the URL path (`/logbook/{token}/...`) is the whole auth story — anyone with the link can read. Do NOT send `Authorization: Bearer …`; the endpoints treat authenticated calls the same as anonymous ones on this surface.

Base URL: `https://fzzrkscwd7.execute-api.ap-southeast-2.amazonaws.com`

Existing sibling endpoints on the same magic-link surface (already used by the app): `/logbook/{token}/vehicle`, `/logbook/{token}/profile`, `/logbook/{token}/modifications`, `/logbook/{token}/chat`. Stories fits alongside those.

---

## The two endpoints

### `GET /logbook/{token}/stories`

Lists every published + public story on the vehicle. Newest event date first.

**Response 200:**

```json
{
  "stories": [
    {
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
        "avatarUrl":  "https://imagedelivery.net/…/hash/public"
      },

      "media": [
        {
          "id":            123,
          "mediaType":     "image",
          "sortOrder":     0,
          "url":           "https://imagedelivery.net/…/hash/public",
          "thumbnailUrl":  "https://imagedelivery.net/…/hash/thumbnail"
        }
        // …full media array for the story
      ],

      "reactions": {
        "counts": { "like": 12, "love": 3, "laugh": 5, "fire": 8, "wow": 1, "thinking": 2 }
      },

      "commentCount": 7
    }
  ]
}
```

**Note:** the list endpoint returns the **full** `media` array (not just the first 4 like the authenticated Stories-tab endpoint). No paged detail fetch is required for the public feed — every story is completely renderable from the list response.

### `GET /logbook/{token}/stories/{id}`

Full detail for one story — media + reactions counts + first page of comments.

**Response 200:**

```json
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
      "avatarUrl":  "https://imagedelivery.net/…/hash/public"
    },

    "media": [ /* full array — photos + videos in sort order */ ],

    "reactions": {
      "counts": { "like": 12, "love": 3, "laugh": 5, "fire": 8, "wow": 1, "thinking": 2 }
    },

    "commentCount": 7,
    "comments": [
      {
        "id":         501,
        "body":       "Colour looks incredible",
        "author":     { "name": "N. Rodda", "avatarUrl": "…" },
        "createdAt":  "2026-07-05T11:15:22.000Z",
        "updatedAt":  "2026-07-05T11:15:22.000Z",
        "isEdited":   false
      }
      // up to 20 most recent, newest first
    ]
  }
}
```

**404 cases:**
- Token doesn't match any vehicle
- Story doesn't exist, is a draft, is deleted, or has `is_public = 0`
- Cross-vehicle guessing guard: story exists but belongs to a different vehicle than the token (nobody can rotate tokens to enumerate story IDs)

**410 case:** vehicle has been deactivated (`vehicles.is_active = 0`).

---

## Shape differences vs. the authenticated app

For anyone porting UI from the authenticated stories brief, these three fields are **omitted** on the public surface (no viewer identity):

| Field | Authenticated (`/c/stories/:id`) | Public (`/logbook/…/stories/:id`) |
|-------|----------------------------------|------------------------------------|
| `customerId` on the story | present | **omitted** |
| `reactions.myReaction` | `'fire' \| null` | **omitted** |
| `comments[].isMine` | `boolean` | **omitted** |

And this field is **added** to the public surface only (viewer needs to know whose story it is):

| Field | Value |
|-------|-------|
| `author: { name, avatarUrl }` | e.g. `{ "name": "S. Rodda", "avatarUrl": "https://…" }`. Name is first-initial + last name. `avatarUrl` is `null` if the owner hasn't set an avatar. |

---

## Visibility gates (backend-enforced — you don't need to check)

A story only appears publicly when **all three** of these are true:

1. `publicProfileSettings.stories !== false` on the vehicle (defaults to `true` if the owner hasn't touched the setting).
2. `stories.is_public = 1` on the row (per-story toggle set by the owner in the composer).
3. `stories.status = 'published'` (drafts never show publicly).

If any of the three is false, the story is filtered from the list endpoint and returns 404 from the detail endpoint. The frontend does not need to filter.

**Downstream implication:** if the owner turns off `publicProfileSettings.stories`, the **entire section** disappears from this feed — the list endpoint returns `{ stories: [] }`. Hide the Stories tab (or show an empty state) when that happens.

---

## Screen recommendations

### Placement

Add a **Stories** tab / section alongside the existing public-logbook surfaces:

- About / Profile
- Service history
- Modifications
- **Stories** ← new

If the vehicle has zero published+public stories, hide the tab. The empty-array-from-list case is easy to detect and there's no meaningful UX for "no stories yet" on a public profile — just don't advertise the section.

### Feed layout

Same Facebook-style feed post design as the owner's Stories tab (`docs/customer-vehicle-stories-tab-frontend-brief.md`), with a few simplifications:

**Post card:**
1. **Header** — author avatar + name + event date + "(edited)" if applicable. No "Draft" pill (drafts never appear here). No "⋮" overflow menu (no read-only actions to expose).
2. **Body** — title + description (first ~3 lines with "See more" toggle).
3. **Media grid** — same Facebook-style rules for 1 / 2 / 3 / 4+ items. Same "+N more" overlay on the 4th tile when `mediaCount > 4`. But since the public list endpoint returns the **full** media array (not just 4), the grid can show the actual overflow rather than needing a follow-up fetch.
4. **Reactions bar** — five emoji chips with counts. **Read-only** — tapping opens the sign-in CTA (see below).
5. **Comments section** — divider, "See all N comments" link (opens the detail screen), then the top 2 comments inline. **No composer** — an inline "Sign in with Rodz to comment" CTA replaces it.

**Detail screen** (opened from a card tap or a `#comment-{id}` deep link):
- Same layout, but the media carousel supports swipe/pinch across the full media set.
- Full comment thread on that page (paginate via `GET /c/stories/{id}/comments` if you want more than 20 — although that endpoint is JWT-gated, so anonymous viewers get exactly what's in the initial payload).

---

## Sign-in CTAs

Anonymous viewers can't react or comment. Any tap that would trigger a mutation should route to sign-in / sign-up:

- Tapping any reaction chip → modal or route to "Sign in to react to this story"
- Tapping the comment composer field → same
- Tapping "See all N comments" → detail screen loads fine (still read-only), but the composer input at the bottom is the same CTA

The exact copy is a design call — my suggestion:

> **Sign in with Rodz to join the conversation**
>
> Reactions and comments are open to Rodz customers. Sign up to say something.
>
> [ Sign in ]   [ Create an account ]

Keep the CTA visually distinct from a hard block — the goal is to convert casual viewers into signups, not shut them out. The rest of the story is still fully browsable.

---

## Video playback

Videos are stored in Cloudflare R2 under `story-clips/{storyId}/…`. The public logbook uses **unsigned** URLs served via `cdn.rodz.com.au` (Cloudflare's free egress), so playback is a plain HTML5 `<video src="…">` with no signature-expiry logic to worry about.

Every video also has the Rodz watermark baked in at post-process time (bottom-right, ~10% frame width, ~35% opacity). Screenshots or downloads carry the brand automatically.

`media[].url` for a video is directly usable in a `<video>` tag. `media[].thumbnailUrl` is the poster.

---

## Loading + error map

| Scenario | UI |
|----------|-----|
| 200 with empty array | Hide the tab entirely (no "no stories yet" state on public surface) |
| 200 with stories | Render the feed |
| 404 on list | Token invalid — should never happen if the token is coming from the URL, but treat as "no stories" defensively |
| 404 on detail | Story doesn't exist / not public / wrong token — show a "This story isn't available" screen with a link back to the vehicle profile |
| 410 on list | Vehicle deactivated — parent app already handles this on `GET /logbook/{token}/vehicle`; propagate the same behavior |
| Network / 500 | Existing global error toast + retry |

**Loading:** call `GET /logbook/{token}/stories` once when the Stories tab mounts. No pagination, no refetch needed (public content doesn't change while the user is scrolling — the owner is on a different device).

---

## Not on this surface in v1

- Reactions from anonymous viewers
- Comments from anonymous viewers
- Sharing (native share sheet with Open Graph metadata — separate work item)
- "Related stories" from other vehicles
- Any composer / edit affordance (owners edit from the authenticated app)

---

## Cross-references

- **Authenticated Stories tab (owner view):** `docs/customer-vehicle-stories-tab-frontend-brief.md`
- **Full stories endpoint reference + composer + detail:** `docs/customer-stories-frontend-brief.md`
- **Backend design & sprint history:** `docs/vehicle-stories-plan.md`
- **Data model / schema:** `docs/schema.md` (§ Vehicle stories)
