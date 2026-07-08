# Vehicle Profile — New Features Frontend Brief

New endpoints and UI features for the customer portal vehicle profile, built on top of the existing profile page (see `customer-vehicle-profile-frontend-brief.md`).

---

## New endpoints summary

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `PATCH`  | `/c/vehicles/:id/profile`             | Customer JWT | Update for-sale listing |
| `GET`    | `/c/vehicles/:id/gallery/upload-url`  | Customer JWT | Get Cloudflare upload URL for gallery photo |
| `POST`   | `/c/vehicles/:id/gallery`             | Customer JWT | Save a new gallery photo after upload |
| `DELETE` | `/c/vehicles/:id/gallery/:imageId`    | Customer JWT | Delete a gallery photo |
| `POST`   | `/c/vehicles/:id/transfer`            | Customer JWT | Transfer ownership to another Rodz customer |
| `GET`    | `/logbook/:token/vehicle`             | None (public) | Public vehicle profile |
| `GET`    | `/logbook/:token/expenses`            | None (public) | Public vehicle expense history |

---

## Base URL

```
https://fzzrkscwd7.execute-api.ap-southeast-2.amazonaws.com
```

Customer endpoints require:
```
Authorization: Bearer <customer_jwt>
```

Public logbook endpoints require no auth.

---

## 1. For-sale listing

### Reading the current state

The current listing state hydrates from `GET /c/vehicles/:id` — it includes `forSale`, `askingPrice`, `city`, and `country` alongside every other vehicle field. No separate fetch is needed on mount; use the same response that powers the vehicle detail page.

### `PATCH /c/vehicles/:id/profile`

Manages the "For Sale" listing on a vehicle. Completely independent from the vehicle details PATCH — this only touches listing fields.

**Request**
```json
{
  "forSale":     true,
  "askingPrice": 18500,
  "city":        "Melbourne",
  "country":     "Australia"
}
```

All fields are optional — omit any you don't want to change. To clear a field send `null`.

| Field | Type | Notes |
|-------|------|-------|
| `forSale` | boolean | `true` = listed for sale, `false` = remove listing |
| `askingPrice` | number \| null | AUD, no cents (e.g. `18500`) |
| `city` | string \| null | Free text, e.g. `"Melbourne"` |
| `country` | string \| null | Free text, e.g. `"Australia"` |

**Response — 200**
```json
{
  "forSale":      true,
  "askingPrice":  18500,
  "city":         "Melbourne",
  "country":      "Australia",
  "contactName":  "John Smith",
  "contactPhone": "+61400000000",
  "contactEmail": "john@example.com"
}
```

The contact fields (`contactName`, `contactPhone`, `contactEmail`) come from the current owner's customer record — they auto-update if ownership changes. These are what buyers see on the public profile. Display them read-only so the customer knows what contact info will be shown.

**Errors**
- `403 FORBIDDEN` — vehicle doesn't belong to this customer

### UI — For-sale section on vehicle profile

Add a "For Sale" section below the vehicle specs:

```
┌─────────────────────────────────────────────────────┐
│  For Sale                                    [Edit]  │
│                                                      │
│  Listed:       Yes                                   │
│  Asking price: $18,500                               │
│  Location:     Melbourne, Australia                  │
│                                                      │
│  Buyers will see your contact details:               │
│  John Smith · 0400 000 000 · john@example.com        │
└─────────────────────────────────────────────────────┘
```

When `forSale` is false, show a collapsed state:
```
│  For Sale      Not listed        [List for sale]  │
```

Toggle off: PATCH with `{ "forSale": false }`.

When a vehicle has been transferred (ownership changes), for-sale fields are automatically cleared — no action needed by the frontend.

---

## 2. Photo gallery

The vehicle can have a gallery of photos beyond the avatar and cover. Gallery images appear in the public logbook profile.

### Gallery data

Gallery images come from `GET /c/vehicles/:id` already — **check the updated response shape:**

```json
{
  "id": 4,
  "rego": "LWF251",
  ...
  "gallery": [
    {
      "id":           12,
      "url":          "https://imagedelivery.net/<hash>/abc123/public",
      "thumbnailUrl": "https://imagedelivery.net/<hash>/abc123/thumbnail",
      "sortOrder":    0
    }
  ]
}
```

`gallery` is included in `GET /c/vehicles/:id` — no separate fetch needed on mount. After a successful `POST /c/vehicles/:id/gallery`, append the returned entry to local state; after a `DELETE`, remove by `id`. No need to refetch.

### Upload flow (same 3-step pattern as avatar/cover)

**Step 1 — Get upload URL**

`GET /c/vehicles/:id/gallery/upload-url` (no body)

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

**Step 3 — Save to gallery**

`POST /c/vehicles/:id/gallery`

```json
{ "imageId": "cf-image-uuid" }
```

**Response — 201**
```json
{
  "id":           12,
  "url":          "https://imagedelivery.net/<hash>/abc123/public",
  "thumbnailUrl": "https://imagedelivery.net/<hash>/abc123/thumbnail",
  "sortOrder":    0
}
```

**Errors**
- `403 FORBIDDEN` — vehicle doesn't belong to this customer
- `422 VALIDATION_ERROR` — imageId missing or not found in Cloudflare (upload didn't complete or wrong ID)

### Delete a gallery photo

`DELETE /c/vehicles/:id/gallery/:imageId`

`:imageId` is the `id` (integer DB row ID) from the gallery array, NOT the Cloudflare image UUID.

**Response — 204** (no body)

**Errors**
- `403 FORBIDDEN` — not the owner or photo not found

### UI — Gallery section

Add a horizontal scrolling photo strip below the vehicle details:

```
┌──────────────────────────────────────────────────────┐
│  Photos (6)                              [Add photo]  │
│                                                       │
│  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──┬─┐         │
│  │      │ │      │ │      │ │      │ │ + │ │  ...     │
│  └──────┘ └──────┘ └──────┘ └──────┘ └──┴─┘         │
│    ↳ tap to view   ↳ long press to delete             │
└──────────────────────────────────────────────────────┘
```

- Long-press a thumbnail → show delete confirmation (then `DELETE /c/vehicles/:id/gallery/:imageId`)
- Tap a thumbnail → open full-screen lightbox using the `url` (full size)
- Show a loading overlay while uploading; add to the strip optimistically once Step 2 completes
- "Add photo" taps should trigger the same 3-step upload flow as avatar/cover

---

## 3. Transfer ownership

Allow the customer to transfer their vehicle to another Rodz customer by email.

### `POST /c/vehicles/:id/transfer`

**Request**
```json
{
  "email":             "buyer@example.com",
  "odometerAtRelease": 95000
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `email` | string | Yes | Buyer's Rodz account email (case-insensitive) |
| `odometerAtRelease` | number | No | Current odometer at time of sale — recorded in history |

**Response — 200**
```json
{
  "transferred": true,
  "vehicleId":   4,
  "newOwnerId":  17
}
```

After a successful transfer the vehicle is gone from this customer's account — navigate back to the vehicle list and remove it from local state.

**Errors**

| Status | Code | When |
|--------|------|------|
| `403` | `FORBIDDEN` | Vehicle doesn't belong to this customer |
| `404` | `NOT_FOUND` | `"No Rodz account found for that email. The buyer needs to create an account before the vehicle can be transferred."` |
| `422` | `VALIDATION_ERROR` | Missing email, or buyer email is the current owner |

**Important:** The buyer MUST have a Rodz account. If the 404 error is returned, show the exact API message — it tells the customer what to do.

### UI — Transfer section

Add a "Transfer ownership" option in the vehicle settings/menu (not as a prominent button — this is destructive):

```
Settings
  ├── Edit details
  ├── Manage listing
  ├── View public profile
  └── Transfer ownership  ← opens a confirmation flow
```

**Transfer flow (multi-step):**

1. Enter buyer's email → search/lookup
2. Show confirmation screen:
   ```
   Transfer LWF251 to buyer@example.com?
   
   Enter current odometer: [______] km
   
   ⚠ This cannot be undone. The vehicle will be
     removed from your account immediately.
   
   [Cancel]  [Confirm transfer]
   ```
3. On success → show success toast, pop back to vehicle list

---

## 4. Public vehicle profile (Logbook page)

Every vehicle has a unique public URL built from its `logbook_token`. No auth required.

```
https://your-app.com/logbook/<token>
```

The token is returned as `logbookToken` in `GET /c/vehicles/:id`.

### `GET /logbook/:token/vehicle`

**Response — 200**
```json
{
  "rego":            "LWF251",
  "year":            2017,
  "make":            "Suzuki",
  "model":           "Vitara",
  "series":          null,
  "colour":          "White",
  "fuelType":        "petrol",
  "transmission":    "automatic",
  "engineSize":      "1.6L",
  "vin":             null,
  "odometerCurrent": 95000,
  "avatarUrl":       "https://imagedelivery.net/...",
  "coverUrl":        "https://imagedelivery.net/...",
  "sold":            false,
  "soldAt":          null,
  "forSale":         true,
  "askingPrice":     18500,
  "city":            "Melbourne",
  "country":         "Australia",
  "contactName":     "John Smith",
  "contactPhone":    "+61400000000",
  "contactEmail":    "john@example.com",
  "images": [
    {
      "id":           12,
      "url":          "https://imagedelivery.net/.../public",
      "thumbnailUrl": "https://imagedelivery.net/.../thumbnail",
      "sortOrder":    0
    }
  ]
}
```

**Errors**
- `404 NOT_FOUND` — token doesn't exist
- `410 GONE` — vehicle has been deactivated (show "This vehicle profile is no longer available")

### Field notes

| Field | Notes |
|-------|-------|
| `sold` | `true` if the vehicle was sold within the last 90 days — show SOLD badge |
| `soldAt` | `YYYY-MM-DD` of the sale — display as e.g. "Sold 3 Jun 2026" |
| `forSale` | `true` = currently listed for sale |
| `askingPrice` | AUD integer or `null` |
| `engineSize` | Pre-formatted as `"1.6L"` — display directly |
| `contactName/Phone/Email` | Only show when `forSale` is true or `sold` is true (buyer inquiry contact) |
| `images` | Gallery photos — display in a scroll strip or grid |

### `GET /logbook/:token/expenses`

Returns the vehicle's full service history. Intended for the "History" tab of the public profile.

**Response — 200**
```json
{
  "vehicle": {
    "id":   4,
    "rego": "LWF251",
    "make": "Suzuki",
    "model": "Vitara",
    "year": 2017
  },
  "entries": [
    {
      "id":            "job-101",
      "source":        "workshop",
      "date":          "2026-05-10",
      "odometerKm":    94200,
      "title":         "Full service and brake inspection",
      "workshop":      "Rodz Fitzroy",
      "workshopSuburb": null,
      "tech":          "Jake",
      "cost":          320,
      "status":        "paid",
      "invoiceNumber": "INV-2026-101",
      "invoiceUrl":    "https://...",
      "aiSummary":     "Full service and brake inspection. Oil and filter changed ...",
      "imageUrl":      null,
      "photos":        [],
      "lineItems": [
        { "type": "labour", "description": "Full service", "quantity": 1, "unitPrice": 220 },
        { "type": "part",   "description": "Oil filter",   "quantity": 1, "unitPrice": 18 }
      ]
    },
    {
      "id":     "transfer-2025-11-01",
      "source": "ownership",
      "date":   "2025-11-01",
      "odometerKm": 88000,
      "title":  "Vehicle sold — ownership transferred",
      ...
    }
  ]
}
```

#### Entry sources

| `source` | Meaning | Display |
|----------|---------|---------|
| `workshop` | Rodz workshop invoice | Full detail — workshop, tech, line items, photos |
| `external` | Customer-imported receipt | Partial detail — workshop name, cost, uploaded image |
| `ownership` | Ownership transfer event | Timeline marker only — no cost, no items |

### UI — Public profile page

```
┌────────────────────────────────────────────────────┐
│                                                    │
│              [ Cover photo ]                       │
│                                                    │
│    ┌──────┐  2017 Suzuki Vitara LWF251             │
│    │      │  White · Petrol · Automatic · 1.6L     │
│    │ SOLD │  ← badge if sold = true                │
│    └──────┘                                        │
└────────────────────────────────────────────────────┘

  [Specs]  [History]  [Photos]

  === Specs tab ===
  Odometer:     95,000 km
  VIN:          —
  Colour:       White
  Engine:       1.6L Petrol
  Transmission: Automatic

  === For sale banner (if forSale = true) ===
  ┌─────────────────────────────────────────┐
  │  Listed for sale                        │
  │  $18,500 · Melbourne, Australia         │
  │                                         │
  │  Contact: John Smith                    │
  │  0400 000 000 · john@example.com        │
  └─────────────────────────────────────────┘

  === SOLD banner (if sold = true) ===
  ┌─────────────────────────────────────────┐
  │  🏁  Sold on 3 Jun 2026                 │
  │  Contact the current owner if needed.   │
  │  [contact details]                      │
  └─────────────────────────────────────────┘

  === History tab ===
  Timeline, newest first. Each entry shows:
  - Date + odometer
  - Title / summary
  - Cost (if any)
  - Workshop (if any)
  
  Ownership transfer entries show as a divider:
  ─── Ownership transferred · 1 Nov 2025 · 88,000 km ───
```

#### SOLD badge logic

```js
// sold badge: sold = true means sold within 90 days
if (vehicle.sold) {
  // show badge overlay on avatar
  // show sold banner above specs
  // soldAt is YYYY-MM-DD — display as localised date
}
```

The `sold` flag expires automatically after 90 days — no frontend timer needed, the API handles it.

#### Share / QR code

The logbook URL is designed to be shareable. Add a "Share" button on the vehicle profile in the customer portal that copies/shares the URL:

```
https://your-app.com/logbook/<logbookToken>
```

---

## 5. Logbook — ownership transfer events

The customer's own logbook (`GET /c/vehicles/:id/logbook`) now includes ownership transfer events mixed into the timeline. No frontend changes needed to fetch them — they arrive in the `entries` array with `source: "ownership"`.

**Render them as a visual divider** between service history entries:

```
  ─────────── Vehicle sold · 1 Nov 2025 · 88,000 km ───────────
```

Show these with a neutral/muted style — they're not service entries, just history markers. No cost, no workshop, no line items.

---

## 6. Linking to the public profile from the customer portal

Add a "View public profile" or "Share logbook" button on the vehicle profile page. Use the `logbookToken` from `GET /c/vehicles/:id`.

```
GET /c/vehicles/:id
→ { logbookToken: "abc123..." }
→ public URL: https://your-app.com/logbook/abc123...
```

If `logbookToken` is `null`, show nothing (vehicle hasn't been assigned a public token yet — rare).

---

## State flow summary

```
Customer views vehicle
  ├── Profile tab
  │     ├── Hero (cover + avatar + sold badge)
  │     ├── Specs (read-only + editable fields)
  │     ├── For-sale listing (toggle + price + location)
  │     └── Gallery strip (upload / delete)
  ├── Logbook tab (existing — now includes ownership events)
  └── Settings menu
        ├── Transfer ownership → email + odometer → confirm
        └── View public profile → opens /logbook/:token

Buyer views /logbook/:token (no auth)
  ├── Vehicle info
  ├── SOLD badge (90 days after transfer)
  ├── For-sale banner (if listed)
  ├── Gallery photos
  └── Service history
```

---

## Error handling reference

| Scenario | Error | User message |
|----------|-------|--------------|
| Transfer — buyer has no account | `404 NOT_FOUND` | Show the API message: "The buyer needs to create an account before the vehicle can be transferred." |
| Transfer — emailing self | `422 VALIDATION_ERROR` | "You cannot transfer a vehicle to yourself." |
| Gallery upload — image not found in Cloudflare | `422 VALIDATION_ERROR` | "Upload failed — please try again." |
| Public profile — vehicle deactivated | `410 GONE` | "This vehicle profile is no longer available." |
| Public profile — bad token | `404 NOT_FOUND` | "Vehicle not found." |
