# Customer Vehicle Profile Page — Frontend Implementation Brief

Everything needed to build the vehicle details/profile screen in the customer portal. Mirrors the workshop app's vehicle Details tab — registration, specs, photos — with the customer able to edit a limited set of fields.

---

## Base URL

```
https://fzzrkscwd7.execute-api.ap-southeast-2.amazonaws.com
```

All endpoints require a customer JWT:

```
Authorization: Bearer <customer_jwt>
```

---

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET`   | `/c/vehicles/:id` | Fetch full vehicle detail |
| `PATCH` | `/c/vehicles/:id` | Update editable fields |
| `GET`   | `/c/vehicles/:id/avatar-upload-url` | Get Cloudflare upload URL for avatar |
| `PATCH` | `/c/vehicles/:id/avatar` | Save avatar image after upload |
| `GET`   | `/c/vehicles/:id/cover-upload-url` | Get Cloudflare upload URL for cover photo |
| `PATCH` | `/c/vehicles/:id/cover` | Save cover image after upload |

---

## Fetching the vehicle

### `GET /c/vehicles/:id`

Call on mount. Returns everything needed to render the page.

**Response — 200**
```json
{
  "id":                   4,
  "rego":                 "LWF251",
  "regoState":            "VIC",
  "regoExpiry":           null,
  "vin":                  null,
  "make":                 "Suzuki",
  "model":                "Vitara",
  "series":               null,
  "year":                 2017,
  "colour":               "White",
  "bodyType":             null,
  "fuelType":             "petrol",
  "transmission":         "automatic",
  "driveType":            null,
  "engineCode":           null,
  "engineSizeCC":         null,
  "cylinders":            null,
  "tyreSizeFront":        null,
  "tyreSizeRear":         null,
  "odometerKm":           null,
  "nextServiceDueKm":     null,
  "nextServiceDueDate":   null,
  "serviceIntervalKm":    10000,
  "serviceIntervalMonths": 6,
  "avatarUrl":            "https://imagedelivery.net/...abc/thumbnail",
  "coverUrl":             "https://imagedelivery.net/...xyz/public",
  "logbookToken":         null
}
```

**Errors**
- `403 FORBIDDEN` — vehicle doesn't belong to this customer
- `404 NOT_FOUND` — vehicle doesn't exist

### Field notes

| Field | Notes |
|-------|-------|
| `avatarUrl` | Cloudflare thumbnail (~150px square). `null` if no avatar set. For a larger display, replace `/thumbnail` with `/public` |
| `coverUrl` | Full-size Cloudflare image for the hero banner. `null` if no cover set |
| `fuelType` | One of: `petrol`, `diesel`, `hybrid`, `electric`, `lpg`, `other` |
| `transmission` | One of: `manual`, `automatic`, `cvt`, `dct`, `other` |
| `bodyType` | One of: `sedan`, `hatch`, `wagon`, `ute`, `van`, `suv`, `coupe`, `convertible`, `truck`, `other` — or `null` |
| `driveType` | One of: `fwd`, `rwd`, `awd`, `4wd` — or `null` |
| `regoExpiry` | `YYYY-MM-DD` string or `null` |
| `nextServiceDueDate` | `YYYY-MM-DD` string or `null` |
| `logbookToken` | Ignore on this screen — used by the logbook share feature |

---

## Page layout

### Hero section

```
┌────────────────────────────────────────────────────┐
│                                                    │
│              [ Cover photo banner ]                │  ← coverUrl, full width, ~200px tall
│                                                    │   Tap to change cover (camera icon overlay)
│    ┌──────┐                                        │
│    │Avatar│  2017 Suzuki Vitara                    │  ← avatarUrl (circular), make/model/year
│    └──────┘  LWF251 · VIC                         │  ← rego + state
└────────────────────────────────────────────────────┘
```

- If no `coverUrl`, show a solid colour placeholder (use the brand colour or a gradient)
- If no `avatarUrl`, show an icon placeholder (car silhouette)
- Tapping the cover photo or avatar triggers the respective upload flow (see below)

---

### Registration section

| Field | Source | Editable |
|-------|--------|----------|
| Rego | `rego` | No — set by workshop |
| State | `regoState` | No |
| Rego expiry | `regoExpiry` | **Yes** |
| VIN | `vin` | **Yes** |

Show `—` for null values. The Edit button opens an inline edit form for the two editable fields only.

---

### Vehicle specs section

| Field | Source | Editable |
|-------|--------|----------|
| Year | `year` | No |
| Make | `make` | No |
| Model | `model` | No |
| Series | `series` | No |
| Colour | `colour` | **Yes** |
| Body type | `bodyType` | No |
| Fuel type | `fuelType` | No |
| Transmission | `transmission` | No |
| Drive type | `driveType` | No |
| Engine code | `engineCode` | No |
| Engine size | `engineSizeCC` | No — display as e.g. `2.0L` (divide by 1000) |
| Cylinders | `cylinders` | No |
| Tyre size (front) | `tyreSizeFront` | No |
| Tyre size (rear) | `tyreSizeRear` | No |

---

### Odometer & service section

| Field | Source | Editable |
|-------|--------|----------|
| Current odometer | `odometerKm` | **Yes** |
| Next service due (km) | `nextServiceDueKm` | No — set by workshop |
| Next service due (date) | `nextServiceDueDate` | No — set by workshop |
| Service interval | `serviceIntervalKm` / `serviceIntervalMonths` | No |

Display the service interval as e.g. `Every 10,000 km or 6 months`.

---

## Editing vehicle details

### `PATCH /c/vehicles/:id`

Only four fields are customer-editable. Send only the fields you want to update — omit the rest.

**Request**
```json
{
  "colour":     "Midnight Blue",
  "regoExpiry": "2027-03-15",
  "vin":        "JS3TD941V00123456",
  "odometerKm": 87400
}
```

| Field | Type | Validation |
|-------|------|------------|
| `colour` | string | Free text |
| `regoExpiry` | string | Must be `YYYY-MM-DD` format |
| `vin` | string | Stored uppercase, max 17 chars |
| `odometerKm` | number | Must be ≥ 0 |

**Response — 200** — returns the full updated vehicle object (same shape as the GET response).

**Errors**
- `403 FORBIDDEN` — vehicle doesn't belong to this customer
- `422 VALIDATION_ERROR` — invalid `regoExpiry` format or negative `odometerKm`

**UX:** Inline edit — tap a field to edit in place (or use a single Edit button per section that reveals the editable fields). Save on blur or via a confirm button. Optimistically update the UI and roll back if the PATCH fails.

---

## Avatar photo

The avatar appears as a circular photo in the hero section. Recommended display size: 80–100px diameter.

### Upload flow

**Step 1 — Get an upload URL**

`GET /c/vehicles/:id/avatar-upload-url`

```json
{
  "uploadUrl": "https://upload.imagedelivery.net/...",
  "imageId":   "cf-image-uuid"
}
```

**Step 2 — Upload to Cloudflare**

`POST <uploadUrl>` with `multipart/form-data`, field name `file`. Direct to Cloudflare — no auth header.

```js
const formData = new FormData()
formData.append('file', imageFile)
await fetch(uploadUrl, { method: 'POST', body: formData })
```

**Step 3 — Save the image ID**

`PATCH /c/vehicles/:id/avatar`

```json
{ "imageId": "cf-image-uuid" }
```

**Response — 200**
```json
{ "imageId": "cf-image-uuid" }
```

After saving, construct the new avatar URL:
```
https://imagedelivery.net/<CF_ACCOUNT_HASH>/<imageId>/thumbnail
```
Or refetch the vehicle to get the updated `avatarUrl`.

**Errors**
- `422 VALIDATION_ERROR` — `imageId` missing or not found in Cloudflare (upload didn't complete)

---

## Cover photo

The cover photo is a full-width hero banner. Recommended aspect ratio: 16:9 or 3:1. Display at full width, ~180–220px tall.

### Upload flow

Identical pattern to avatar — three steps.

**Step 1 — Get an upload URL**

`GET /c/vehicles/:id/cover-upload-url`

```json
{
  "uploadUrl": "https://upload.imagedelivery.net/...",
  "imageId":   "cf-image-uuid"
}
```

**Step 2 — Upload to Cloudflare**

Same as avatar — `POST <uploadUrl>` with `multipart/form-data`, field `file`.

**Step 3 — Save the image ID**

`PATCH /c/vehicles/:id/cover`

```json
{ "imageId": "cf-image-uuid" }
```

**Response — 200**
```json
{ "imageId": "cf-image-uuid" }
```

After saving, construct the new cover URL:
```
https://imagedelivery.net/<CF_ACCOUNT_HASH>/<imageId>/public
```
Or refetch the vehicle to get the updated `coverUrl`.

---

## Image URL variants

Each Cloudflare image is available at two variants:

| Suffix | Size | Use for |
|--------|------|---------|
| `/thumbnail` | ~150px square crop | Avatar display |
| `/public` | Full original size | Cover photo hero, lightbox |

Both `avatarUrl` and `coverUrl` in the GET response already have the correct suffix appended. If you need the other variant, just replace the suffix.

---

## UX recommendations

### Read-only fields

Display all read-only fields using the same label/value layout as the workshop app (`—` for null). Do not show input controls for them — customers cannot change make, model, year, transmission, engine, etc. Those are set by the workshop when the vehicle is registered.

### Editable fields

Two options:
1. **Edit button per section** — tapping Edit reveals inline inputs for the editable fields in that section. Confirm/Cancel buttons appear. On confirm, PATCH and update the display.
2. **Tap-to-edit inline** — tapping a value that is editable opens a bottom sheet or inline input. Simpler on mobile.

Either approach works. The editable fields are: `colour`, `regoExpiry`, `vin`, `odometerKm`.

### Photo upload UX

- Show a camera icon overlay on the avatar and cover photo areas to make them tappable
- Show a loading spinner over the image while uploading
- Start the Cloudflare upload (Steps 1–2) as soon as the customer picks an image from their camera roll — don't wait for them to tap Save
- Show a preview of the new image immediately using a local object URL, then swap to the Cloudflare URL once the PATCH succeeds

### Rego expiry indicator

If `regoExpiry` is set, show a visual indicator:
- More than 60 days away → green
- Within 60 days → amber
- Past expiry → red with a warning label

### Service due indicator

If `nextServiceDueKm` or `nextServiceDueDate` is set and the customer has an odometer reading, show how far they are from their next service:

```
Next service: 2,600 km away  (if odometerKm is known)
Next service: 15 Aug 2026    (date fallback)
```

If both are set, show whichever comes first.

---

## What customers can and cannot change

| Field | Customer | Workshop |
|-------|----------|----------|
| Rego, state | Read only | Full access |
| Make, model, year, series | Read only | Full access |
| Body type, fuel, transmission, drive | Read only | Full access |
| Engine code, size, cylinders | Read only | Full access |
| Tyre sizes | Read only | Full access |
| Next service due | Read only | Full access |
| Service interval | Read only | Full access |
| **Colour** | **Editable** | Full access |
| **Rego expiry** | **Editable** | Full access |
| **VIN** | **Editable** | Full access |
| **Odometer** | **Editable** | Full access |
| **Avatar photo** | **Editable** | — |
| **Cover photo** | **Editable** | — |
