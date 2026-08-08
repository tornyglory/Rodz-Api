# Staff Avatar — Photo → Rodz-Style Illustration Brief

Turn any staff member's uploaded photo into a **Rodz-branded illustrated
avatar** on a pure white background. Same recognisable face, translated
into the workshop's brand illustration style. The illustration replaces
the raw photo everywhere staff avatars render — job cards, technician
list, mechanic tick-off attribution, etc.

Uses Google's **Nano Banana** (`gemini-2.5-flash-image-preview`) —
image-to-image editing with a reference-style guide. Not built yet;
this brief is the spec.

---

## Why illustration, not raw photo

- Consistent visual identity — every mechanic looks like part of the same
  team, regardless of the quality of their selfie
- Softens privacy — clients see a stylised likeness, not a raw photo
- Scales cleanly at 24px avatar chips through to 200px profile heros
- Neutral pure-white background composites nicely on every UI surface

---

## The style

Reference image (Cloudflare):

```
https://imagedelivery.net/_T7yYgco6vMbVyuhQfz9eg/7545ea65-f2c8-4ddc-9bda-c577ef5f3600/public
```

Traits Nano Banana should preserve:

- Flat vector illustration, semi-realistic proportions
- Clean dark-navy outlines, moderate line weight
- Soft cel-shaded fills — no harsh gradients
- Muted warm palette: navy uniforms, warm skin tones, coral/orange
  brand accents
- Simplified but expressive faces (small eyes, clear beard/hair
  definition, kept recognisable)
- Rodz-branded navy cap + navy overalls uniform

For the **avatar variant** we're building here: crop to **head +
shoulders**, no workshop background — pure white behind the person.

---

## Schema

One nullable column on `staff`:

```sql
ALTER TABLE staff
  ADD COLUMN avatar_illustration_image_id VARCHAR(255) NULL AFTER avatar_image_id;
```

- `avatar_image_id` — the raw photo the staff member uploaded (existing, unchanged)
- `avatar_illustration_image_id` — the Nano Banana output (new, nullable)

Response payloads that already return `avatarUrl` add a second field:

```jsonc
{
  "avatarUrl":              "https://imagedelivery.net/{hash}/{avatar_image_id}/thumbnail",
  "avatarIllustrationUrl":  "https://imagedelivery.net/{hash}/{avatar_illustration_image_id}/thumbnail"
}
```

Frontend renders `avatarIllustrationUrl` when present, falls back to `avatarUrl` when null (e.g. staff hasn't triggered generation yet).

---

## Endpoint

```
POST /staff/{id}/avatar/illustrate
Authorization: Bearer <staff_jwt>
```

Auth:
- `super_admin` — any staff
- The staff member themselves — their own record only
- Others — 403

Body: none.

### What it does

1. Load the target staff's `avatar_image_id`. If null → **422** `NO_AVATAR` — must upload a photo first.
2. Fetch the raw photo bytes from Cloudflare Images
3. Fetch the style reference image bytes (cached in memory after first call)
4. Call Nano Banana with **both images** + the illustrate prompt (below)
5. Upload the returned illustration bytes to Cloudflare Images
6. Store the new image id on `staff.avatar_illustration_image_id`
7. Return `{ avatarIllustrationImageId, avatarIllustrationUrl }`

### The Nano Banana prompt

Multi-image input — image 1 = staff photo, image 2 = style reference:

```
Convert the person in image 1 into an illustrated portrait matching the
art style in image 2. Preserve their likeness accurately — face shape,
hair, facial hair, skin tone, glasses if any, general age. Dress them
in the same Rodz-branded navy cap and navy overalls as the person in
image 2, with the "RODZ" logo visible on the cap in coral/orange.

Composition: head and shoulders, centred, facing the camera. Isolate on
a pure white background — no workshop scene, no shadow, no props.

Style requirements: flat vector illustration, clean dark-navy outlines
of moderate weight, soft cel-shaded fills with gentle shading, warm
muted palette matching image 2. Simplified but expressive facial
features. No photorealism, no gradients, no drop shadows.
```

### Response

```jsonc
{
  "staffId":                   3,
  "avatarIllustrationImageId": "a4436f83-2011-4e9e-63f4-d8f24b0c8500",
  "avatarIllustrationUrl":     "https://imagedelivery.net/{hash}/a4436f83…/thumbnail",
  "generatedAt":               "2026-08-08T09:15:00.000Z",
  "sourceAvatarImageId":       "b2c7d1f0-…"
}
```

### Errors

| Status | Code | When |
|---|---|---|
| `403` | `FORBIDDEN` | Not your own record + not super_admin |
| `404` | `NOT_FOUND` | Staff id doesn't exist |
| `422` | `NO_AVATAR` | Staff has no `avatar_image_id` yet — upload first |
| `502` | `GENERATION_FAILED` | Nano Banana returned an error or non-image response |
| `500` | `INTERNAL_ERROR` | Any other server error |

### Timing + cost

- Nano Banana call: 3-8s per generation
- Total end-to-end (fetch photo + call + upload result): ~8-12s
- Cost: ~$0.039 per illustration. Negligible at any workshop volume
- Idempotency: not enforced — calling twice regenerates. Frontend can gate with a "regenerate" confirm

---

## Frontend UX

### Where the button lives

On the **staff profile / settings page** — right next to the current avatar image + upload control.

### States

```
┌─────────────────────────────────────────────────────────┐
│  Your avatar                                            │
│                                                         │
│  ┌────────┐     Not uploaded yet                       │
│  │   👤   │     [ Upload a photo → ]                   │
│  └────────┘                                             │
└─────────────────────────────────────────────────────────┘
```

**After upload, before illustration generated:**

```
┌─────────────────────────────────────────────────────────┐
│  Your avatar                                            │
│                                                         │
│  ┌────────┐     Photo uploaded ✓                       │
│  │ [photo]│     [ Replace photo ]                       │
│  └────────┘                                             │
│                                                         │
│  ✨ Generate your Rodz-branded illustration avatar     │
│     Your face, in our style — used across the app.     │
│                                                         │
│                        [ Generate illustration → ]     │
└─────────────────────────────────────────────────────────┘
```

**Generating (spinner state, ~8-12s):**

```
┌─────────────────────────────────────────────────────────┐
│  ┌────────┐     Photo uploaded ✓                       │
│  │ [photo]│                                             │
│  └────────┘                                             │
│                                                         │
│  ⏳ Illustrating your avatar... (~10s)                 │
│                                                         │
│                                        [ Cancel ]      │
└─────────────────────────────────────────────────────────┘
```

**After generation:**

```
┌─────────────────────────────────────────────────────────┐
│  ┌────────┐┌──────────┐                                │
│  │ [photo]││ [illustr]│  Your Rodz avatar ✓            │
│  │ orig.  ││ used app-│  [ Regenerate ] [ Use photo ] │
│  │        ││ wide     │                                │
│  └────────┘└──────────┘                                │
└─────────────────────────────────────────────────────────┘
```

- **[ Regenerate ]** → POSTs the same endpoint again. Warn: "generates a fresh version — your current illustration will be replaced." Show side-by-side preview if you want fancy.
- **[ Use photo ]** → nulls `avatar_illustration_image_id` (via `PATCH /settings/users/{id}` with `{ avatarIllustrationImageId: null }`). Falls back to raw photo everywhere.

### Where avatars render across the app

The illustration replaces the photo on **every existing avatar surface** — no other component changes needed. The pattern is: use `avatarIllustrationUrl` when present, otherwise `avatarUrl`, otherwise the placeholder silhouette.

Surfaces to audit:
- Staff list / technician picker
- Job card "assigned tech" chip
- Booking detail — mechanic assignment
- Notifications ("Howard completed a job")
- Anywhere else `avatarUrl` is currently consumed

### Empty / failure states

- **NO_AVATAR (422)** → don't show the illustrate button, show "Upload a photo first" hint instead
- **GENERATION_FAILED (502)** → toast: "Illustration couldn't be generated. Try again in a moment." Keep the raw photo, don't clear the illustration column
- **Slow (>15s)** → keep spinner, don't timeout the frontend — backend Lambda timeout is 30s

---

## Build order

1. **Migration**: add `staff.avatar_illustration_image_id` column
2. **Backend Lambda**: `POST /staff/{id}/avatar/illustrate` — fetch photo, call Nano Banana with style ref, upload result to Cloudflare, write column
3. **Update shape helpers** — `avatarIllustrationUrl` added to the staff shape wherever `avatarUrl` currently appears (`src/settings/users/_helpers.ts` is one; there'll be a couple of others)
4. **PATCH accept** `avatarIllustrationImageId` on `PATCH /settings/users/{id}` so the "Use photo" toggle can null it
5. **Frontend**: button on the profile page + fallback logic across avatar-rendering components

Backend chunk = ~2-3 hours. Frontend = a small component + one PATCH.

---

## Not addressed here

- **Full-scene / hero illustrations** — the reference image includes a workshop background; that's a different variant we might build later for a "Meet the Team" page. This brief is avatars only, always on white.
- **Batch regenerate for all staff** — currently one-at-a-time via the button. If we ever tweak the style, a super_admin batch endpoint would help — deferred.
- **Style-preview iteration** — no in-app prompt tuning. If the output isn't right, we adjust the prompt in `src/…` and redeploy. Fine for MVP.
- **Customer avatars** — same technique would work but not scoped here. If we build it, it's a separate endpoint on `/c/…`.
