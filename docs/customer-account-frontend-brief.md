# Customer Account — Frontend Implementation Brief

Everything the frontend needs to build the customer portal: sign up, log in, profile management, vehicle management, image uploads, and the digital logbook.

---

## Base URL

```
https://fzzrkscwd7.execute-api.ap-southeast-2.amazonaws.com
```

---

## Authentication

Customer routes are prefixed `/c/`. Most require a customer JWT in the `Authorization` header:

```
Authorization: Bearer <customer_jwt>
```

Auth endpoints (`/c/auth/*`) are public — no header needed.

**Token details**
- 30-day expiry
- Store it in `localStorage` or a cookie
- On 401/403 from a protected route → redirect to login

---

## Error shape

All errors follow this shape:

```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable message."
  }
}
```

Common codes:

| Code | HTTP | Meaning |
|------|------|---------|
| `VALIDATION_ERROR` | 422 | Missing or invalid input |
| `INVALID_CREDENTIALS` | 401 | Wrong email or password |
| `EMAIL_TAKEN` | 409 | Email already has an account |
| `ACCOUNT_LOCKED` | 429 | Too many failed attempts |
| `NOT_FOUND` | 404 | Resource doesn't exist |
| `FORBIDDEN` | 403 | Not authorised (wrong token type or not the owner) |

---

## Auth endpoints (public)

### `POST /c/auth/signup`

Creates an account. If the email already exists in the system from a prior workshop visit, links the auth to that existing customer record — their full service history will be immediately available.

**Request**
```json
{
  "firstName":  "Jane",
  "lastName":   "Smith",
  "email":      "jane@example.com",
  "mobile":     "0412 345 678",
  "password":   "mypassword123",
  "suburb":     "Somerville",
  "state":      "VIC",
  "postcode":   "3912"
}
```

- `firstName`, `lastName`, `email`, `mobile`, `password` — required
- `password` — minimum 8 characters
- `state` — must be one of: `VIC NSW QLD SA WA TAS NT ACT`
- `suburb`, `state`, `postcode` — optional

**Response — 201**
```json
{
  "accessToken": "eyJ...",
  "customer": {
    "id":             42,
    "firstName":      "Jane",
    "lastName":       "Smith",
    "email":          "jane@example.com",
    "mobile":         "0412 345 678",
    "suburb":         "Somerville",
    "state":          "VIC",
    "postcode":       "3912",
    "dateOfBirth":    null,
    "avatarUrl":      null,
    "avatarThumbUrl": null,
    "marketingOptIn": true,
    "smsOptIn":       true,
    "memberSince":    "2026-07-02",
    "vehicles":       []
  }
}
```

**Errors**
- `409 EMAIL_TAKEN` — email already has an account (show "Already have an account? Log in")
- `422 VALIDATION_ERROR` — missing fields or invalid state

---

### `POST /c/auth/login`

**Request**
```json
{
  "email":    "jane@example.com",
  "password": "mypassword123"
}
```

**Response — 200** — same shape as signup (`accessToken` + `customer`)

**Errors**
- `401 INVALID_CREDENTIALS` — wrong email or password (use a generic "Invalid email or password" message — don't reveal which is wrong)
- `429 ACCOUNT_LOCKED` — locked after 5 failed attempts; message includes the unlock time

---

### `POST /c/auth/logout`

Call when the customer taps "Sign out". No body required — the token is read from the `Authorization` header.

**Response — 200**
```json
{ "message": "Logged out." }
```

Clear the stored token on the frontend regardless of whether this call succeeds.

---

### `POST /c/auth/magic-link`

Requests a passwordless login email. Show the same message whether or not the email exists — never reveal account existence.

**Request**
```json
{ "email": "jane@example.com" }
```

**Response — 200** (always, even if email not found)
```json
{ "message": "If that email is registered, a login link has been sent." }
```

---

### `GET /c/auth/magic-link/:token`

Called when the customer clicks the link in their email. The `:token` is the 64-char hex string in the link.

**Response — 200**
```json
{ "accessToken": "eyJ..." }
```

- Token is single-use — immediately invalidated
- `404 NOT_FOUND` — token expired or already used

---

## Profile endpoints (require auth)

### `GET /c/me`

Returns the customer's full profile and their vehicle list.

**Response — 200**
```json
{
  "id":             42,
  "firstName":      "Jane",
  "lastName":       "Smith",
  "email":          "jane@example.com",
  "mobile":         "0412 345 678",
  "suburb":         "Somerville",
  "state":          "VIC",
  "postcode":       "3912",
  "dateOfBirth":    null,
  "avatarUrl":      "https://imagedelivery.net/_T7yYgco6vMbVyuhQfz9eg/abc123/public",
  "avatarThumbUrl": "https://imagedelivery.net/_T7yYgco6vMbVyuhQfz9eg/abc123/thumbnail",
  "marketingOptIn": true,
  "smsOptIn":       true,
  "memberSince":    "2026-03-01",
  "vehicles": [
    {
      "id":           7,
      "rego":         "ABC123",
      "label":        "2021 Toyota Camry",
      "avatarUrl":    "https://imagedelivery.net/.../thumbnail",
      "coverUrl":     "https://imagedelivery.net/.../public",
      "logbookToken": "a3f9c2..."
    }
  ]
}
```

The `vehicles` array contains summary objects. For full vehicle spec, call `GET /c/vehicles/:id`.

---

### `PATCH /c/me`

Updates profile fields. All fields are optional — only send what changed.

**Request**
```json
{
  "firstName":      "Jane",
  "lastName":       "Smith",
  "mobile":         "0412 345 678",
  "suburb":         "Frankston",
  "state":          "VIC",
  "postcode":       "3199",
  "dateOfBirth":    "1990-06-15",
  "marketingOptIn": true,
  "smsOptIn":       false
}
```

- `dateOfBirth` — `YYYY-MM-DD` format or `null`
- `state` — must be a valid Australian state code

**Response — 200** — updated `GET /c/me` shape

---

### `PATCH /c/me/password`

**Request**
```json
{
  "currentPassword": "oldpassword",
  "newPassword":     "newpassword123"
}
```

- `newPassword` — minimum 8 characters

**Response — 200**
```json
{ "message": "Password updated." }
```

**Errors**
- `401 INVALID_CREDENTIALS` — current password is wrong

---

### Avatar upload (two steps)

**Step 1 — Get a direct upload URL**

`GET /c/me/avatar-upload-url`

**Response — 200**
```json
{
  "uploadUrl": "https://upload.imagedelivery.net/...",
  "imageId":   "abc123"
}
```

**Step 2 — Upload directly to Cloudflare**

`PUT <uploadUrl>` with `multipart/form-data`, field name `file`, containing the image.

This call goes to Cloudflare directly — not to our API.

**Step 3 — Confirm the upload**

`PATCH /c/me/avatar`

```json
{ "imageId": "abc123" }
```

**Response — 200**
```json
{ "imageId": "abc123" }
```

After this call, the `avatarUrl` and `avatarThumbUrl` in `GET /c/me` will reflect the new image.

---

## Vehicle endpoints (require auth)

### `GET /c/vehicles`

**Response — 200**
```json
{
  "vehicles": [
    {
      "id":                   7,
      "rego":                 "ABC123",
      "regoState":            "VIC",
      "regoExpiry":           "2027-03-01",
      "vin":                  null,
      "make":                 "Toyota",
      "model":                "Camry",
      "series":               "ASV70R",
      "year":                 2021,
      "colour":               "Silver",
      "bodyType":             "sedan",
      "fuelType":             "hybrid",
      "transmission":         "automatic",
      "driveType":            "fwd",
      "engineCode":           "A25A-FXS",
      "engineSizeCC":         2487,
      "cylinders":            4,
      "tyreSizeFront":        "215/55R17",
      "tyreSizeRear":         "215/55R17",
      "odometerKm":           42300,
      "nextServiceDueKm":     50000,
      "nextServiceDueDate":   "2026-12-01",
      "serviceIntervalKm":    10000,
      "serviceIntervalMonths": 6,
      "avatarUrl":            "https://imagedelivery.net/.../thumbnail",
      "coverUrl":             "https://imagedelivery.net/.../public",
      "logbookToken":         "a3f9c2..."
    }
  ]
}
```

---

### `POST /c/vehicles`

Add a vehicle. The customer provides a plain-English description; Gemini parses it into structured data.

**Request**
```json
{
  "rego":      "XYZ999",
  "regoState": "VIC",
  "vehicle":   "2019 Mazda CX-5 diesel"
}
```

- `vehicle` — free text description; include year, make and model for best results. e.g. "2021 Toyota Camry hybrid" or "2018 Subaru Forester 2.5i"
- `regoState` — must be a valid Australian state code

**Response — 201** — full vehicle object (same shape as each item in `GET /c/vehicles`)

**Errors**
- `422 VALIDATION_ERROR` — if Gemini can't identify the vehicle from the description; the message will say what's unclear

---

### `GET /c/vehicles/:id`

Full vehicle spec.

**Response — 200** — same shape as each vehicle in `GET /c/vehicles`

**Errors**
- `403 FORBIDDEN` — vehicle doesn't belong to this customer

---

### `PATCH /c/vehicles/:id`

Customers can update a limited set of fields. Make/model/year/rego are locked (set from the workshop record or Gemini parse).

**Request**
```json
{
  "colour":     "Midnight Blue",
  "regoExpiry": "2028-03-01",
  "vin":        "JF1GP7LC4EG123456",
  "odometerKm": 44500
}
```

All fields optional.

**Response — 200** — updated vehicle object

---

### Vehicle image uploads (three sets, same two-step pattern)

All three follow the same flow as the customer avatar.

#### Vehicle avatar (square — shown on cards and list views)

1. `GET /c/vehicles/:id/avatar-upload-url` → `{ uploadUrl, imageId }`
2. Upload image directly to Cloudflare via `PUT <uploadUrl>`
3. `PATCH /c/vehicles/:id/avatar` with `{ "imageId": "xyz789" }`

#### Vehicle cover (full-width hero — shown at top of vehicle detail and logbook)

1. `GET /c/vehicles/:id/cover-upload-url` → `{ uploadUrl, imageId }`
2. Upload image directly to Cloudflare via `PUT <uploadUrl>`
3. `PATCH /c/vehicles/:id/cover` with `{ "imageId": "abc456" }`

After confirming, `GET /c/vehicles/:id` will return updated `avatarUrl` and/or `coverUrl`.

---

### `GET /c/vehicles/:id/logbook`

Returns the vehicle's full service timeline. Currently shows Rodz workshop jobs only. Manual entries from other workshops will be added in a future phase (paid tier).

**Response — 200**
```json
{
  "vehicle": {
    "id":                 7,
    "rego":               "ABC123",
    "make":               "Toyota",
    "model":              "Camry",
    "year":               2021,
    "odometerKm":         42300,
    "nextServiceDueKm":   50000,
    "nextServiceDueDate": "2026-12-01"
  },
  "entries": [
    {
      "id":            "job-88",
      "source":        "workshop",
      "date":          "2026-05-14",
      "odometerKm":    40200,
      "title":         "Log Book Service",
      "workshop":      "Rodz Somerville",
      "tech":          "M. Guy",
      "cost":          285.00,
      "status":        "paid",
      "invoiceId":     88,
      "invoiceNumber": "INV-0088",
      "invoiceUrl":    "https://workshop.rodz.com.au/invoice/abc123",
      "aiSummary":     "Log book service completed. Oil and filter changed, brakes inspected, tyres rotated.",
      "photos":        [],
      "lineItems": [
        { "type": "labour", "description": "Log Book Service — 15,000km",     "quantity": 1, "unitPrice": 149.00 },
        { "type": "part",   "description": "Penrite 5W-30 Full Synthetic 5L", "quantity": 1, "unitPrice": 42.00  },
        { "type": "part",   "description": "Oil Filter — Ryco Z9",            "quantity": 1, "unitPrice": 18.00  },
        { "type": "labour", "description": "Brake Inspection",                "quantity": 1, "unitPrice": 55.00  },
        { "type": "labour", "description": "Tyre Rotation",                   "quantity": 1, "unitPrice": 21.00  }
      ]
    }
  ]
}
```

**Entry fields:**
| Field | Notes |
|-------|-------|
| `id` | Prefixed string (`"job-88"`) — use as React key |
| `source` | `"workshop"` for Rodz jobs. Future: `"manual"` for customer-added entries |
| `date` | `YYYY-MM-DD` |
| `odometerKm` | Odometer reading at time of service; may be `null` |
| `title` | Short label for the entry |
| `workshop` | Store name (Rodz location) |
| `tech` | Technician name, e.g. `"M. Guy"`; may be `null` |
| `cost` | Total cost in dollars |
| `status` | `"invoiced"` or `"paid"` |
| `invoiceUrl` | Link to the shareable invoice; may be `null` |
| `aiSummary` | AI-generated summary of work done; may be `null` |
| `photos` | Array of photo URLs attached to job items; may be empty |
| `lineItems` | Itemised list of work done — see below |

**`lineItems` type values:**
- `"labour"` — labour charge or service operation
- `"part"` — part or consumable supplied
- `"sublet"` — work sent to a specialist
- `"discount"` — discount line

---

## Image URL variants

Cloudflare Images serves each image at multiple sizes via URL suffix:

| Suffix | Use |
|--------|-----|
| `/thumbnail` | Square crop, ~150px — for avatars, list views, vehicle cards |
| `/public` | Full size — for hero/cover images, lightboxes |

Both URLs are returned pre-built in API responses (`avatarUrl` uses `/thumbnail`, `coverUrl` uses `/public`).

---

## Screens to build

| Screen | Endpoints |
|--------|-----------|
| Sign up | `POST /c/auth/signup` |
| Log in | `POST /c/auth/login` |
| Magic link request | `POST /c/auth/magic-link` |
| Magic link landing | `GET /c/auth/magic-link/:token` |
| Profile page | `GET /c/me` + `PATCH /c/me` |
| Change password | `PATCH /c/me/password` |
| Avatar upload | `GET /c/me/avatar-upload-url` → upload → `PATCH /c/me/avatar` |
| My vehicles | `GET /c/vehicles` |
| Add vehicle | `POST /c/vehicles` |
| Vehicle detail | `GET /c/vehicles/:id` + `PATCH /c/vehicles/:id` |
| Vehicle avatar | `GET /c/vehicles/:id/avatar-upload-url` → upload → `PATCH /c/vehicles/:id/avatar` |
| Vehicle cover | `GET /c/vehicles/:id/cover-upload-url` → upload → `PATCH /c/vehicles/:id/cover` |
| Logbook | `GET /c/vehicles/:id/logbook` |

---

## Notes

**Linking existing customers:** When a customer signs up with an email that exists from a prior workshop booking, their full Rodz service history is immediately visible in the logbook. Show a "Welcome back — your service history is here" message if `entries` is non-empty on first login.

**Logbook token sharing:** Each vehicle has a `logbookToken`. This is a permanent read-only link the customer can share (e.g. when selling the car). The public URL format is `GET /logbook/:token` — this endpoint is already live and returns the same logbook shape above. The customer can regenerate the token via `PATCH /c/vehicles/:id` with `{ "resetLogbookToken": true }` (coming in a later phase).

**Empty logbook:** A customer who just signed up and has no Rodz service history will see `entries: []`. Show an empty state: "Your service history will appear here after your first Rodz visit."

**Vehicle description tips:** When the Gemini parse fails (422), the error message explains what was unclear. Suggested placeholder text for the vehicle input: *"e.g. 2021 Toyota Camry hybrid, 2019 Mazda CX-5 diesel"*
