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

---

## AI Chat

### `POST /c/vehicles/:id/chat`

Sends a message to the AI assistant and returns the full response. The AI has access to the vehicle's full spec, service history, and known issues, and can check availability and book appointments via Gemini function calling.

**Request**
```json
{
  "content": "What oil does my car need?",
  "imageId": "abc123"
}
```

- `content` — the customer's message text (optional if `imageId` is provided)
- `imageId` — Cloudflare image ID for image messages (optional)

**Response — 200**
```json
{
  "userMessageId": 42,
  "messageId":     43,
  "content":       "Your 2021 Toyota Camry takes 5W-30 full synthetic oil (4.5L with filter).",
  "functionCalls": null
}
```

| Field | Description |
|-------|-------------|
| `userMessageId` | DB id of the saved user message |
| `messageId` | DB id of the saved AI response |
| `content` | The AI's full response — render as markdown |
| `functionCalls` | Array of tool calls made, or `null` |

**When the AI uses tools** (booking / availability check), `functionCalls` is populated:

```json
{
  "userMessageId": 44,
  "messageId":     45,
  "content":       "Great — I've booked you in for Thursday 10 July morning at Somerville. Your reference is **HNZV5PVV**.",
  "functionCalls": [
    { "name": "checkAvailability", "result": { "storeName": "Somerville", ... } },
    { "name": "getServiceTypes",   "result": { "services": [...] } },
    { "name": "bookAppointment",   "result": { "bookingRef": "HNZV5PVV", "date": "2026-07-10", "slot": "morning", "store": "Somerville", "confirmed": true } }
  ]
}
```

After receiving the response:
- Show the AI `content` with a typewriter animation
- If `functionCalls` contains a `bookAppointment` entry with `confirmed: true` → show a booking confirmation card (see Notes section)

**What the AI knows:**
- Full vehicle specs (make, model, year, engine, oil type, tyre sizes, etc.)
- Complete Rodz service history with dates, odometer, costs, and AI summaries
- Known issues for the vehicle model
- Upcoming service intervals and due dates

**What the AI can do via function calling:**
- Check real workshop availability for any month
- Present service type options with pricing
- Create a confirmed booking — always confirms details with the customer first

**UX recommendation:**
Show a "Rodz is thinking…" indicator immediately on send. Response arrives in ~2–4 seconds. Apply a typewriter animation to `content` — this gives a natural chat feel without requiring streaming.

**Errors**
- `403 FORBIDDEN` — vehicle doesn't belong to this customer
- `422 VALIDATION_ERROR` — no `content` or `imageId` provided

---

### `GET /c/vehicles/:id/chat`

Returns the full conversation history for this vehicle. Call on mount to prepopulate the chat.

**Response — 200**
```json
{
  "messages": [
    {
      "id":        1,
      "role":      "user",
      "content":   "What oil does my car need?",
      "imageUrl":  null,
      "createdAt": "2026-07-02T10:00:00.000Z"
    },
    {
      "id":        2,
      "role":      "model",
      "content":   "Your 2021 Toyota Camry takes 5W-30 full synthetic oil...",
      "imageUrl":  null,
      "createdAt": "2026-07-02T10:00:02.000Z"
    }
  ]
}
```

- `role` — `"user"` (customer) or `"model"` (AI)
- `imageUrl` — full-size Cloudflare URL if the message had an image, else `null`
- Limited to the last 100 messages

**Empty state:** `messages: []` means no conversation yet. Show conversation starter prompts:

| Label | Message to send |
|-------|----------------|
| Service history | `"Show me my service history"` |
| Upcoming maintenance | `"What maintenance is coming up for my vehicle?"` |
| Vehicle specs | `"Tell me everything about my vehicle's specs"` |
| Market value | `"What's my vehicle worth right now?"` |
| Book a service | `"I'd like to book a service at Rodz"` |
| Diagnose an issue | `"I'm hearing a noise / seeing a warning light — can you help?"` |

---

## Vehicle value

### `GET /c/vehicles/:id/value`

AI-generated market value estimate backed by **live Google Search** — Gemini searches carsales.com.au, Autotrader, and Gumtree in real time. Takes ~8–10 seconds. Show a skeleton loading state.

**Response — 200**
```json
{
  "vehicle": {
    "year":         2021,
    "make":         "Toyota",
    "model":        "Camry",
    "series":       "ASV70R",
    "odometerKm":   42300,
    "serviceCount": 3
  },
  "valuation": {
    "estimatedValueAud": { "low": 28000, "mid": 32000, "high": 35000 },
    "comparableSales": [
      { "price": 31990, "odometer": 38000, "description": "2021 Toyota Camry Ascent Sport Hybrid, 38,000km, VIC" },
      { "price": 29500, "odometer": 51000, "description": "2021 Toyota Camry SL Hybrid, 51,000km, NSW" }
    ],
    "condition": "good",
    "conditionRationale": "Well-maintained with 3 documented Rodz services and below-average kilometres.",
    "keyFactors": [
      { "factor": "Service record", "impact": "positive", "detail": "3 documented Rodz services add buyer confidence." },
      { "factor": "Odometer",       "impact": "neutral",  "detail": "42,300 km is below average for a 2021 model." }
    ],
    "marketInsight": "Current carsales.com.au listings show 2021 Camry Hybrids ranging from $28,000–$36,000 depending on variant and kilometres...",
    "sellTips": [
      "Get a full detail before listing",
      "Highlight the Rodz service record",
      "Price at mid-range and negotiate down"
    ],
    "disclaimer": "This is an estimate based on current Australian listings. Actual sale price will vary based on vehicle condition, location, negotiation, and market timing."
  },
  "sources": [
    "https://www.carsales.com.au/..."
  ],
  "generatedAt": "2026-07-03"
}
```

| Field | Notes |
|-------|-------|
| `estimatedValueAud` | `low` / `mid` / `high` in AUD — render as a range bar |
| `comparableSales` | Up to 4 real current listings. `odometer` may be `null`. Render as "Comparable cars for sale" cards |
| `condition` | `"excellent"` \| `"good"` \| `"fair"` \| `"poor"` |
| `keyFactors[].impact` | `"positive"` \| `"negative"` \| `"neutral"` |
| `sources` | Grounding URLs from the live search — optional to display, label as "Based on current listings" |

---

## Booking endpoints

### `GET /c/stores`

List all active Rodz locations.

**Response — 200**
```json
{
  "stores": [
    {
      "id": 1,
      "name": "Rodz Somerville",
      "address": "123 Frankston-Flinders Rd",
      "suburb": "Somerville",
      "state": "VIC",
      "postcode": "3912",
      "phone": "03 5977 0000",
      "mapsUrl": "https://maps.google.com/?q=..."
    }
  ]
}
```

---

### `GET /c/service-types`

List all bookable service types.

**Response — 200**
```json
{
  "services": [
    {
      "id": 1,
      "name": "Log Book Service",
      "category": "service",
      "description": "Full manufacturer log book service",
      "fixedPrice": null,
      "estimatedHours": 1.5
    }
  ]
}
```

---

### `GET /c/availability?storeId=1&month=2026-07`

Check available slots at a store for a given month.

**Query params:** `storeId` (required), `month` (required, `YYYY-MM`)

**Response — 200**
```json
{
  "storeId": 1,
  "storeName": "Rodz Somerville",
  "month": "2026-07",
  "days": {
    "2026-07-01": { "open": false, "morning": 0, "afternoon": 0 },
    "2026-07-02": { "open": true,  "morning": 2, "afternoon": 3 },
    "2026-07-03": { "open": true,  "morning": 0, "afternoon": 1 }
  }
}
```

`morning`/`afternoon` values are **remaining capacity** (0 = full). `open: false` = closed or in the past.

---

### `GET /c/bookings`

List the customer's bookings (most recent first, excludes cancelled).

**Response — 200**
```json
{
  "bookings": [
    {
      "id": 12,
      "bookingRef": "ABCD1234",
      "date": "2026-07-15",
      "slot": "morning",
      "type": "drop_off",
      "status": "pending",
      "notes": null,
      "store": { "name": "Rodz Somerville", "suburb": "Somerville", "phone": "03 5977 0000" },
      "vehicle": { "id": 7, "make": "Toyota", "model": "Camry", "year": 2021, "rego": "ABC123" },
      "services": "Log Book Service, Brake Inspection"
    }
  ]
}
```

---

### `POST /c/bookings`

Create a booking directly (alternative to booking via chat).

**Request**
```json
{
  "vehicleId":      7,
  "storeId":        1,
  "date":           "2026-07-15",
  "slot":           "morning",
  "type":           "drop_off",
  "serviceTypeIds": [1, 3],
  "notes":          "Please check the squeaking noise from the brakes"
}
```

- `slot` — `"morning"` or `"afternoon"`
- `type` — `"drop_off"` | `"wait"` | `"pickup"`
- `serviceTypeIds` — array of IDs from `GET /c/service-types`

**Response — 201**
```json
{
  "booking": {
    "id": 12,
    "bookingRef": "ABCD1234",
    "date": "2026-07-15",
    "slot": "morning",
    "type": "drop_off",
    "status": "pending",
    "store": { "name": "Rodz Somerville", "suburb": "Somerville" },
    "services": "Log Book Service, Tyre Rotation"
  }
}
```

**Errors**
- `422 VALIDATION_ERROR` — missing or invalid fields
- `404 NOT_FOUND` — store or vehicle not found

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
| **AI Chat** | `POST /c/vehicles/:id/chat` + `GET /c/vehicles/:id/chat` |
| **Logbook** (tab) | `GET /c/vehicles/:id/logbook` |
| **Vehicle value** (tab) | `GET /c/vehicles/:id/value` |
| **Book a service** | `GET /c/stores` + `GET /c/service-types` + `GET /c/availability` + `POST /c/bookings` |
| **My bookings** | `GET /c/bookings` |

---

## Notes

**Linking existing customers:** When a customer signs up with an email that exists from a prior workshop booking, their full Rodz service history is immediately visible in the logbook. Show a "Welcome back — your service history is here" message if `entries` is non-empty on first login.

**Logbook token sharing:** Each vehicle has a `logbookToken`. This is a permanent read-only link the customer can share (e.g. when selling the car). The public URL format is `GET /logbook/:token` — this endpoint is already live and returns the same logbook shape above. The customer can regenerate the token via `PATCH /c/vehicles/:id` with `{ "resetLogbookToken": true }` (coming in a later phase).

**Empty logbook:** A customer who just signed up and has no Rodz service history will see `entries: []`. Show an empty state: "Your service history will appear here after your first Rodz visit."

**Vehicle description tips:** When the Gemini parse fails (422), the error message explains what was unclear. Suggested placeholder text for the vehicle input: *"e.g. 2021 Toyota Camry hybrid, 2019 Mazda CX-5 diesel"*

**Chat is the home screen:** When a customer opens the app (or scans the QR code on their car), the AI chat is the first thing they see. The logbook, vehicle profile, maintenance, and value estimate are tabs within the same vehicle view.

**AI books for you:** The chat AI can check availability and create bookings on the customer's behalf via Gemini function calling. When the response includes a `functionCalls` array, inspect it to determine what the AI did behind the scenes — if it contains a `bookAppointment` entry, show a booking confirmation card with the reference number. While waiting for the response (~2–4s), show a "Rodz is thinking…" indicator; the AI has already executed any tool calls server-side by the time the response arrives.

**Mechanic chats are never visible:** Staff/mechanic chat history (`vehicle_chats` table) is completely separate and is never surfaced to customers under any circumstances.
