# Customer Vehicle Logbook — Frontend Implementation Brief

The vehicle logbook is a combined timeline of every service event in the vehicle's life: jobs completed at a Rodz workshop **plus** any external invoices the customer has imported themselves. Customers can photograph past paper invoices or receipts and Rod (AI) extracts the details automatically.

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

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET`   | `/c/vehicles/:id/logbook` | Customer JWT | Full merged timeline (Rodz jobs + external entries) |
| `GET`   | `/c/vehicles/:id/logbook/upload-url` | Customer JWT | Get Cloudflare upload URL for an invoice photo |
| `POST`  | `/c/vehicles/:id/logbook/import` | Customer JWT | AI-scan an uploaded invoice and create an external entry |
| `PATCH` | `/c/vehicles/:id/logbook/external/:entryId` | Customer JWT | Edit/correct an external entry |
| `DELETE`| `/c/vehicles/:id/logbook/external/:entryId` | Customer JWT | Remove an external entry |

> **Backend note:** `GET /c/vehicles/:id/logbook` currently returns Rodz workshop jobs only. The Phase 3 import endpoints and the external-entry merge into the logbook response are not yet built. Both are required before this page can go live.

---

## Fetch the logbook

### `GET /c/vehicles/:id/logbook`

Call on mount. Returns vehicle info and the full merged service timeline sorted newest first.

**Response — 200**
```json
{
  "vehicle": {
    "id":                 4,
    "rego":               "LWF251",
    "make":               "Suzuki",
    "model":              "Vitara",
    "year":               2017,
    "odometerKm":         87400,
    "nextServiceDueKm":   90000,
    "nextServiceDueDate": null
  },
  "entries": [
    {
      "id":            "job-12",
      "source":        "workshop",
      "date":          "2026-06-18",
      "odometerKm":    87400,
      "title":         "Full service — oil, filters, brake inspection",
      "workshop":      "Frankston Rodz",
      "tech":          "N. Rodda",
      "cost":          385.00,
      "status":        "paid",
      "invoiceId":     12,
      "invoiceNumber": "INV-2606-001",
      "invoiceUrl":    "https://workshop.rodz.com.au/invoice/...",
      "aiSummary":     "Your Suzuki Vitara received a full service at Frankston, including oil and filter change, brake inspection, and air filter replacement.",
      "imageUrl":      null,
      "photos": [
        {
          "id": 42,
          "imageId": "f72abd6a-...",
          "caption": null,
          "urls": {
            "thumbnail": "https://imagedelivery.net/.../thumbnail",
            "public":    "https://imagedelivery.net/.../public"
          }
        }
      ],
      "lineItems": [
        { "type": "labour", "description": "Full Service",     "quantity": 1, "unitPrice": 220.00 },
        { "type": "part",   "description": "Oil Filter",       "quantity": 1, "unitPrice": 28.00  },
        { "type": "part",   "description": "Air Filter",       "quantity": 1, "unitPrice": 45.00  }
      ]
    },
    {
      "id":            "ext-3",
      "source":        "external",
      "date":          "2024-11-03",
      "odometerKm":    72000,
      "title":         "Full service — oil, filter, spark plugs, brake inspection",
      "workshop":      "Frankston Automotive",
      "tech":          null,
      "cost":          385.00,
      "status":        null,
      "invoiceId":     null,
      "invoiceNumber": "INV-2241",
      "invoiceUrl":    null,
      "aiSummary":     "Full service — oil, filter, spark plugs, brake inspection",
      "imageUrl":      "https://imagedelivery.net/.../public",
      "photos":        [],
      "lineItems":     []
    }
  ]
}
```

### Entry field reference

| Field | Type | Notes |
|-------|------|-------|
| `id` | string | Prefixed: `"job-{n}"` for Rodz jobs, `"ext-{n}"` for external entries |
| `source` | string | `"workshop"` (Rodz) or `"external"` (customer imported) |
| `date` | string | `YYYY-MM-DD` |
| `odometerKm` | number \| null | Odometer at time of service |
| `title` | string | First sentence of `aiSummary`, or invoice number as fallback |
| `workshop` | string \| null | Workshop / garage name |
| `tech` | string \| null | Technician — only set on Rodz jobs |
| `cost` | number \| null | Total amount paid |
| `status` | string \| null | `"paid"` / `"sent"` for Rodz jobs; `null` for external entries |
| `invoiceId` | number \| null | Rodz invoice ID — only on `source: "workshop"` |
| `invoiceNumber` | string \| null | Invoice number |
| `invoiceUrl` | string \| null | Deep link to Rodz invoice — only on `source: "workshop"` |
| `aiSummary` | string \| null | AI plain-English summary of work done |
| `imageUrl` | string \| null | Scanned invoice photo — only on `source: "external"` |
| `photos` | array | Workshop photos — only on `source: "workshop"` |
| `lineItems` | array | Invoice line items — only on `source: "workshop"` |

---

## Import an external invoice

Adding a past invoice is a three-step flow: **upload → scan → review & save.**

```
1. GET  /c/vehicles/:id/logbook/upload-url    →  { uploadUrl, imageId }
2. PUT  uploadUrl  (Cloudflare direct upload)
3. POST /c/vehicles/:id/logbook/import  { imageId }  →  extracted fields
4. Show pre-filled review form
5. Customer confirms or corrects → entry is saved (no separate confirm call needed — import saves immediately)
6. If edits needed → PATCH /c/vehicles/:id/logbook/external/:entryId
```

---

### Step 1 — Get upload URL

`GET /c/vehicles/:id/logbook/upload-url`

No request body.

**Response — 200**
```json
{
  "uploadUrl": "https://upload.imagedelivery.net/...",
  "imageId":   "abc123-..."
}
```

---

### Step 2 — Upload to Cloudflare

```javascript
const form = new FormData()
form.append('file', imageFile)

await fetch(uploadUrl, {
  method: 'POST',
  body: form,
  // Do NOT set Content-Type — let fetch set it with the multipart boundary
})
```

Wait for the upload to complete before calling import.

---

### Step 3 — Scan and import

`POST /c/vehicles/:id/logbook/import`

**Request body**
```json
{ "imageId": "abc123-..." }
```

**Response — 200 (successful extraction)**
```json
{
  "id":            5,
  "status":        "extracted",
  "workshopName":  "Frankston Automotive",
  "workshopSuburb":"Frankston",
  "serviceDate":   "2024-11-03",
  "odometerKm":    72000,
  "services":      "Full service — oil, filter, spark plugs, brake inspection",
  "amountAud":     385.00,
  "invoiceNumber": "INV-2241",
  "imageUrl":      "https://imagedelivery.net/...public"
}
```

**Response — 200 (extraction failed)**
```json
{
  "id":            6,
  "status":        "failed",
  "workshopName":  null,
  "workshopSuburb":null,
  "serviceDate":   null,
  "odometerKm":    null,
  "services":      null,
  "amountAud":     null,
  "invoiceNumber": null,
  "imageUrl":      "https://imagedelivery.net/...public"
}
```

The entry is saved immediately on import — the `id` returned is the `entryId` used for subsequent PATCH/DELETE calls. Open the review form whether extraction succeeded or failed.

**Status values**

| Value | Action |
|-------|--------|
| `extracted` | Pre-fill form fields from the response. Show a "Please check the details" prompt. |
| `failed` | Open blank form. Show "We couldn't read this invoice — please enter the details." The photo is still attached. |

---

### Step 4 — Review form (edit if needed)

Show a form pre-filled with the extracted values. All fields are optional — the customer can correct anything or leave a field blank.

| Field | Input type | Notes |
|-------|-----------|-------|
| Workshop name | Text | |
| Suburb | Text | |
| Date of service | Date picker | |
| Odometer at service | Number | |
| Work done | Multiline text | Maps to `services` |
| Amount paid | Currency | |
| Invoice number | Text | Optional |

Show a thumbnail of the scanned invoice at the top of the form so the customer can refer to it while filling in details.

If the customer closes the form without editing, the entry is already saved as-is from the import response — no extra call needed.

---

### Edit an external entry

`PATCH /c/vehicles/:id/logbook/external/:entryId`

All fields optional — only send what changed.

**Request body**
```json
{
  "workshopName":  "Frankston Automotive",
  "workshopSuburb":"Frankston",
  "serviceDate":   "2024-11-03",
  "odometerKm":    72000,
  "services":      "Full service — oil, filter, spark plugs, brake inspection",
  "amountAud":     385.00,
  "invoiceNumber": "INV-2241"
}
```

**Response — 200**
```json
{
  "id":            5,
  "workshopName":  "Frankston Automotive",
  "workshopSuburb":"Frankston",
  "serviceDate":   "2024-11-03",
  "odometerKm":    72000,
  "services":      "Full service — oil, filter, spark plugs, brake inspection",
  "amountAud":     385.00,
  "invoiceNumber": "INV-2241",
  "imageUrl":      "https://imagedelivery.net/...public",
  "status":        "extracted"
}
```

**Errors**
- `404 NOT_FOUND` — entry doesn't exist or belongs to another customer
- `403 FORBIDDEN` — vehicle doesn't belong to this customer

---

### Delete an external entry

`DELETE /c/vehicles/:id/logbook/external/:entryId`

No request body.

**Response — 200**
```json
{ "deleted": true }
```

The scanned invoice photo is deleted from Cloudflare automatically.

---

## Workshop expenses → logbook (automatic)

When a customer logs a **workshop expense** in the expense tracker (category = `workshop`), the entry is automatically written to the logbook — no separate action needed. The expense scan extracts the same fields (workshop name, date, odometer, cost, work summary) and both records are created simultaneously.

From the customer's point of view: they scan the invoice once in the expense tracker and it appears in both their running cost history and their service logbook. You do not need to build a separate "also add to logbook" toggle.

---

## Suggested UI

### Logbook screen

**Header:** Vehicle name + rego. Odometer if available (e.g. "87,400 km"). Next service due if set.

**"Import invoice" button:** Prominent in the header or as a FAB. Opens the import flow.

**Timeline list:** Entries sorted newest first. Each card shows:

| For `source: "workshop"` (Rodz jobs) | For `source: "external"` (imported) |
|--------------------------------------|--------------------------------------|
| Rodz logo or "R" badge | Camera icon or "Imported" badge |
| Date + workshop name | Date + workshop name |
| `aiSummary` as the primary description | `services` as the primary description |
| Cost | Cost |
| "View Invoice" link if `invoiceUrl` is set | Thumbnail of scanned invoice if `imageUrl` is set |
| Photos grid | — |
| Line items (collapsible) | — |
| Not editable | Edit / Delete actions (swipe or long-press) |

**Empty state:** "No service history yet. Import a past invoice to get started, or visit a Rodz workshop and your job will appear here automatically."

### Import flow

1. Tap "Import invoice"
2. Camera opens (or photo library picker on iOS/Android)
3. Show upload progress indicator
4. Show "Scanning invoice…" spinner during the import call
5. Review form opens pre-filled (or blank if `status: "failed"`)
6. Customer taps "Save" → PATCH if they changed anything, or dismiss if unchanged
7. Navigate back to logbook — new entry appears at the correct position in the timeline

---

## Differentiating entry types visually

Rodz jobs are verified by the workshop. External entries are customer self-reported. Make this distinction clear without being heavy-handed:

- **Rodz jobs:** Subtle "Verified by Rodz" badge or checkmark
- **External entries:** Camera / receipt icon. Tapping it opens the scanned invoice image in a lightbox.
- Use the same card shape — the distinction should be secondary to the content

---

## Errors reference

| Status | Code | When |
|--------|------|------|
| `403` | `FORBIDDEN` | Vehicle doesn't belong to this customer |
| `404` | `NOT_FOUND` | Vehicle or entry not found |
| `422` | `VALIDATION_ERROR` | `imageId` missing on import call |
