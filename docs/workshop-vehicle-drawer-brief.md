# Workshop Vehicle Drawer — Expanded Endpoint

The workshop-side vehicle GET endpoint (`GET /customers/{customerId}/vehicles/{vehicleId}`) has been expanded to include everything the customer's own portal shows on the Vehicle Profile — gallery, listing state, public visibility settings, logbook token, and pre-built Cloudflare image URLs.

This means the workshop drawer can now render the same rich profile the customer sees, from a single endpoint call. No parallel fetches, no per-panel roundtrips.

---

## Endpoint

```
GET /customers/{customerId}/vehicles/{vehicleId}
Authorization: Bearer <staff_jwt>
```

Base URL: `https://fzzrkscwd7.execute-api.ap-southeast-2.amazonaws.com`

Guards (unchanged):
- `technician` — read-only, still allowed
- `store_manager` — must have store access to the customer
- `super_admin` — full access

---

## Response — 200

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
    "series":               null,
    "year":                 2026,
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
    "spareTyreSize":        null,
    "odometerUnit":         "km",
    "odometerCurrent":      52800,
    "odometerAtPurchase":   null,
    "serviceIntervalKm":    10000,
    "serviceIntervalMonths": 6,
    "nextServiceDueKm":     null,
    "nextServiceDueDate":   null,
    "fleetUnitNumber":      null,
    "internalNotes":        null,

    "avatarImageId":        "a4436f83-2011-4e9e-63f4-d8f24b0c8500",
    "coverImageId":         "4f21111a-a7fb-4d0c-533b-7f6da09e7b00",
    "avatarUrl":            "https://imagedelivery.net/.../thumbnail",
    "coverUrl":             "https://imagedelivery.net/.../public",

    "logbookToken":         "2514...9426",

    "forSale":              true,
    "askingPrice":          26000,
    "city":                 "Melbourne",
    "country":              "Australia",

    "publicProfileSettings": {
      "history": true,
      "photos":  true,
      "chat":    true
    },

    "gallery": [
      {
        "id":           12,
        "url":          "https://imagedelivery.net/.../public",
        "thumbnailUrl": "https://imagedelivery.net/.../thumbnail",
        "sortOrder":    0
      }
    ]
  }
}
```

---

## What's new (vs. what the drawer already had)

Everything below the "internalNotes" line in the response above is new. Existing fields are unchanged — backwards compatible.

| Field | Notes |
|-------|-------|
| `avatarUrl` | Pre-built Cloudflare thumbnail (`~150px`). `null` if `avatarImageId` is null. Prefer this over constructing the URL from `avatarImageId`. |
| `coverUrl` | Pre-built Cloudflare full-size URL for the hero banner. `null` if unset. |
| `logbookToken` | Opaque token for building the public share URL: `https://rodz.app/vehicle/{logbookToken}` — same URL the customer shares. |
| `forSale` | `true` if the customer has listed the vehicle for sale on their public profile. |
| `askingPrice` | AUD integer or `null`. |
| `city`, `country` | Listing location strings or `null`. |
| `publicProfileSettings` | Which tabs the visitor sees on the public profile. Defaults `{ true, true, true }` if the customer has never toggled. See `docs/public-profile-visibility-frontend-brief.md`. |
| `gallery` | Photos the customer uploaded. Empty array `[]` when no photos. Same shape as `/c/vehicles/:id/gallery`. |

---

## UI use in the workshop drawer

The drawer can now render — read-only from staff's perspective:

**On the profile header:**
- `coverUrl` as the hero banner (fall back to placeholder if null)
- `avatarUrl` as the round avatar next to make/model/rego

**A new "Public profile" panel** (or badge collection) showing:
- **"Shared publicly"** with a copy-link button to `https://rodz.app/vehicle/{logbookToken}`
- **"Listed for sale"** badge with `askingPrice`, `city`, `country` when `forSale` is true
- **"Photos"** count badge — `gallery.length`
- **Visibility indicators** — small icons for history / photos / chat that dim when the corresponding `publicProfileSettings` key is `false`. Useful for staff to know at a glance what the customer has hidden from public view.

**A photo strip** using `gallery` — horizontal scroller, each thumbnail from `thumbnailUrl`, tap to open the `url` in a lightbox.

Staff **cannot edit** the customer's for-sale listing, gallery photos, or public visibility settings from the workshop app. Those are customer-only. If staff wants to help a customer with those, they can note it in `internalNotes` or reach out to the customer directly.

---

## Type additions

Match the customer portal shape (see `docs/customer-vehicle-profile-frontend-brief.md`):

```ts
export interface PublicProfileSettings {
  history: boolean
  photos:  boolean
  chat:    boolean
}

export interface GalleryImage {
  id:           number
  url:          string
  thumbnailUrl: string
  sortOrder:    number
}

// Add these to the existing WorkshopVehicle type
export interface WorkshopVehicle {
  // ... existing fields
  avatarUrl:             string | null
  coverUrl:              string | null
  logbookToken:          string | null
  forSale:               boolean
  askingPrice:           number | null
  city:                  string | null
  country:               string | null
  publicProfileSettings: PublicProfileSettings
  gallery:               GalleryImage[]
}
```

---

## Migration notes

- **No client changes required** to keep the existing drawer working. All added fields are net-new; nothing removed or renamed.
- If your current drawer builds Cloudflare URLs from `avatarImageId`/`coverImageId` by hand, you can switch to `avatarUrl`/`coverUrl` for slightly less code. Both fields will continue to be returned.
- The `publicProfileSettings` defaults handle the case where the customer has never toggled — you'll always get an object with three booleans, never `null`.

---

## Testing checklist

- [ ] Existing drawer functionality still works (no field renamed, no field removed)
- [ ] Vehicle with `forSale = true` shows the listing badge with price + location
- [ ] Vehicle with `forSale = false` hides the listing UI entirely
- [ ] Vehicle with gallery items renders a photo strip; empty gallery shows nothing (or empty state)
- [ ] `publicProfileSettings` with any key set to `false` visibly indicates the hidden tab
- [ ] Public share link copy-button works
- [ ] Staff cannot edit any of the new fields from the drawer — read-only surface only
