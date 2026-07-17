# Staff Vehicle Profile — Workshop Frontend Brief

Rebuild the **Details** tab inside the workshop `CustomerProfileDrawer` so it matches the customer portal's vehicle profile page (`/account/vehicles/:id/profile`) exactly. Same sections, same order, same components — just wired to the staff API. Staff (managers + owners) can enrich the record on the customer's behalf; technicians see everything read-only.

**Sections the Details tab must include** (see the customer portal for the reference layout):

1. About this vehicle (description + AI enhance)
2. Photos (gallery thumbnail strip)
3. Four quick-stat panels — Year · Kilometres · Transmission · Fuel type
4. Vehicle Details (AI-generated make/model knowledge — engine oil, coolant, brake fluid, tyres, known issues)
5. Registration
6. Vehicle Specs
7. Odometer & Service
8. For-sale listing
9. Public visibility toggles
10. Avatar edit affordance

Every section reuses the existing customer-portal component with staff API callbacks — no fresh Vue components.

This supersedes the read-only sections of `workshop-vehicle-drawer-brief.md`. Gallery lives in `staff-vehicle-gallery.md` — no change here.

---

## Base URL

```
https://fzzrkscwd7.execute-api.ap-southeast-2.amazonaws.com
```

All requests:

```
Authorization: Bearer <staff_jwt>
```

---

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET`   | `/customers/{customerId}/vehicles/{vehicleId}` | any staff | Full vehicle read — everything the drawer renders in one call |
| `GET`   | `/customers/{customerId}/vehicles/{vehicleId}/profile` | any staff | AI-generated make/model knowledge (engine oil, coolant, brake fluid, tyres, common issues) — populates the "Vehicle Details" panel |
| `PATCH` | `/customers/{customerId}/vehicles/{vehicleId}` | manager/owner | Update spec **and** profile fields — see Writable fields table |
| `GET`   | `/customers/{customerId}/vehicles/{vehicleId}/upload-url?target=avatar\|cover` | manager/owner | One-time Cloudflare direct-upload URL |
| `POST`  | `/customers/{customerId}/vehicles/{vehicleId}/description/enhance` | manager/owner | AI polish / generate a description draft — **does not persist** |

`GET` is available to all authenticated staff (including technicians). All write endpoints reject `role = 'technician'` with `403 FORBIDDEN`.

Guard errors:
- `403 FORBIDDEN` — technician attempted a write
- `404 NOT_FOUND` — vehicle doesn't exist or doesn't belong to this customer
- `410 GONE` — vehicle was soft-deleted (`is_active = 0`)

---

## `GET /customers/{customerId}/vehicles/{vehicleId}`

Call on drawer open. Everything the Details tab renders comes back in one payload.

### Response — 200

```json
{
  "vehicle": {
    "id":                   4,
    "rego":                 "HUT665",
    "regoState":            "VIC",
    "regoExpiry":           null,
    "vin":                  null,
    "make":                 "Toyota",
    "model":                "Corolla",
    "series":               "ZR",
    "year":                 2021,
    "colour":               "Silver",
    "bodyType":             "hatch",
    "fuelType":             "petrol",
    "transmission":         "automatic",
    "driveType":            "fwd",
    "engineCode":           "M15A",
    "engineSizeCC":         1500,
    "cylinders":            4,
    "tyreSizeFront":        "205/55R16",
    "tyreSizeRear":         "205/55R16",
    "spareTyreSize":        "205/55R16",
    "odometerUnit":         "km",
    "odometerCurrent":      52800,
    "odometerAtPurchase":   null,
    "serviceIntervalKm":    10000,
    "serviceIntervalMonths": 6,
    "nextServiceDueKm":     null,
    "nextServiceDueDate":   null,
    "fleetUnitNumber":      null,
    "internalNotes":        null,

    "description":          "Bought new in 2021, dealer-serviced up to 30k…",

    "avatarImageId":        "a4436f83-2011-4e9e-63f4-d8f24b0c8500",
    "coverImageId":         "4f21111a-a7fb-4d0c-533b-7f6da09e7b00",
    "avatarUrl":            "https://imagedelivery.net/{hash}/{avatar_image_id}/thumbnail",
    "coverUrl":             "https://imagedelivery.net/{hash}/{cover_image_id}/public",

    "logbookToken":         "2514...9426",

    "forSale":              true,
    "askingPrice":          26000,
    "city":                 "Melbourne",
    "country":              "Australia",

    "publicProfileSettings": {
      "history":     true,
      "photos":      true,
      "chat":        true,
      "maintenance": true
    },

    "ownerDescription":     "Enthusiast, keeps records meticulous.",

    "gallery": [
      {
        "id":           12,
        "url":          "https://imagedelivery.net/{hash}/{image_id}/public",
        "thumbnailUrl": "https://imagedelivery.net/{hash}/{image_id}/thumbnail",
        "sortOrder":    0
      }
    ]
  }
}
```

### New fields (vs. what the drawer had before)

| Field | Notes |
|-------|-------|
| `description` | Free-text vehicle description written by the owner or by staff on their behalf. `null` when unset. Max 2000 chars. |
| `ownerDescription` | Read-only mirror of `customers.description` for the vehicle's current owner. Read here for convenience; staff edit it via the existing `PATCH /customers/{id}` endpoint. |
| `publicProfileSettings.maintenance` | New key on the visibility settings object. Existing keys unchanged. |
| `logbookToken` | Now **lazily issued** — the GET returns a token even for vehicles that never had one. Safe to build the share link straight from the response without a separate call. |

Everything else in the payload is unchanged from the current drawer behaviour — including the URLs, gallery shape, and defaults.

---

## `GET /customers/{customerId}/vehicles/{vehicleId}/profile`

AI-generated knowledge base for the vehicle's make/model/year — the same data the customer portal renders in its "Vehicle Details" panel (engine oil spec, coolant, brake fluid, tyre pressures, spark plugs, known issues, common repairs).

Fires the profile-generation Lambda in the background if no cached row exists yet.

### Response — 200 (cached, ready)

```json
{
  "status":       "ready",
  "make":         "Toyota",
  "model":        "Corolla",
  "year":         2026,
  "generatedAt":  "2026-06-14T04:22:11.000Z",
  "overview":     "The 2026 Toyota Corolla petrol automatic is a highly reliable and popular small car, continuing Toyota's reputation for trouble-free motoring…",
  "engineSpecs": {
    "oil":          "0W-16 full synthetic · 4.2 L",
    "coolant":      "Toyota SLLC (pink/red) — do not mix with green",
    "brakeFluid":   "DOT 3",
    "transmission": "Toyota CVT Fluid FE (sealed, no dipstick)",
    "timing":       "Chain — no scheduled replacement",
    "sparkPlugs":   "Denso FK16R-A8 Iridium · replace at 100,000 km"
  },
  "tyreSpecs": {
    "front":  { "size": "205/55R16", "pressure": "240 kPa / 35 psi" },
    "rear":   { "size": "205/55R16", "pressure": "240 kPa / 35 psi" },
    "spare":  { "size": "space saver", "pressure": null }
  },
  "serviceNotes":  "Follow the 10,000 km / 12-month interval…",
  "knownIssues":   [{ "title": "…", "description": "…", "severity": "low" }],
  "commonRepairs": [{ "title": "…", "description": "…" }]
}
```

### Response — 202 (generating)

```json
{ "status": "generating" }
```

Returned the first time this make/model/year is requested. The Lambda regenerates in the background — poll every 3–5 seconds (max 6 attempts) or just hide the panel with a loading state and let the user reopen the drawer later.

### Field notes

| Field | Notes |
|-------|-------|
| `overview` | Free-text paragraph. Show above the engine/tyre grid. |
| `engineSpecs.*` | Each is a display-ready string. Show `—` if the key is missing. |
| `tyreSpecs.{front,rear,spare}` | Show `size` on the first line, `pressure` beneath. `spare` may be `"space saver"` or `null` on cars without one. |
| `knownIssues[].severity` | `low` / `medium` / `high` — colour the badge accordingly. |
| `generatedAt` | ISO datetime the row was last regenerated. Useful to show as "Updated 3 days ago" for staff trust. |

### Errors

| Status | Code | When |
|--------|------|------|
| `404` | `NOT_FOUND` | Vehicle doesn't exist |
| `202` | — | Generation in progress (not an error, informational) |

---

## `PATCH /customers/{customerId}/vehicles/{vehicleId}`

The single write endpoint for the whole Details tab. Spec fields (year/make/model/rego/tyres/odo/…) and profile fields (description/for-sale/avatar/cover/visibility) all go through this one call.

**Guard:** rejects `technician` with `403 FORBIDDEN`.

Send only the keys you want to change — everything is optional. Pass `null` on a scalar field to clear it. `publicProfileSettings` merges — omit keys you don't want to touch.

### Writable fields (new — Details tab specific)

| Field | Type | Rules |
|-------|------|-------|
| `description` | string \| null | Trim server-side. Max 2000 chars. Empty string or `null` clears. |
| `forSale` | boolean | — |
| `askingPrice` | integer \| null | AUD, whole dollars. `null` clears. Negative → `422`. |
| `city` | string \| null | Max 120 chars. |
| `country` | string \| null | Max 120 chars. |
| `publicProfileSettings` | `Partial<{ history, photos, chat, maintenance }>` | Merged into existing settings. Unknown keys → `422`. |
| `avatarImageId` | string \| null | Cloudflare image UUID from the upload flow below. `null` clears. Previous image is deleted server-side. |
| `coverImageId` | string \| null | Same rules as `avatarImageId`. |

Existing spec fields (`rego`, `regoState`, `regoExpiry`, `vin`, `make`, `model`, `series`, `year`, `colour`, `bodyType`, `fuelType`, `transmission`, `driveType`, `engineCode`, `engineSizeCC`, `cylinders`, `tyreSizeFront`, `tyreSizeRear`, `spareTyreSize`, `odometerUnit`, `odometerCurrent`, `odometerAtPurchase`, `serviceIntervalKm`, `serviceIntervalMonths`, `nextServiceDueKm`, `nextServiceDueDate`, `fleetUnitNumber`, `internalNotes`) continue to work exactly as they did — no changes to their validation or behaviour.

### Request example

```json
{
  "description":           "Bought new in 2021, dealer-serviced up to 30k…",
  "forSale":               true,
  "askingPrice":           26000,
  "city":                  "Melbourne",
  "country":               "Australia",
  "publicProfileSettings": { "chat": false },
  "avatarImageId":         "a1b2c3d4-e5f6-...",
  "coverImageId":          "e5f6a7b8-c9d0-..."
}
```

### Response — 200

Returns the **same full `{ vehicle: {...} }` payload as `GET`**. Drop it straight into state — no need to refetch.

### Errors

| Status | Code | When |
|--------|------|------|
| `403` | `FORBIDDEN` | Role is technician |
| `404` | `NOT_FOUND` | Vehicle doesn't exist / doesn't belong to this customer |
| `410` | `GONE` | Vehicle soft-deleted |
| `422` | `VALIDATION_ERROR` | Field-level violation (see rules table). Message is human-readable — safe to surface to staff. |

---

## Avatar / cover upload

Single endpoint pair — `GET /upload-url?target=…` + `PATCH` — used for both avatar and cover. Under the hood the `PATCH` is the same one above; the `imageId` you get back from Cloudflare goes into `avatarImageId` or `coverImageId`.

### Step 1 — Get a Cloudflare upload URL

```
GET /customers/{customerId}/vehicles/{vehicleId}/upload-url?target=avatar
GET /customers/{customerId}/vehicles/{vehicleId}/upload-url?target=cover
```

`target` is required and must be `avatar` or `cover`.

**Response — 200**
```json
{
  "uploadUrl": "https://upload.imagedelivery.net/...",
  "imageId":   "a1b2c3d4-e5f6-..."
}
```

**Errors**

| Status | Code | When |
|--------|------|------|
| `403` | `FORBIDDEN` | Technician |
| `404` | `NOT_FOUND` | Vehicle missing |
| `410` | `GONE` | Vehicle soft-deleted |
| `422` | `VALIDATION_ERROR` | `target` missing or invalid |
| `502` | `CLOUDFLARE_ERROR` | Cloudflare direct-upload API failed — safe to retry |

### Step 2 — Upload to Cloudflare

`POST <uploadUrl>` with `multipart/form-data`, field name `file`. Direct to Cloudflare — no auth header, no staff JWT.

```ts
const fd = new FormData()
fd.append('file', imageFile)
await fetch(uploadUrl, { method: 'POST', body: fd })
```

### Step 3 — Save the image ID via `PATCH`

Send just the image ID field — no separate confirm endpoint. The server verifies the image exists on Cloudflare, writes it to the vehicle row, and fires a background delete of the previously-set image.

```
PATCH /customers/{customerId}/vehicles/{vehicleId}
```

```json
{ "avatarImageId": "a1b2c3d4-e5f6-..." }
```

or

```json
{ "coverImageId": "e5f6a7b8-c9d0-..." }
```

**Response — 200** — full vehicle payload with the new `avatarUrl` / `coverUrl` already assembled. Use those URLs directly; no need to build them yourself.

**Errors:** all standard `PATCH` errors (see above). `422 VALIDATION_ERROR` if the `imageId` isn't found on Cloudflare (usually means Step 2 didn't complete).

### To clear an image

`PATCH` with `avatarImageId: null` or `coverImageId: null`. The response will have `avatarUrl` / `coverUrl` = `null`. The previous Cloudflare image is deleted server-side.

---

## AI description enhance

`POST /customers/{customerId}/vehicles/{vehicleId}/description/enhance`

Polishes an existing draft or writes one from scratch. **Does not persist** — the frontend follows up with a `PATCH` if the user picks "Use this."

**Guard:** rejects `technician` with `403 FORBIDDEN`.

### Request

```json
{ "description": "Just got a new corolla" }
```

- **< 20 characters** (after trim) → **generate mode**. Writes a fresh 2–3 sentence description from the vehicle's specs plus the owner's `ownerDescription` (bio) if present.
- **≥ 20 characters** → **polish mode**. Cleans up the draft — grammar, tone, tightening — without inventing facts.

### Response — 200

```json
{
  "enhanced": "A 2021 Toyota Corolla ZR in silver, kept in near-new condition and dealer-serviced since new.",
  "mode":     "polish"
}
```

### Errors

| Status | Code | When |
|--------|------|------|
| `403` | `FORBIDDEN` | Technician |
| `404` | `NOT_FOUND` | Vehicle missing |
| `410` | `GONE` | Vehicle soft-deleted |
| `422` | `VALIDATION_ERROR` | Draft over 2000 chars |
| `429` | `RATE_LIMITED` | 20/hour per vehicle, 60/hour per staff. `Retry-After` header on the response. |
| `503` | `AI_UNAVAILABLE` | LLM provider down — safe to retry after a beat |

### UX

Two buttons in the description editor: **Enhance** (staff has typed something) or **Generate** (draft is empty). Behind the scenes it's the same endpoint — the server picks the mode.

Show the returned `enhanced` text in a side-by-side or confirm dialog:

- **Use this** → replace the draft with `enhanced`, hit `PATCH … { description: enhanced }` to persist.
- **Try again** → call the endpoint again with the current draft.
- **Cancel** → keep the original draft.

Don't `PATCH` automatically after enhance — always give the user the choice.

---

## Frontend integration

### API client

Add to `src/api/vehicles.ts` (or wherever the workshop-side vehicles client lives):

```ts
export const vehiclesApi = {
  // Existing — signature widens to accept new fields.
  getById: (customerId, vehicleId) =>
    api.get(`/customers/${customerId}/vehicles/${vehicleId}`),

  update: (customerId, vehicleId, body) =>
    api.patch(`/customers/${customerId}/vehicles/${vehicleId}`, body),

  // Existing — AI make/model knowledge. Returns 202 { status: 'generating' }
  // the first time; retry after ~5s or show loading state and move on.
  getModelProfile: (customerId, vehicleId) =>
    api.get(`/customers/${customerId}/vehicles/${vehicleId}/profile`),

  // New — unified upload URL for avatar or cover.
  vehicleUploadUrl: (customerId, vehicleId, target: 'avatar' | 'cover') =>
    api.get(`/customers/${customerId}/vehicles/${vehicleId}/upload-url`, {
      params: { target },
    }),

  // New — AI polish / generate. Does not persist.
  enhanceDescription: (customerId, vehicleId, description: string) =>
    api.post(`/customers/${customerId}/vehicles/${vehicleId}/description/enhance`, {
      description,
    }),
}
```

No separate `confirmAvatar` / `confirmCover` — the upload confirm is just a `PATCH … { avatarImageId }` or `{ coverImageId }` via the existing `update()` method.

### Types

Extend the workshop vehicle type to include everything the extended GET now returns:

```ts
export interface PublicProfileSettings {
  history:     boolean
  photos:      boolean
  chat:        boolean
  maintenance: boolean
}

export interface GalleryImage {
  id:           number
  url:          string
  thumbnailUrl: string
  sortOrder:    number
}

export interface WorkshopVehicle {
  // ... all existing spec fields

  description:           string | null
  avatarImageId:         string | null
  coverImageId:          string | null
  avatarUrl:             string | null
  coverUrl:              string | null
  logbookToken:          string | null
  forSale:               boolean
  askingPrice:           number | null
  city:                  string | null
  country:               string | null
  publicProfileSettings: PublicProfileSettings
  ownerDescription:      string | null
  gallery:               GalleryImage[]
}
```

### Drawer wiring — `CustomerProfileDrawer.vue § vehicleTab === 'details'`

Replace the current spec-only grid with **exact customer-parity**. Match `src/components/ui/VehicleProfileTab.vue` from the customer portal, minus the cover hero (the drawer already has that on its card header).

Two API calls on drawer open, in parallel:

```ts
const [{ vehicle }, modelProfile] = await Promise.all([
  vehiclesApi.getById(customerId, vehicleId),
  vehiclesApi.getModelProfile(customerId, vehicleId),
])
// modelProfile.status === 'generating' → show a loading state on the
// Vehicle Details panel only; the rest of the tab renders immediately.
```

Section order in the Details tab (top to bottom, mirrors the customer profile screens):

1. **About this vehicle** — reuse `AboutDescriptionCard.vue` from the customer portal.
   - Load: `vehicle.description`.
   - Save: `vehiclesApi.update(customerId, vehicleId, { description })`.
   - Enhance: `vehiclesApi.enhanceDescription(customerId, vehicleId, draft)` → confirm dialog → `update()` if accepted.
   - Empty-state copy: **"No description yet. Add one to store more context — or let AI draft one for you."** with **Add** and **Generate** buttons.

2. **Photos** — horizontal thumbnail strip from `vehicle.gallery` with "View all *N*" link. See `staff-vehicle-gallery.md` for add/remove.

3. **Quick-stat panels** — four cards in a 2×2 (mobile) or 1×4 (desktop) grid. Icon + big value + small label. All pulled from the vehicle payload — no separate call:

   | Panel | Value | Label | Icon suggestion |
   |-------|-------|-------|-----------------|
   | Year | `vehicle.year` | `YEAR` | calendar |
   | Odometer | `vehicle.odometerCurrent.toLocaleString()` + " km" (or "mi" if `odometerUnit === 'mi'`) | `KILOMETRES` / `MILES` | speedometer |
   | Transmission | Capitalised `vehicle.transmission` (e.g. `Automatic`) | `TRANSMISSION` | gear |
   | Fuel type | Capitalised `vehicle.fuelType` (e.g. `Petrol`) | `FUEL TYPE` | fuel pump |

   Show `—` when a value is null. These are display-only in the drawer; edits happen in the Specs section below.

4. **Vehicle Details (AI-generated)** — reuse the customer portal's `VehicleDetailsCard.vue` (or equivalent). Populated from the `getModelProfile()` response.
   - Header: `{year} {make} {model}` + `overview` paragraph.
   - **Engine** subsection — rows for `oil`, `coolant`, `brakeFluid`, `transmission`, `timing`, `sparkPlugs`.
   - **Tyres** subsection — three columns (Front / Rear / Spare) each with `size` above `pressure`.
   - **Known issues** and **Common repairs** — collapsible lists, colour-coded by `severity` for issues.
   - Footer: "Updated *N* days ago" from `generatedAt`.
   - While `status === 'generating'`: show a shimmer placeholder + copy **"Building profile — check back in a moment."**
   - This section is **always read-only** — staff cannot edit AI-generated model knowledge. Regeneration happens automatically when make/model/year changes.

5. **Registration** — inline card with `rego`, `regoState`, `regoExpiry`, `vin`. Edit button opens inline editors. Colour-code `regoExpiry`: green > 60d, amber ≤ 60d, red past. Writes via `update()`.

6. **Vehicle Specs** — full spec grid (make/model/series/colour/body/fuel/transmission/drive/engine code + size + cylinders/tyre sizes). Edit button per row or per section. Writes via `update()`.

7. **Odometer & Service** — `odometerCurrent`, `nextServiceDueKm`, `nextServiceDueDate`, service interval. Odometer is editable; the "next service" fields are typically workshop-computed. Writes via `update()`.

8. **For-sale listing** — reuse the customer portal's for-sale card. Toggle `forSale`; when on, reveal `askingPrice`, `city`, `country`. Writes via `update()`.

9. **Public visibility** — four toggles (`history`, `photos`, `chat`, `maintenance`). Each flip calls `update()` with `publicProfileSettings: { [key]: value }`. The server merges — omit keys you don't want to touch.

10. **Avatar** — small edit affordance overlay on the drawer's existing avatar chip. On click: file picker → `vehicleUploadUrl(customerId, vehicleId, 'avatar')` → `POST` file to Cloudflare → `update()` with `{ avatarImageId }`.

The **cover editor** lives on the drawer's card header (existing surface). Same three-step flow with `target: 'cover'` and `{ coverImageId }` — not part of the Details tab body.

### Component reuse matrix

| Section | Component to reuse | Notes |
|---------|--------------------|-------|
| About | `AboutDescriptionCard.vue` | Pass staff API callbacks instead of `customerApi` |
| Photos strip | `PhotoStripCard.vue` (customer) | Add-photo action gated on `canEdit` |
| Quick-stat panels | `VehicleStatPanels.vue` (customer) | Pure display — no props changes |
| Vehicle Details (AI) | `VehicleDetailsCard.vue` (customer) | Pass the `modelProfile` response as-is |
| For-sale card | `ForSaleCard.vue` (customer) | Pass staff API callbacks |
| Visibility toggles | `PublicProfileToggles.vue` (customer) | Pass staff API callbacks |

If any of these components live under `src/components/customer/` in the workshop repo, lift them to `src/components/ui/vehicle/` or a shared module so both surfaces import from one place.

### Role gating

```ts
const canEdit = computed(() =>
  ['super_admin', 'store_manager'].includes(currentStaff.role),
)
```

Technicians see the full Details tab **read-only**:
- No Edit buttons visible
- Description shows `description` as plain text
- Toggles are disabled (`:disabled="!canEdit"`)
- Avatar / cover show the images but the "Change" affordances are hidden
- Enhance / Generate buttons hidden

Don't rely on this alone — the server enforces the guard too. This is UX polish only.

### Optimistic updates

For simple toggles (`forSale`, `publicProfileSettings.*`), update local state immediately and roll back on 4xx/5xx.

For heavier changes (description save, avatar/cover replace), show a saving indicator and update state from the `PATCH` response (which is the full payload).

### Error surfacing

- `422` — show the response's `message` inline near the offending field. It's human-readable.
- `403` — should never happen for managers/owners; if it does, treat as a bug and show a generic "Not allowed" toast.
- `404` / `410` — close the drawer and refetch the customer list; the vehicle is gone.
- `429` (enhance) — show a "Slow down — try again in a moment" message. `Retry-After` header tells you when.
- `502` / `503` — retry silently once with a 500ms backoff, then show "Something went wrong — try again."

---

## Errors reference

| Status | Code | Which endpoints | Meaning |
|--------|------|-----------------|---------|
| `403` | `FORBIDDEN` | all writes | Technician attempted a write. UI should hide edit affordances for technicians. |
| `404` | `NOT_FOUND` | all | Vehicle doesn't exist or doesn't belong to the customer in the URL. |
| `410` | `GONE` | all | Vehicle was soft-deleted (`is_active = 0`). Close the drawer. |
| `422` | `VALIDATION_ERROR` | `PATCH`, `POST /description/enhance`, `GET /upload-url` | Field-level violation — `message` is safe to display. |
| `429` | `RATE_LIMITED` | `POST /description/enhance` | 20/hour per vehicle. `Retry-After` header on the response. |
| `502` | `CLOUDFLARE_ERROR` | `GET /upload-url` | Cloudflare direct-upload API failed. Retry. |
| `503` | `AI_UNAVAILABLE` | `POST /description/enhance` | LLM provider down. Retry. |

---

## What's out of scope

- **Gallery** — see `staff-vehicle-gallery.md`.
- **Owner bio** (`ownerDescription`) — displayed here read-only. Staff edit it via the existing `PATCH /customers/{id}` endpoint with `{ description: "…" }`.
- **Vehicle transfer** — customer-only. Staff don't initiate transfers.
- **Cover cropping / editing** — direct-upload only. If the frontend needs client-side crop, do it before the Cloudflare upload.

---

## Testing checklist

- [ ] Drawer opens, both `getById` and `getModelProfile` fire in parallel (single round-trip each)
- [ ] Description edit — save, refetch not needed, response payload drives state
- [ ] Description enhance — polish mode (draft ≥ 20 chars) and generate mode (draft < 20 chars) both work
- [ ] Enhance confirm dialog — "Use this" persists, "Cancel" doesn't
- [ ] Photos section renders `vehicle.gallery` thumbnails; empty gallery shows the empty state
- [ ] 4 stat panels render year / odometer + unit / capitalised transmission / capitalised fuel type. Show `—` for nulls.
- [ ] AI Vehicle Details panel renders `overview`, engine grid, tyre columns, known issues, common repairs
- [ ] `getModelProfile` returns `202 { status: 'generating' }` — shimmer placeholder shows; the rest of the tab is unaffected
- [ ] Avatar upload — file picker → Cloudflare → PATCH → new `avatarUrl` visible
- [ ] Cover upload — same flow with `target=cover`, updates card header
- [ ] Avatar / cover clear — `PATCH` with `null` returns null URL, previous Cloudflare image removed (verify in CF dashboard)
- [ ] For-sale toggle — flip on, price/city/country editable, flip off hides them
- [ ] Public visibility — flip each of the four toggles independently, server merges (other keys stay put)
- [ ] Registration expiry colour: green > 60d, amber ≤ 60d, red past
- [ ] Technician login — Details tab renders in full including AI details, all edit affordances hidden, no PATCHes possible
- [ ] Manager/owner login — full edit surface
- [ ] Soft-deleted vehicle — drawer opens, GET returns `410`, drawer closes gracefully
- [ ] Rate limit on enhance — hit it, see the friendly message + Retry-After respected
- [ ] Rego expiry displayed matches the customer portal (`/account/vehicles/:id/health`) — same value, same date — no format skew
