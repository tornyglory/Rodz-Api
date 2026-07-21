# Customer Profile — Extended Fields

Adds a cover photo + three personality fields (dream car, favourite drive, driving-since year) to the customer profile. Extends existing `/c/me` endpoints — one new endpoint for saving the cover image id. **Backend is deployed and smoke-tested.**

---

## Base URL & auth

```
https://fzzrkscwd7.execute-api.ap-southeast-2.amazonaws.com
```

```
Authorization: Bearer <customer_jwt>
```

All endpoints below scope to the authenticated customer — no `{customerId}` in the path.

---

## What's on the profile now

`GET /c/me` response gains these fields (existing fields unchanged):

```jsonc
{
  "id":               3,
  "firstName":        "Neville",
  "lastName":         "Rodda",
  "email":            "…",
  "mobile":           "…",
  "suburb":           "Somerville",
  "state":            "VIC",
  "postcode":         "3912",

  "description":      "Passionate about older Porsches and long drives.",   // ← the "bio" — already existed
  "dateOfBirth":      "1985-04-12",
  "gender":           "male",

  "avatarUrl":        "https://imagedelivery.net/…/public",               // already existed
  "avatarThumbUrl":   "https://imagedelivery.net/…/thumbnail",            // already existed
  "coverUrl":         "https://imagedelivery.net/…/public",   // ← NEW — cover photo (hero image)
  "coverImageId":     "abc-123-def",                          // ← NEW — raw Cloudflare id, useful if you need to render other variants

  "dreamCar":         "993 GT3 Touring",                       // ← NEW
  "favouriteDrive":   "Great Ocean Road, Torquay to Apollo Bay", // ← NEW
  "drivingSinceYear": 2005,                                    // ← NEW — smallint

  "tier":             "gold",
  "isPremium":        true,
  "marketingOptIn":   true,
  "smsOptIn":         true,
  "memberSince":      "2024-01-15",
  "onboardingCompletedAt": "2024-01-16T…",
  "voicePreference":     "female",
  "voiceSpecificName":   null,
  "vehicles":         [ … existing vehicle summary … ]
}
```

All new fields are nullable — empty state is the norm for existing customers.

---

## Updating the text/numeric fields

Existing `PATCH /c/me` accepts the three new keys alongside everything it already accepts:

```jsonc
PATCH /c/me
{
  "dreamCar":         "993 GT3 Touring",
  "favouriteDrive":   "Great Ocean Road",
  "drivingSinceYear": 2005
}
```

**Clearing a field:** send `null` (or empty string).
```jsonc
{ "dreamCar": null }
```

**Validation:**

| Field | Rule |
|---|---|
| `dreamCar` | string, ≤ 100 chars |
| `favouriteDrive` | string, ≤ 200 chars |
| `drivingSinceYear` | integer between `1900` and the current year (server-side clamp — validation returns 422 with the current year in the message) |

Also the existing `description` (bio) accepts up to 2000 chars — unchanged.

**Response:** full `GET /c/me` shape with the new values applied. Cache invalidates automatically.

**Errors:** `422 VALIDATION_ERROR` with a human-readable message.

---

## Uploading the cover photo

Two-step flow — identical to how avatar upload works today. The same `GET /c/me/avatar/upload-url` endpoint hands back a generic Cloudflare direct-upload URL; only the save step is dedicated per field.

### Step 1 — request an upload URL

```
GET /c/me/avatar/upload-url
```

Response:
```jsonc
{
  "uploadUrl": "https://upload.imagedelivery.net/…",
  "imageId":   "abc-123-def"
}
```

Yes, the endpoint is called `avatar/upload-url` but the URL is generic — reuse it for both avatar and cover. If you'd rather have a symmetric name (`/c/me/image-upload-url` etc.) let backend know; the alias is a 5-min add.

### Step 2 — upload directly to Cloudflare

`POST` the image blob to the returned `uploadUrl`. Same as the avatar flow — nothing new.

### Step 3 — save as the cover

```
POST /c/me/cover
Content-Type: application/json

{ "imageId": "abc-123-def" }
```

Backend verifies the id exists in Cloudflare, then persists it to `customers.cover_image_id` and invalidates the profile cache.

**Response 200:**
```jsonc
{ "imageId": "abc-123-def" }
```

**Clearing the cover:**
```jsonc
POST /c/me/cover
{ "imageId": null }
→ 200 { "imageId": null }
```

**Errors:**
- `422 VALIDATION_ERROR` — `imageId is required.` (missing when not null) or `Image not found in Cloudflare.` (Cloudflare doesn't recognise the id).

The follow-up `GET /c/me` will return the new `coverUrl` + `coverImageId`.

---

## UI hints

**Placement:**
- **Cover photo** — full-width hero at the top of the profile page, wide-aspect (roughly 3:1). If `coverUrl` is null, show a subtle default (gradient / muted colour) with a small "Add cover photo" affordance.
- **Avatar** — round or squared portrait, sits over the bottom-left of the cover. Existing pattern.
- **Bio (`description`)** — under the name, wraps to 2-3 lines. Empty state: "Add a bit about yourself" link.
- **The three new fields** — a "Driving profile" card:
  - **Dream car:** `dreamCar`
  - **Favourite drive:** `favouriteDrive`
  - **Driving since:** *N years — since {drivingSinceYear}* (derive years client-side from current year)
  - Empty state: single "Add your driving profile" CTA opens a form for all three at once.

**Editing:**
- One profile-edit modal covers everything — no need for separate flows per field. Existing `PATCH /c/me` handles all text/numeric changes in one call.
- Cover + avatar upload flows are two-step (upload URL → upload → save id). Both use `/c/me/avatar/upload-url` for step 1.

**Bonus (optional):** if `dreamCar` and/or `favouriteDrive` are populated, Rodz's chat can reference them naturally ("Speaking of the Great Ocean Road…"). Backend can wire this into the persona later — no frontend work needed.

---

## Smoke test (already run against production)

1. `GET /c/me` on a fresh customer → new fields all `null`. ✓
2. `PATCH /c/me` with `dreamCar` / `favouriteDrive` / `drivingSinceYear` → 200, values persist. ✓
3. `PATCH /c/me` with `drivingSinceYear: 1800` → `422` with message referencing valid range. ✓
4. `PATCH /c/me` with `dreamCar: null` → clears without touching other fields. ✓
5. `POST /c/me/cover` with bogus imageId → `422 Image not found in Cloudflare.` ✓
6. `POST /c/me/cover` with `imageId: null` → clears cover, returns `{ imageId: null }`. ✓

Not yet tested end-to-end: happy-path upload → save → GET round-trip with a real Cloudflare image id. Should work (same code path as avatar-update which is in daily use); flag anything odd on first integration.
