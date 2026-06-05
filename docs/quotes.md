# Quotes — Frontend Brief

**Base URL:** `https://fzzrkscwd7.execute-api.ap-southeast-2.amazonaws.com`

All staff routes require `Authorization: Bearer <accessToken>`. Public routes (`/q/...`) require no auth.

**Role access:**
- `super_admin` — full access, all stores
- `store_manager` — full access, own store(s) only
- `technician` — can create and edit quotes they own; cannot delete

---

## Full quote creation flow

```
1. GET /catalog                          → load labour/parts catalogue for line item picker
2. GET /customers?search=...             → find customer
3. GET /quotes                           → optional: check for existing draft
4. POST /quotes                          → create quote (customer + vehicle, optional initial items)
5. PATCH /quotes/{id}   (items)          → add/edit line items (replace entire list each time)
6. POST /photos/upload-url → PUT → POST /photos   → attach photos to line items
7. POST /quotes/{id}/send                → email quote to customer; quote moves to "sent"
──────────────────── customer receives email ─────────────────────────────────────────────
8. GET /q/{token}                        → customer views quote (no auth)
9. POST /q/{token}/approve               → customer approves/rejects each line item (no auth)
──────────────────── back to staff ───────────────────────────────────────────────────────
10. PATCH /quotes/{id}  (status:invoiced) → mark as invoiced when work is done
11. PATCH /quotes/{id}  (status:paid)     → mark as paid
```

---

## Step 1 — Load the catalogue

Call once when the quote builder opens and cache the result in state. Use these items to populate the line item picker so staff don't have to type descriptions manually.

```
GET /catalog
GET /catalog?category=labour
GET /catalog?search=brake
Authorization: Bearer <accessToken>
```

### Query parameters

| Param | Type | Notes |
|-------|------|-------|
| `category` | string | Filter by category: `labour`, `part`, or `other`. Omit → all. |
| `search` | string | Partial match on item name. |

### Response `200`

```json
{
  "items": [
    {
      "id": 4,
      "name": "Front Brake Pad Replacement",
      "description": "Replace front brake pads including inspection",
      "category": "labour",
      "type": "labour",
      "hours": 1.5,
      "unitPrice": 180.00
    },
    {
      "id": 12,
      "name": "Brake Pad Set — Front",
      "description": null,
      "category": "part",
      "type": "part",
      "hours": null,
      "unitPrice": 95.00
    }
  ]
}
```

### Catalogue item fields

| Field | Type | Notes |
|-------|------|-------|
| `id` | number | Pass as `catalogItemId` when adding a line item to a quote |
| `name` | string | Use as the default `description` when pre-filling a line item |
| `description` | string \| null | Subtitle for the picker row |
| `category` | `"labour"` \| `"part"` \| `"other"` | Group the picker by this |
| `type` | `"labour"` \| `"part"` \| `"other"` | Drives line item type on the quote |
| `hours` | number \| null | Pre-fill the hours field (labour items only) |
| `unitPrice` | number | Pre-fill the unit price field |

---

## Step 2 — Create the quote

Creates a draft quote. You can optionally include line items on creation, or add them via `PATCH` afterwards. Either approach is fine — create-then-patch is simpler for a multi-step form.

```
POST /quotes
Authorization: Bearer <accessToken>
Content-Type: application/json
```

### Request body

```json
{
  "customerId": 42,
  "vehicleId": 18,
  "storeId": 2,
  "techId": 7,
  "notes": "Customer requested itemised quote before approving",
  "items": [
    {
      "catalogItemId": 4,
      "description": "Front Brake Pad Replacement",
      "type": "labour",
      "hours": 1.5,
      "qty": 1,
      "unitPrice": 180.00
    },
    {
      "catalogItemId": 12,
      "description": "Brake Pad Set — Front",
      "type": "part",
      "hours": null,
      "qty": 1,
      "unitPrice": 95.00
    }
  ]
}
```

### Field rules

| Field | Required | Notes |
|-------|----------|-------|
| `customerId` | Yes | Must be an active customer. |
| `vehicleId` | Yes | Must exist and belong to this customer (current owner). |
| `storeId` | No | Defaults to the caller's primary store. Required for `super_admin`. |
| `techId` | No | Defaults to the caller's staff ID. The staff member who prepared the quote. |
| `notes` | No | Internal notes — visible to staff only, never shown to the customer. |
| `items` | No | Optional array of line items. If omitted, quote is created empty and items added via `PATCH`. |

#### Line item fields (in `items` array)

| Field | Required | Notes |
|-------|----------|-------|
| `description` | Yes | The line item label shown to the customer. |
| `unitPrice` | Yes | Price per unit. |
| `catalogItemId` | No | FK to catalog — links the line item back to the catalogue entry. Pass `null` for custom items. |
| `type` | No | `"labour"` \| `"part"` \| `"other"`. Defaults to `"labour"`. |
| `hours` | No | Labour hours. Used for display only — does not affect price calculation. |
| `qty` | No | Quantity. Defaults to `1`. |

> Line total = `qty × unitPrice`. Subtotal = sum of all line totals. GST = `subtotal × 0.1`. Total = `subtotal + GST`.

### Response `201`

```json
{
  "quote": {
    "id": 31,
    "quoteNumber": "Q-2506-031",
    "customerName": "Karen Walsh",
    "customerEmail": "kwalsh@gmail.com",
    "customerPhone": "0412 345 678",
    "vehicle": "2020 Toyota Camry",
    "rego": "KWA001",
    "store": "Somerville",
    "tech": "J. Howard",
    "status": "draft",
    "notes": "Customer requested itemised quote before approving",
    "token": null,
    "sentAt": null,
    "createdAt": "2026-06-05",
    "subtotal": 275.00,
    "gst": 27.50,
    "total": 302.50,
    "items": [
      {
        "id": 88,
        "catalogItemId": 4,
        "description": "Front Brake Pad Replacement",
        "type": "labour",
        "hours": 1.5,
        "qty": 1,
        "unitPrice": 180.00,
        "approved": null
      },
      {
        "id": 89,
        "catalogItemId": 12,
        "description": "Brake Pad Set — Front",
        "type": "part",
        "hours": null,
        "qty": 1,
        "unitPrice": 95.00,
        "approved": null
      }
    ]
  }
}
```

### Errors

| Status | Code | When |
|--------|------|------|
| `422` | `VALIDATION_ERROR` | `customerId` or `vehicleId` missing |
| `404` | `CUSTOMER_NOT_FOUND` | Customer does not exist or is inactive |
| `404` | `VEHICLE_NOT_FOUND` | Vehicle does not exist or does not belong to this customer |
| `403` | `FORBIDDEN` | Technician role, or `storeId` is outside the caller's accessible stores |

---

## Step 3 — Edit line items

Replaces **all** line items on the quote. Always send the complete desired list — this is not a partial update. Totals are recalculated automatically.

Cannot be called on quotes with status `approved`, `invoiced`, or `paid`.

```
PATCH /quotes/31
Authorization: Bearer <accessToken>
Content-Type: application/json

{
  "items": [
    {
      "catalogItemId": 4,
      "description": "Front Brake Pad Replacement",
      "type": "labour",
      "hours": 1.5,
      "qty": 1,
      "unitPrice": 180.00
    },
    {
      "catalogItemId": 12,
      "description": "Brake Pad Set — Front",
      "type": "part",
      "qty": 1,
      "unitPrice": 95.00
    },
    {
      "catalogItemId": null,
      "description": "Brake fluid flush",
      "type": "labour",
      "hours": 0.5,
      "qty": 1,
      "unitPrice": 60.00
    }
  ]
}
```

You can also update other fields in the same call:

```json
{
  "notes": "Updated after inspection",
  "techId": 9,
  "items": [ ... ]
}
```

### PATCH fields

| Field | Notes |
|-------|-------|
| `items` | Replaces entire item list. Recalculates subtotal/GST/total. |
| `notes` | Internal notes — overwrites existing value. |
| `techId` | Reassign the quote to a different staff member. |
| `status` | Status transition — see [Status transitions](#status-transitions). |

### Response `200`

Returns the full updated quote object (same shape as `POST /quotes` response).

### Errors

| Status | Code | When |
|--------|------|------|
| `422` | `VALIDATION_ERROR` | No valid fields sent |
| `404` | `QUOTE_NOT_FOUND` | Quote does not exist |
| `409` | `QUOTE_LOCKED` | Items cannot be edited — quote is approved, invoiced, or paid |
| `409` | `INVALID_TRANSITION` | Invalid status change |
| `409` | `USE_SEND_ENDPOINT` | Attempted `status: "sent"` — use `POST /quotes/{id}/send` instead |
| `403` | `FORBIDDEN` | Not the quote owner, not a manager, or outside store access |

---

## Step 4 — Attach photos to line items

Call the photo upload flow once per photo, referencing the quote and the specific line item. The `id` values in `quote.items` are the `quoteItemId`.

```
POST /photos/upload-url
→ { uploadUrl, imageId }

PUT {uploadUrl}   (image file, direct to Cloudflare)

POST /photos
{
  "imageId": "a1b2c3d4-...",
  "vehicleRego": "KWA001",
  "quoteId": 31,
  "quoteItemId": 88,
  "caption": "Worn front brake pad — metal on metal"
}
```

See `docs/photos.md` for the full photo upload flow.

---

## Step 5 — Send the quote

Emails the quote to the customer and moves status from `draft` → `sent`. Can also be called on an already-sent quote to resend (e.g. customer didn't receive it) — this resets all per-item approval decisions.

```
POST /quotes/31/send
Authorization: Bearer <accessToken>
```

No request body.

### Response `200`

Returns the full updated quote object. `status` is now `"sent"`, `sentAt` is set, `token` is now a UUID string used to build the approval link.

### Errors

| Status | Code | When |
|--------|------|------|
| `404` | `QUOTE_NOT_FOUND` | Quote does not exist |
| `409` | `QUOTE_NOT_SENDABLE` | Quote is not in `draft` or `sent` status (e.g. already approved) |
| `403` | `FORBIDDEN` | Outside store access |

---

## GET /quotes

Returns all quotes visible to the caller, newest first.

```
GET /quotes
GET /quotes?status=draft
GET /quotes?search=Karen
GET /quotes?store=Somerville&status=sent
Authorization: Bearer <accessToken>
```

### Query parameters

| Param | Type | Notes |
|-------|------|-------|
| `status` | string | `draft` \| `sent` \| `approved` \| `invoiced` \| `paid` \| `rejected`. Omit → all. |
| `search` | string | Partial match on customer name, rego, or quote number (e.g. `"Q-2506"`). |
| `store` | string | `super_admin` only — partial store name filter (e.g. `"Somerville"`). Ignored for other roles. |

### Response `200`

```json
{
  "quotes": [
    {
      "id": 31,
      "quoteNumber": "Q-2506-031",
      "customerName": "Karen Walsh",
      "customerEmail": "kwalsh@gmail.com",
      "customerPhone": "0412 345 678",
      "vehicle": "2020 Toyota Camry",
      "rego": "KWA001",
      "store": "Somerville",
      "tech": "J. Howard",
      "status": "sent",
      "notes": null,
      "token": "c7f3e2a1-...",
      "sentAt": "2026-06-05T02:15:00Z",
      "createdAt": "2026-06-05",
      "subtotal": 275.00,
      "gst": 27.50,
      "total": 302.50,
      "items": [ ... ]
    }
  ]
}
```

---

## GET /quotes/{id}

Returns a single quote by ID.

```
GET /quotes/31
Authorization: Bearer <accessToken>
```

### Response `200`

Same shape as a single object from the list. Items always included.

### Errors

| Status | Code | When |
|--------|------|------|
| `404` | `NOT_FOUND` | Quote does not exist |
| `403` | `FORBIDDEN` | Outside store access |

---

## DELETE /quotes/{id}

Permanently deletes a quote. Only allowed on `draft` quotes.

```
DELETE /quotes/31
Authorization: Bearer <accessToken>
```

No body. **Response `204`** — no content.

### Errors

| Status | Code | When |
|--------|------|------|
| `404` | `QUOTE_NOT_FOUND` | Quote does not exist |
| `409` | `QUOTE_NOT_DELETABLE` | Quote is not a draft |
| `403` | `FORBIDDEN` | Outside store access |

---

## Status transitions

```
draft ──[POST /send]──▶ sent ──────────────▶ approved ──▶ invoiced ──▶ paid
                          │                      ▲
                          └──[PATCH status]──▶ rejected
                                                          (approved via customer link)
```

| From | To | How |
|------|----|-----|
| `draft` | `sent` | `POST /quotes/{id}/send` only — not via PATCH |
| `sent` | `rejected` | `PATCH /quotes/{id}` with `status: "rejected"` |
| `sent` | `approved` | Customer submits `POST /q/{token}/approve` |
| `approved` | `invoiced` | `PATCH /quotes/{id}` with `status: "invoiced"` |
| `invoiced` | `paid` | `PATCH /quotes/{id}` with `status: "paid"` |

Items (line items) can only be edited in `draft` or `sent` status. Once approved, the list is locked.

---

## Customer approval page (public — no auth)

These two endpoints require **no JWT**. They are called from the customer-facing approval page at `{FRONTEND_URL}/q/{token}`.

### GET /q/{token}

Loads the quote for the approval page.

```
GET /q/c7f3e2a1-1234-...
```

### Response `200`

Same quote object shape as the staff endpoints. Items include `approved: null` (not yet decided), `approved: true`, or `approved: false`.

```json
{
  "quote": {
    "id": 31,
    "quoteNumber": "Q-2506-031",
    "customerName": "Karen Walsh",
    "vehicle": "2020 Toyota Camry",
    "rego": "KWA001",
    "store": "Somerville",
    "status": "sent",
    "subtotal": 275.00,
    "gst": 27.50,
    "total": 302.50,
    "items": [
      {
        "id": 88,
        "description": "Front Brake Pad Replacement",
        "type": "labour",
        "hours": 1.5,
        "qty": 1,
        "unitPrice": 180.00,
        "approved": null
      }
    ]
  }
}
```

After loading the quote, also load photos for the approval page:

```
GET /vehicles/{rego}/photos?quoteId={id}
```

Group photos by `quoteItemId` and show them beneath the relevant line item. Photos with `quoteItemId: null` are shown at the quote level.

### Errors

| Status | Code | When |
|--------|------|------|
| `404` | `NOT_FOUND` | Token is invalid or expired |

---

### POST /q/{token}/approve

Customer submits their decisions. Must include **every line item** — partial submission is not supported.

```
POST /q/c7f3e2a1-1234-...
Content-Type: application/json

{
  "items": [
    { "id": 88, "approved": true  },
    { "id": 89, "approved": true  },
    { "id": 90, "approved": false }
  ]
}
```

`id` is the line item ID from `quote.items[].id`. `approved: true` = accepted, `approved: false` = declined.

### Response `200`

Returns the full quote object with updated `approved` values on each item and `status: "approved"`.

### Errors

| Status | Code | When |
|--------|------|------|
| `422` | `VALIDATION_ERROR` | `items` is missing, empty, or contains an ID that doesn't belong to this quote |
| `409` | `ALREADY_PROCESSED` | Quote is not in `sent` status — already approved or rejected |
| `404` | `QUOTE_NOT_FOUND` | Token is invalid |

---

## Quote object — full field reference

| Field | Type | Notes |
|-------|------|-------|
| `id` | number | |
| `quoteNumber` | string | Format `Q-YYMM-NNN` e.g. `"Q-2506-031"`. Display to staff and customers. |
| `customerName` | string | Full name, live-joined |
| `customerEmail` | string \| null | |
| `customerPhone` | string \| null | |
| `vehicle` | string \| null | `"{year} {make} {model}"` |
| `rego` | string \| null | Registration plate — use this as `vehicleRego` in photo calls |
| `store` | string | Store name with `"Rodz "` prefix stripped e.g. `"Somerville"` |
| `tech` | string \| null | Abbreviated staff name e.g. `"J. Howard"` |
| `status` | string | `draft` \| `sent` \| `approved` \| `invoiced` \| `paid` \| `rejected` |
| `notes` | string \| null | Internal notes — never show to the customer |
| `token` | string \| null | UUID set when the quote is first sent. Use for the approval link. |
| `sentAt` | string \| null | UTC ISO-8601 — when the quote was last sent |
| `createdAt` | string | ISO date `YYYY-MM-DD` |
| `subtotal` | number | Sum of all line totals |
| `gst` | number | 10% GST |
| `total` | number | `subtotal + gst` |
| `items` | array | Line items — see below |

### Line item fields

| Field | Type | Notes |
|-------|------|-------|
| `id` | number | Use as `quoteItemId` when attaching photos |
| `catalogItemId` | number \| null | FK to catalogue — null for custom line items |
| `description` | string | Label shown to the customer |
| `type` | `"labour"` \| `"part"` \| `"other"` | |
| `hours` | number \| null | Labour hours — display only |
| `qty` | number | Quantity |
| `unitPrice` | number | Price per unit |
| `approved` | boolean \| null | `null` = pending, `true` = accepted, `false` = declined by customer |

---

## Frontend implementation guide

### Quote builder

The quote builder is a staff-only screen that handles steps 1–5.

**Recommended layout:**

- Left panel — customer + vehicle selector (search existing customers, pick vehicle)
- Main panel — line item list with add/remove/edit
- Right panel — catalogue picker (search or browse by category to pre-fill a line item)
- Footer — totals (subtotal / GST / total), notes field, Send button

**Line item entry:**

1. Staff taps "Add item" → opens the catalogue picker
2. Selecting a catalogue item pre-fills `description`, `type`, `hours`, and `unitPrice`
3. Staff can override any field before confirming
4. Items are saved via `PATCH /quotes/{id}` with the full updated list on each change

Always send the **complete item list** on every PATCH — not a delta. The backend replaces everything.

**Photos on a line item:**

Each line item row should have a camera icon. Tapping it:
1. Calls `POST /photos/upload-url`
2. Opens camera/file picker
3. On confirm, PUTs the image to `uploadUrl`
4. Calls `POST /photos` with `quoteId`, `quoteItemId` (the line item `id`), and `vehicleRego` (from `quote.rego`)
5. Shows the photo thumbnail beneath the line item

Load existing photos for the quote via:

```
GET /vehicles/{rego}/photos?quoteId={id}
```

Then group by `quoteItemId` and render beneath each row.

---

### Quotes list

Show status as a badge: `draft` (grey), `sent` (blue), `approved` (green), `invoiced` (amber), `paid` (green/tick), `rejected` (red).

Use `?status=draft` or `?status=sent` to build filtered views (e.g. a "Pending approval" tab).

Use `?search=` to support searching by customer name, rego, or quote number.

---

### Customer approval page

The approval page lives at `{FRONTEND_URL}/q/{token}` and is loaded without auth.

**On load:**

1. `GET /q/{token}` → load quote
2. `GET /vehicles/{rego}/photos?quoteId={id}` → load photos

**Layout:**

- Quote header: store name, quote number, customer name, vehicle
- For each line item:
  - Description, quantity, unit price, line total
  - Accept / Decline toggle (default unchecked)
  - Photos beneath the item (if any)
- Quote footer: subtotal, GST, total
- Submit button (disabled until all items have a decision)

**On submit:**

```
POST /q/{token}/approve
{
  "items": [
    { "id": 88, "approved": true },
    { "id": 89, "approved": false }
  ]
}
```

All items must be included — even rejected ones. Show a confirmation screen on `200`.

Handle `409 ALREADY_PROCESSED` by showing a "This quote has already been responded to" message rather than an error.
