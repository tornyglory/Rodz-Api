# Illustrations — Photo → Rodz Brand Style Brief

Single reusable endpoint that turns any uploaded image into a **Rodz-branded illustration on a pure white background**. Same style, five presets — covers staff avatars, customer avatars, vehicle covers, product shots, and anything else the workshop wants to restyle.

Uses Google's **Nano Banana** (`gemini-2.5-flash-image`) under the hood — image-to-image style transfer with a baked-in brand reference.

Backend deployed 2026-08-08. Endpoint on the admin API.

---

## The style

Baked-in brand style reference (Cloudflare):

```
https://imagedelivery.net/_T7yYgco6vMbVyuhQfz9eg/7545ea65-f2c8-4ddc-9bda-c577ef5f3600/public
```

- Flat vector illustration, semi-realistic proportions
- Clean dark-navy outlines, moderate line weight
- Soft cel-shaded fills — gentle two-tone, no gradients
- Warm muted palette: navy uniforms, warm skin tones, coral/orange accents
- Rodz-branded navy cap + navy overalls where a person is shown
- Everything isolated on pure white (#FFFFFF)

If you want a *different* style for a specific use case (e.g. customer avatars in a friendlier palette), pass a `styleReferenceImageId` in the request — see below.

---

## Endpoint

```
POST /images/illustrate
Authorization: Bearer <staff_jwt>
```

Base URL: `https://lukck5txvh.execute-api.ap-southeast-2.amazonaws.com` (admin API).

Auth: any staff role.

### Request body

```jsonc
{
  "sourceImageId":         "2ae694a8-a7c4-4d68-c3aa-1b26d25e1a00",  // required — Cloudflare image id
  "preset":                "avatar",                                 // optional — see below (default "generic")
  "additionalPrompt":      "wearing glasses, curly hair",            // optional — appended to preset prompt
  "styleReferenceImageId": "…"                                       // optional — override brand style ref
}
```

### Response

```jsonc
{
  "illustrationImageId":   "e6c94ff7-0efb-4c67-d078-0084fb2bbf00",
  "illustrationImageUrls": {
    "thumbnail": "https://imagedelivery.net/{hash}/e6c94ff7…/thumbnail",
    "public":    "https://imagedelivery.net/{hash}/e6c94ff7…/public"
  },
  "preset":                "avatar",
  "sourceImageId":         "2ae694a8-a7c4-4d68-c3aa-1b26d25e1a00",
  "styleReferenceImageId": "7545ea65-f2c8-4ddc-9bda-c577ef5f3600",
  "generatedAt":           "2026-08-08T18:53:22.000Z"
}
```

### Errors

| Status | Code | When |
|---|---|---|
| `403` | `FORBIDDEN` | No staff auth |
| `422` | `VALIDATION_ERROR` | `sourceImageId` missing/empty |
| `502` | `GENERATION_FAILED` | Nano Banana refused (safety, unsupported input, etc.) — error message included |
| `500` | `INTERNAL_ERROR` | Cloudflare fetch/upload failed, or any other server error |

### Timing + cost

- 8-20 seconds per generation (varies by image complexity)
- Lambda timeout is 60s — never hits it in practice
- ~$0.039 per illustration. Negligible at any workshop volume.

---

## Presets

Pick the one that matches your use case. Each has a hand-tuned prompt behind it.

| Preset | Best for | Composition | Uniform / dress code |
|---|---|---|---|
| `avatar` | Staff avatars, customer avatars, mechanic thumbnails | Head + shoulders, three-quarter angle | Rodz overalls + cap (persons only) |
| `portrait` | Staff profile page hero | Three-quarter body, standing pose | Rodz overalls + cap (persons only) |
| `cover` | Store hero images, marketing banners | Landscape crop, wide | Free — matches source |
| `product` | Vehicle covers, parts, tools | Product centred at ~70% frame | n/a |
| `generic` | Default when unsure | Preserves source composition | n/a — just restyles |

All presets isolate on pure white. All match the Rodz brand style unless overridden.

---

## Common workflow (recipe)

Illustration doesn't persist to any specific record automatically. The pattern is:

1. **Get a source image** — either an existing Cloudflare id (staff avatar, customer avatar, vehicle avatar) OR a fresh upload
2. **`POST /images/illustrate`** with the source id + preset
3. **Save the returned `illustrationImageId`** back onto the record via the record's own PATCH endpoint

The endpoint doesn't touch your `staff` / `customers` / `vehicles` rows — the caller decides where the illustration lives.

---

## Use case A — Staff avatar

Schema addition (already spec'd separately):

```sql
ALTER TABLE staff
  ADD COLUMN avatar_illustration_image_id VARCHAR(255) NULL AFTER avatar_image_id;
```

### Flow

1. Staff uploads a photo → `staff.avatar_image_id` filled
2. On profile page, show **"Generate Rodz illustration →"** button
3. Click → `POST /images/illustrate` with `{ sourceImageId: staff.avatar_image_id, preset: 'avatar' }`
4. Wait ~10-15s (spinner)
5. On success → `PATCH /settings/users/{id}` with `{ avatarIllustrationImageId: response.illustrationImageId }`
6. Everywhere avatars render, prefer `avatarIllustrationUrl` when set, else `avatarUrl`

### UI states

```
Not uploaded          → [ Upload photo ]
Uploaded, no illust.  → [ Regenerate photo ]  [ ✨ Generate Rodz illustration → ]
Generating (~10-15s)  → ⏳ Illustrating your avatar...
Illustrated           → [ Regenerate ]  [ Use photo instead ]
```

**"Use photo instead"** → `PATCH /settings/users/{id}` with `avatarIllustrationImageId: null`. Reverts to raw photo everywhere.

---

## Use case B — Customer avatar

Same as staff avatar but on the customer side. Schema addition (if you want it):

```sql
ALTER TABLE customers
  ADD COLUMN avatar_illustration_image_id VARCHAR(255) NULL AFTER avatar_image_id;
```

Same flow, same preset (`avatar`). Consider a *different* `styleReferenceImageId` if you want customer avatars to look softer / less workshop-branded than staff ones.

---

## Use case C — Vehicle avatar / cover

For the customer's own vehicle page or a public logbook hero.

### Flow

1. Customer uploads a vehicle photo → `vehicles.avatar_image_id` filled
2. On the vehicle page, show **"Illustrate this vehicle →"** button
3. Click → `POST /images/illustrate` with `{ sourceImageId: vehicles.avatar_image_id, preset: 'product' }` (product preset works well for vehicles — isolated on white, product-centred)
4. `PATCH /c/vehicles/{id}` with an `avatarIllustrationImageId` field (needs backend column + PATCH support — small follow-up)

### Cover image variant

For a wider landscape hero image of the vehicle in a workshop scene, use `preset: 'cover'`. Note that `cover` doesn't isolate as tightly on white — it produces a landscape scene. Change to `product` if you want a clean listing-thumbnail look.

---

## Use case D — Store cover / marketing image

Manager uploads a raw photo of a store or a hero shot → run through `preset: 'cover'` → get a Rodz-styled landscape illustration for the workshop landing page.

No record to save to specifically — just store the resulting Cloudflare image id somewhere sensible (store settings, marketing config, etc.).

---

## Use case E — Product / part illustration

For future product-catalogue pages, listing hero images. Upload a photo of the part → `preset: 'product'` → get an isolated illustrated product shot on white. Cleaner than raw photos and matches everything else in the app visually.

---

## Rendering fallback pattern (client-side)

Everywhere avatars / covers render, follow this order:

```ts
const displayUrl =
      record.avatarIllustrationUrl                    // illustrated version if present
   ?? record.avatarUrl                                // raw photo fallback
   ?? DEFAULT_PLACEHOLDER                             // silhouette / grey square
```

The illustration replaces the photo everywhere without any other component changes — audit the surfaces that consume `avatarUrl` today:

- Staff list / technician picker
- Job card "assigned tech" chip
- Booking detail — mechanic assignment
- Notifications ("Howard completed a job")
- Customer avatars on their portal + logbook

---

## Suggested UX patterns

### Generate button (single-click generation)

```
┌────────────────────────────────────────────┐
│  ┌────────┐   [uploaded photo]             │
│  │ [photo]│   Photo uploaded ✓             │
│  └────────┘   [ Replace ] [ Delete ]       │
│                                            │
│  ✨ Generate Rodz illustration            │
│  A branded illustrated version of your    │
│  photo — used everywhere in the app.       │
│                                            │
│                       [ Generate → ]      │
└────────────────────────────────────────────┘
```

### Generated state

```
┌────────────────────────────────────────────┐
│  ┌────────┐┌────────┐                     │
│  │ [photo]││ [illus]│  Rodz avatar ✓      │
│  │ orig.  ││ (used) │  Illustration is    │
│  │        ││        │  what people see.   │
│  └────────┘└────────┘                     │
│                                            │
│  [ Regenerate ] [ Use photo instead ]     │
└────────────────────────────────────────────┘
```

### Loading state (10-15s)

Show a spinner + a clear message: *"Illustrating your avatar — this takes ~10 seconds..."*. Do **not** timeout the frontend — backend Lambda can take up to 20s on complex images.

### Failure state

If the endpoint returns `502 GENERATION_FAILED`:
- Toast: *"Illustration couldn't be generated — try again."*
- Show the error message (e.g. safety refusal from Nano Banana)
- Keep the existing photo intact — don't clear anything

---

## Style-override option (advanced)

If a customer-portal designer wants a *lighter* palette than the workshop-branded reference, upload a different style reference image to Cloudflare, then pass its id:

```jsonc
POST /images/illustrate
{
  "sourceImageId":         "…customer photo…",
  "preset":                "avatar",
  "styleReferenceImageId": "…softer palette reference…"
}
```

The prompt stays the same; the style guide swaps. Good for customer-facing UI where you don't want the workshop's uniform to appear.

---

## Not addressed here

- **Batch generation** — no "illustrate all 50 staff at once" endpoint. Frontend can fire multiple in parallel client-side if needed.
- **In-app prompt tuning** — no UI to edit preset prompts. To adjust the style baseline, we tweak `src/illustrations/illustrate.ts` and redeploy.
- **Non-illustration transformations** — the endpoint is scoped to brand-style illustration. Other transformations (background removal, colour correction, upscaling) would be separate endpoints.
- **Automatic-on-upload** — every illustration is manually triggered by a button click today. If we later want "auto-illustrate on avatar upload" behaviour, that's a small chain-call, not built.
