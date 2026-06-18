# Invoices — Frontend Integration Brief

All staff endpoints require the standard `Authorization: Bearer <token>` header.

---

## Invoice object

Every endpoint that returns an invoice returns this shape:

```json
{
  "id": 1,
  "invoiceNumber": "INV-2506-001",
  "storeId": 1,
  "store": "Rodz Frankston",
  "staffId": 42,
  "tech": "J. Smith",
  "customerId": 7,
  "customerName": "Jane Doe",
  "customerEmail": "jane@example.com",
  "customerPhone": "0412345678",
  "jobId": 15,
  "quoteId": 9,
  "vehicle": "2018 Toyota Camry",
  "rego": "ABC123",
  "status": "draft",
  "notes": null,
  "odometerIn": 85000,
  "token": null,
  "sentAt": null,
  "paidAt": null,
  "dueDate": null,
  "paymentMethod": null,
  "zellerPaymentUrl": null,
  "subtotal": 450.00,
  "gst": 45.00,
  "total": 495.00,
  "createdAt": "2025-06-18",
  "items": [
    {
      "id": 1,
      "description": "Full service",
      "type": "labour",
      "hours": 1.5,
      "qty": 1,
      "unitPrice": 180.00,
      "sortOrder": 0
    },
    {
      "id": 2,
      "description": "Oil filter",
      "type": "part",
      "hours": null,
      "qty": 1,
      "unitPrice": 270.00,
      "sortOrder": 1
    }
  ]
}
```

**Status lifecycle:** `draft` → `sent` → `paid`

**`tech`** is formatted as `"F. LastName"` (first initial + last name).

**`zellerPaymentUrl`** is set after sending — use it to show the customer's Zeller payment link if present.

---

## Item object

```json
{
  "id": 1,
  "description": "Full service",
  "type": "labour",
  "hours": 1.5,
  "qty": 1,
  "unitPrice": 180.00,
  "sortOrder": 0,
  "photos": [
    {
      "id": 3,
      "imageId": "abc-123",
      "caption": "Before photo",
      "urls": { "thumbnail": "https://...", "public": "https://..." }
    }
  ]
}
```

- `type`: `"labour"` | `"part"` | `"other"`
- `hours`: labour items only — `null` otherwise
- `qty`: parts/other — `null` for labour
- `photos`: attached photos — empty array if none

Totals are computed server-side: `subtotal = sum(qty × unitPrice)`, `gst = subtotal × 10%`, `total = subtotal + gst`.

### Attaching photos to invoice items

Use the existing photo upload flow, passing `invoiceId` and `invoiceItemId`:

```
POST /photos
{
  "imageId": "abc-123",
  "vehicleRego": "ABC123",
  "invoiceId": 1,
  "invoiceItemId": 5,
  "caption": "Optional caption"
}
```

Photos are automatically returned inline on each item in all invoice responses — no separate fetch needed.

---

## Endpoints

### List invoices

```
GET /invoices
```

Returns all invoices the authenticated user can access. Non-`super_admin` users are automatically scoped to their store(s).

**Query params:**

| Param | Description |
|-------|-------------|
| `status` | Filter by status: `draft`, `sent`, `paid` |
| `customerId` | Filter by customer ID |
| `search` | Searches customer name, rego, invoice number |
| `store` | `super_admin` only — filter by store name (partial match) |
| `before` | Cursor — returns invoices with ID less than this value (for pagination) |
| `limit` | Page size — default `25`, max `100` |

**Response `200`:**
```json
{
  "invoices": [ /* Invoice[] */ ],
  "hasMore": true,
  "nextCursor": 42
}
```

**Pagination:** results are newest-first. To load the next page, pass `?before={nextCursor}`. When `hasMore` is `false`, you've reached the end. `nextCursor` is `null` when there are no more pages.

---

### Get invoice

```
GET /invoices/:id
```

**Response `200`:**
```json
{ "invoice": { /* Invoice */ } }
```

**Errors:** `404` if not found or outside the user's store access.

---

### Create invoice (manual)

```
POST /invoices
```

Creates a blank draft invoice. Use this for ad-hoc invoices not tied to a job.

**Body:**
```json
{
  "customerId": 7,
  "vehicleRego": "ABC123",
  "storeId": 1,
  "staffId": 42,
  "notes": "Optional notes",
  "odometerIn": 85000,
  "items": [
    {
      "description": "Full service",
      "type": "labour",
      "hours": 1.5,
      "unitPrice": 180.00,
      "sortOrder": 0
    },
    {
      "description": "Oil filter",
      "type": "part",
      "qty": 1,
      "unitPrice": 270.00,
      "sortOrder": 1
    }
  ]
}
```

**Required:** `customerId`, `vehicleRego`, `storeId`, `staffId`. `items` can be an empty array.

`dueDate` is optional (`"YYYY-MM-DD"`). If omitted, it will be auto-set to 14 days from the send date when `POST /invoices/:id/send` is called.

**Item rules:**
- `type` must be `labour`, `part`, or `other`
- `unitPrice` is required and must be ≥ 0
- `hours` is for labour items; `qty` defaults to `1` if omitted
- `sortOrder` defaults to array index if omitted

**Response `201`:**
```json
{ "invoice": { /* Invoice */ } }
```

---

### Create invoice from job

```
POST /jobs/:id/invoice
```

Generates an invoice from a completed job's approved quote. Copies all accepted quote items. Atomically sets job status → `invoiced` and quote status → `invoiced`.

**Pre-conditions (returns `409` if not met):**

| Code | Reason |
|------|--------|
| `JOB_NOT_COMPLETED` | Job status is not `completed` |
| `NO_QUOTE` | Job has no linked quote |
| `QUOTE_NOT_APPROVED` | Quote status is not `approved` or `converted` |
| `INVOICE_EXISTS` | An invoice already exists for this job |

**Body (optional):**
```json
{
  "notes": "Optional notes",
  "odometerIn": 85000
}
```

If `odometerIn` is omitted, the job's recorded odometer is used.

**Response `201`:**
```json
{ "invoice": { /* Invoice */ } }
```

---

### Update invoice

```
PATCH /invoices/:id
```

All fields are optional. Items can only be replaced on `draft` invoices.

**Body:**
```json
{
  "notes": "Updated notes",
  "odometerIn": 86000,
  "staffId": 43,
  "items": [ /* full replacement — same shape as create */ ]
}
```

- `dueDate` (`"YYYY-MM-DD"`) can be updated on any invoice regardless of status
- Sending `items` on a non-draft invoice returns `409 NOT_DRAFT`
- `notes` / `odometerIn` / `staffId` can be updated regardless of status

**Item update rules:**

Items in the `items` array should include `id` for existing items (the `id` returned when the invoice was loaded). Items without an `id` are treated as new and inserted. Items that exist in the DB but are absent from the payload are deleted — along with any photos attached to them. Items that are present (with their `id`) are updated in place and their attached photos are preserved.

```json
{
  "items": [
    { "id": 1, "description": "Full service", "type": "labour", "hours": 1.5, "unitPrice": 180.00, "sortOrder": 0 },
    { "description": "New part", "type": "part", "qty": 1, "unitPrice": 50.00, "sortOrder": 1 }
  ]
}
```

**Permissions:** technicians can only update invoices where they are the assigned staff.

**Response `200`:**
```json
{ "invoice": { /* Invoice */ } }
```

---

### Delete invoice

```
DELETE /invoices/:id
```

Only `draft` invoices can be deleted. Returns `409 NOT_DRAFT` otherwise.

If the invoice was linked to a job/quote, deleting it resets:
- Job status: `invoiced` → `completed`
- Quote status: `invoiced` → `approved`

**Permissions:** technicians are forbidden.

**Response `200`:**
```json
{ "deleted": true }
```

---

### Send invoice

```
POST /invoices/:id/send
```

Transitions status from `draft` → `sent`. Can only be called once — returns `409 ALREADY_SENT` if already sent.

On send, the API:
1. Generates a unique public token (used in the customer-facing URL)
2. Creates a Zeller payment link (best-effort — invoice is still sent if Zeller fails)
3. Sends the invoice email to the customer

**Body:** none required.

**Response `200`:**
```json
{ "invoice": { /* Invoice — now has token, sentAt, zellerPaymentUrl populated */ } }
```

**Customer view URL:** `{FRONTEND_URL}/invoice/{token}`

---

### Mark paid (manual)

```
POST /invoices/:id/mark-paid
```

Manually marks an invoice as paid. Use this for bank transfer payments or Zeller payments confirmed outside the webhook.

**Permissions:** technicians are forbidden.

**Body:**
```json
{
  "paymentMethod": "bank_transfer"   // "bank_transfer" | "zeller"
}
```

**Errors:**
- `409 ALREADY_PAID` — invoice is already paid
- `422` — invalid or missing `paymentMethod`

**Response `200`:**
```json
{ "invoice": { /* Invoice — status: "paid", paidAt and paymentMethod set */ } }
```

---

## Public customer endpoint (no auth)

### View invoice

```
GET /i/:token
```

Token is the 64-char hex value set when the invoice is sent. This is the URL the customer opens from their email.

**Response `200`:**
```json
{
  "invoice": { /* Invoice */ },
  "bankDetails": {
    "accountName": "Rodz Automotive Pty Ltd",
    "bsb": "063-000",
    "accountNumber": "12345678",
    "reference": "RODZ INV-2506-001"
  }
}
```

`bankDetails.reference` is the business reference prefix (from Settings) with the invoice number appended.

If bank details haven't been configured in Settings, all `bankDetails` fields return as empty strings — omit the bank transfer section in the UI in that case.

---

## Webhook (internal — Zeller)

```
POST /webhooks/zeller
```

Zeller calls this when a payment completes. No auth header — verified via HMAC-SHA256 signature on the request body. Marks the matching invoice as paid automatically.

> This is handled entirely server-side. No frontend action needed.

---

## UI flows

### Invoice list page

- `GET /invoices` — fetch all, default no filter
- Filter bar: status tabs (`All`, `Draft`, `Sent`, `Paid`), search input, store picker (super_admin only)
- Each row: invoice number, customer, rego, vehicle, total, status badge, date

### Invoice detail / edit

- `GET /invoices/:id` on load
- Edit notes, odometer, staff, line items → `PATCH /invoices/:id` (draft only for items)
- **Send** button → `POST /invoices/:id/send` → show confirmation, update status badge
- **Mark Paid** button → `POST /invoices/:id/mark-paid` → prompt for payment method
- **Delete** button (draft only) → `DELETE /invoices/:id`

### Create invoice from job

- Show **"Create Invoice"** button on a job card when: `job.status === 'completed'` and `job.quoteId` is set
- On click → `POST /jobs/:id/invoice` — no form needed unless you want to override notes/odometer
- On success, redirect to the new invoice detail

### Customer-facing view (`/invoice/:token`)

- `GET /i/:token` — no auth
- Show invoice items, totals, business details
- If `invoice.zellerPaymentUrl` is set → **"Pay Now"** button linking to Zeller
- If `bankDetails.accountName` is non-empty → show bank transfer details with `bankDetails.reference`
- If `invoice.status === 'paid'` → show paid confirmation, hide payment options

---

## Error codes

| HTTP | Code | Meaning |
|------|------|---------|
| 404 | — | Invoice not found or outside your store access |
| 409 | `ALREADY_SENT` | Invoice already sent — cannot send again |
| 409 | `ALREADY_PAID` | Invoice already paid |
| 409 | `NOT_DRAFT` | Items can only be edited on draft invoices |
| 409 | `JOB_NOT_COMPLETED` | Job must be completed before invoicing |
| 409 | `NO_QUOTE` | Job has no linked quote |
| 409 | `QUOTE_NOT_APPROVED` | Quote must be approved or converted |
| 409 | `INVOICE_EXISTS` | Invoice already exists for this job |
| 422 | — | Validation error — see `message` field |
