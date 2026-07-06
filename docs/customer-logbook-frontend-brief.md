# Customer Vehicle Logbook — Frontend Implementation Brief

The logbook is a unified timeline of every service event in the life of a vehicle. It combines jobs completed at a Rodz workshop with invoices the customer has imported themselves from other garages. Customers photograph a past paper invoice, Rod (AI) extracts the details, and the entry appears in the same timeline as their Rodz history.

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
| `GET`    | `/c/vehicles/:id/logbook` | Full merged timeline — Rodz jobs + imported entries |
| `GET`    | `/c/vehicles/:id/logbook/upload-url` | Get Cloudflare upload URL for an invoice photo |
| `POST`   | `/c/vehicles/:id/logbook/import` | AI-scan an uploaded invoice and save the entry |
| `PATCH`  | `/c/vehicles/:id/logbook/external/:entryId` | Edit a customer-imported entry |
| `DELETE` | `/c/vehicles/:id/logbook/external/:entryId` | Delete a customer-imported entry |

---

## Get the logbook

### `GET /c/vehicles/:id/logbook`

Call on mount. Returns vehicle metadata and all entries sorted newest first. Rodz jobs and customer-imported entries use the same shape — use the `source` field to differentiate them.

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
      "date":          "2026-06-25",
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
        { "type": "labour", "description": "Full Service", "quantity": 1, "unitPrice": 220.00 },
        { "type": "part",   "description": "Oil Filter",   "quantity": 1, "unitPrice": 28.00  },
        { "type": "part",   "description": "Air Filter",   "quantity": 1, "unitPrice": 45.00  }
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

### Entry fields

| Field | Type | Notes |
|-------|------|-------|
| `id` | string | `"job-{n}"` for Rodz jobs, `"ext-{n}"` for imported entries |
| `source` | string | `"workshop"` or `"external"` |
| `date` | string \| null | `YYYY-MM-DD`. Can be `null` on external entries if not yet edited. |
| `odometerKm` | number \| null | Odometer at time of service |
| `title` | string | First sentence of `aiSummary`, or invoice number, or `"Service"` as final fallback |
| `workshop` | string \| null | Workshop or garage name |
| `tech` | string \| null | Technician name — Rodz jobs only |
| `cost` | number \| null | Total amount paid |
| `status` | string \| null | `"paid"` or `"sent"` for Rodz jobs; `null` for external entries |
| `invoiceId` | number \| null | Rodz invoice ID — Rodz jobs only |
| `invoiceNumber` | string \| null | Invoice or job number |
| `invoiceUrl` | string \| null | Deep link to Rodz invoice page — Rodz jobs only |
| `aiSummary` | string \| null | AI plain-English summary — set on Rodz jobs; also used for `services` on external entries |
| `imageUrl` | string \| null | Scanned invoice photo URL — external entries only |
| `photos` | array | Workshop job photos — Rodz jobs only |
| `lineItems` | array | Invoice line items — Rodz jobs only |

### `lineItems[]` fields

| Field | Type | Notes |
|-------|------|-------|
| `type` | string | `"part"` \| `"labour"` \| `"other"` |
| `description` | string | |
| `quantity` | number | |
| `unitPrice` | number | Retail price — safe to display |

### `photos[]` fields

| Field | Type | Notes |
|-------|------|-------|
| `id` | number | |
| `imageId` | string | Cloudflare image ID |
| `caption` | string \| null | |
| `urls.thumbnail` | string | Use in photo grid |
| `urls.public` | string | Use in lightbox |

---

## Import an external invoice

Three steps: **upload → scan → review.**

```
1. GET  /c/vehicles/:id/logbook/upload-url
         → { uploadUrl, imageId }

2. POST  uploadUrl  with FormData  (direct to Cloudflare — no auth header)
         → wait for 200 before continuing

3. POST /c/vehicles/:id/logbook/import  { imageId }
         → { id, status, workshopName, serviceDate, ... }

4. Open review form pre-filled with extracted fields
   Entry is already saved — id is the entryId for PATCH/DELETE

5. Customer edits anything → PATCH /c/vehicles/:id/logbook/external/:entryId
```

---

### Step 1 — Get upload URL

`GET /c/vehicles/:id/logbook/upload-url`

No body. Save both values — you need `uploadUrl` for the upload and `imageId` for the import call.

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
form.append('file', imageFile)   // File from camera or photo library

await fetch(uploadUrl, {
  method: 'POST',
  body: form,
  // Do NOT manually set Content-Type — fetch sets it automatically
  // with the multipart boundary. Setting it manually breaks the upload.
})
```

Wait for the fetch to resolve with a 200 before calling import.

---

### Step 3 — Scan and import

`POST /c/vehicles/:id/logbook/import`

**Request body**
```json
{ "imageId": "abc123-..." }
```

**Response — 200 (extraction succeeded)**
```json
{
  "id":             5,
  "status":         "extracted",
  "workshopName":   "Frankston Automotive",
  "workshopSuburb": "Frankston",
  "serviceDate":    "2024-11-03",
  "odometerKm":     72000,
  "services":       "Full service — oil, filter, spark plugs, brake inspection",
  "amountAud":      385.00,
  "invoiceNumber":  "INV-2241",
  "imageUrl":       "https://imagedelivery.net/...public"
}
```

**Response — 200 (extraction failed — illegible image or wrong image type)**
```json
{
  "id":             6,
  "status":         "failed",
  "workshopName":   null,
  "workshopSuburb": null,
  "serviceDate":    null,
  "odometerKm":     null,
  "services":       null,
  "amountAud":      null,
  "invoiceNumber":  null,
  "imageUrl":       "https://imagedelivery.net/...public"
}
```

Always returns 200 — never returns an error for a failed extraction. The entry is saved either way. `id` is the `entryId` for all subsequent PATCH/DELETE calls.

| `status` | What to show |
|----------|-------------|
| `extracted` | Pre-fill form. Show "Please check the details before saving." |
| `failed` | Open blank form. Show "We couldn't read this image — please enter the details manually." The photo is still attached. |

**Errors**
- `422 VALIDATION_ERROR` — `imageId` missing, or image hasn't finished uploading yet (retry after a short delay)
- `403 FORBIDDEN` — vehicle doesn't belong to this customer

---

### Step 4 — Review form

Show a bottom sheet or screen with all extracted fields editable. The invoice photo thumbnail appears at the top so the customer can cross-check against it.

| Field label | API field | Input |
|-------------|-----------|-------|
| Workshop name | `workshopName` | Text |
| Suburb | `workshopSuburb` | Text |
| Date of service | `serviceDate` | Date picker (`YYYY-MM-DD`) |
| Odometer | `odometerKm` | Number |
| Work done | `services` | Multiline text |
| Amount paid | `amountAud` | Currency / decimal |
| Invoice number | `invoiceNumber` | Text (optional) |

**If the customer taps Save with no changes:** the entry is already saved from the import response — no API call needed. Just close the form and reload the logbook.

**If the customer edits any field:** call `PATCH /c/vehicles/:id/logbook/external/:entryId` with only the changed fields.

**If the customer taps Cancel / discards:** the entry is already saved (with whatever AI extracted). It will appear in the logbook. This is acceptable — they can edit it later from the logbook.

---

## Edit an imported entry

`PATCH /c/vehicles/:id/logbook/external/:entryId`

Send only the fields you want to change. All optional.

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

To explicitly clear a field, send it as `null`:
```json
{ "invoiceNumber": null }
```

**Response — 200**
```json
{
  "id":             5,
  "workshopName":   "Frankston Automotive",
  "workshopSuburb": "Frankston",
  "serviceDate":    "2024-11-03",
  "odometerKm":     72000,
  "services":       "Full service — oil, filter, spark plugs, brake inspection",
  "amountAud":      385.00,
  "invoiceNumber":  "INV-2241",
  "imageUrl":       "https://imagedelivery.net/...public",
  "status":         "extracted"
}
```

**Errors**
- `403 FORBIDDEN` — vehicle doesn't belong to this customer
- `404 NOT_FOUND` — entry not found or belongs to another customer
- `422 VALIDATION_ERROR` — `serviceDate` not in `YYYY-MM-DD` format

---

## Delete an imported entry

`DELETE /c/vehicles/:id/logbook/external/:entryId`

No body.

**Response — 200**
```json
{ "deleted": true }
```

The invoice photo is deleted from Cloudflare automatically. Rodz workshop jobs cannot be deleted — only external entries.

**Errors**
- `403 FORBIDDEN` — vehicle doesn't belong to this customer
- `404 NOT_FOUND` — entry not found

---

## Workshop expenses → logbook (automatic)

When a customer logs a **workshop expense** in the expense tracker (category = `workshop`), a logbook entry is written automatically in the background — the customer doesn't need to do anything separately. Scanning a workshop invoice once in the expense tracker puts it in both the expense history and the logbook.

You do not need a "also add to logbook" toggle or a separate import flow for expenses — it happens silently.

---

## Suggested UI

### Logbook screen layout

**Header strip**
- Vehicle make, model, year
- Current odometer (if set): e.g. "87,400 km"
- Next service due km or date (if set) — show as an amber chip: "Service due at 90,000 km"

**Action button**
- "Import past invoice" — prominent button or FAB. Triggers the import flow.

**Timeline**
- Chronological list, newest at top
- One card per entry
- Group by year with a year divider label if the list spans multiple years

---

### Entry cards

**Rodz workshop job card**

```
┌─────────────────────────────────────────┐
│ ✓ Rodz  ·  25 Jun 2026      87,400 km  │
│ Frankston Rodz · N. Rodda               │
│                                         │
│ Full service — oil, filters, brake      │
│ inspection and air filter replacement.  │
│                                         │
│ [photo] [photo]           $385  INV-001 │
│ ▸ View Invoice    ▸ See line items      │
└─────────────────────────────────────────┘
```

- Rodz checkmark badge (verified)
- `tech` shown if present
- `aiSummary` as the body
- Photo thumbnails in a small row — tap to open lightbox
- "View Invoice" link if `invoiceUrl` is set
- "See line items" expander for `lineItems`
- Not editable or deletable

**Customer-imported entry card**

```
┌─────────────────────────────────────────┐
│ 📷 Imported  ·  3 Nov 2024   72,000 km │
│ Frankston Automotive                    │
│                                         │
│ Full service — oil, filter, spark       │
│ plugs, brake inspection.                │
│                                         │
│ [invoice thumbnail]         $385        │
└─────────────────────────────────────────┘
```

- Camera / receipt badge (customer self-reported)
- Invoice thumbnail if `imageUrl` is set — tap to view full image in lightbox
- No "View Invoice" link, no line items, no tech
- Swipe left (or long-press) to reveal Edit / Delete actions

---

### Import flow (step by step)

1. Customer taps "Import past invoice"
2. Show two options: **Take photo** / **Choose from library**
3. After image is selected — show upload progress bar
4. On upload complete — call import, show "Scanning invoice…" with a spinner
5. Import returns → open review sheet:
   - Invoice thumbnail at top
   - All fields pre-filled (or empty if `status: "failed"`)
   - If `status: "failed"` show: *"We couldn't read this image. Please fill in the details."*
   - If `status: "extracted"` show: *"Please check the details below."*
6. Customer reviews, edits if needed, taps **Save**
   - If no changes: close sheet (entry already saved, no call needed)
   - If changes: `PATCH` with changed fields, then close
7. Logbook reloads — new entry appears in timeline at the correct date position

---

### Empty states

| Scenario | Message |
|----------|---------|
| No entries at all | "No service history yet. Import a past invoice to get started, or visit a Rodz workshop and your job will appear here automatically." |
| Only Rodz jobs, no imported entries | Show normal list — no empty state needed |
| Import failed (blank form) | "We couldn't read this image — please enter the details manually." |

---

## Errors reference

| Status | Code | When |
|--------|------|------|
| `403` | `FORBIDDEN` | Vehicle doesn't belong to this customer |
| `404` | `NOT_FOUND` | Vehicle not found, or entry not found / belongs to another customer |
| `422` | `VALIDATION_ERROR` | `imageId` missing on import, or `serviceDate` not in `YYYY-MM-DD` format |
