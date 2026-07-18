# Vehicle Expense Tracker — Frontend Implementation Brief

Track every cost associated with owning a vehicle — fuel, servicing, registration, insurance, tolls, and more. Customers can log expenses manually or by photographing a receipt (AI auto-fills the fields). The tracker generates annual running cost reports and tax-ready CSV exports.

**Premium feature.** Only available to customers with an active subscription.

---

## Base URL

```
https://fzzrkscwd7.execute-api.ap-southeast-2.amazonaws.com
```

All endpoints require a customer JWT:

```
Authorization: Bearer <customer_jwt>
```

All expense endpoints are scoped to a vehicle:
```
/c/vehicles/:id/expenses
```

---

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET`    | `/c/vehicles/:id/expenses/upload-url` | Get Cloudflare upload URL for a receipt photo |
| `POST`   | `/c/vehicles/:id/expenses/scan` | AI-scan an uploaded receipt image |
| `GET`    | `/c/vehicles/:id/expenses` | List expenses with optional filters |
| `POST`   | `/c/vehicles/:id/expenses` | Create an expense |
| `PATCH`  | `/c/vehicles/:id/expenses/:expenseId` | Update an expense |
| `DELETE` | `/c/vehicles/:id/expenses/:expenseId` | Delete an expense |
| `GET`    | `/c/vehicles/:id/expenses/summary` | Aggregated annual stats and fuel efficiency |
| `GET`    | `/c/vehicles/:id/expenses/export` | Download all expenses as a CSV file |

---

## Reference data

### Category values and display labels

| Value | Display label | Icon suggestion |
|-------|--------------|-----------------|
| `fuel` | Fuel | ⛽ |
| `ev_charging` | EV Charging | ⚡ |
| `workshop` | Workshop / Service | 🔧 |
| `parts` | Parts | 🔩 |
| `car_wash` | Car Wash | 🫧 |
| `parking` | Parking | 🅿️ |
| `tolls` | Tolls | 🛣️ |
| `registration` | Registration | 📋 |
| `insurance` | Insurance | 🛡️ |
| `roadside` | Roadside Assist | 🚨 |
| `other` | Other | 📄 |

### Fuel type values and display labels

| Value | Display label |
|-------|--------------|
| `unleaded_91` | 91 Unleaded |
| `unleaded_95` | 95 Unleaded |
| `unleaded_98` | 98 Unleaded |
| `diesel` | Diesel |
| `lpg` | LPG |
| `e10` | E10 |

### Extraction status values

| Value | Meaning |
|-------|---------|
| `manual` | Customer entered the expense manually (no photo) |
| `extracted` | Fields were populated from a scanned receipt |
| `failed` | Scan was attempted but AI could not read the image |

---

## Add expense flow

There are two paths to adding an expense:

### Path A — Manual entry
Customer taps "Add expense" → fills in the form → taps save → `POST /c/vehicles/:id/expenses`.

### Path B — Scan a receipt (recommended)

Three steps: **upload → scan → review & save.**

```
1. GET  /c/vehicles/:id/expenses/upload-url   →  { uploadUrl, imageId }
2. PUT  uploadUrl  (direct to Cloudflare, with the image file)
3. POST /c/vehicles/:id/expenses/scan  { imageId }  →  extracted fields
4. Show pre-filled form for customer to review / correct
5. POST /c/vehicles/:id/expenses  (with imageId + confirmed fields)
```

---

## Step 1 — Get upload URL

### `GET /c/vehicles/:id/expenses/upload-url`

No request body.

**Response — 200**
```json
{
  "uploadUrl": "https://upload.imagedelivery.net/...",
  "imageId":   "abc123-..."
}
```

Save the `imageId` — you'll need it for the scan call and again when creating the expense.

---

## Step 2 — Upload to Cloudflare

```javascript
// Upload the image file directly to Cloudflare
const form = new FormData()
form.append('file', imageFile)  // File from camera or photo library

await fetch(uploadUrl, {
  method: 'POST',
  body: form,
  // Do NOT set Content-Type — let fetch set it with the multipart boundary
})
```

Wait for the upload to complete before calling scan.

---

## Step 3 — Scan the receipt

### `POST /c/vehicles/:id/expenses/scan`

**Request body**
```json
{ "imageId": "abc123-..." }
```

**Response — 200 (successful extraction)**
```json
{
  "imageId":        "abc123-...",
  "classification": "fuel_receipt",
  "confidence":     "high",
  "extracted": {
    "category":       "fuel",
    "merchantName":   "BP Frankston",
    "merchantSuburb": "Frankston",
    "merchantState":  "VIC",
    "amountAud":      85.40,
    "expenseDate":    "2026-07-06",
    "odometerKm":     null,
    "fuelType":       "unleaded_95",
    "fuelLitres":     42.700,
    "pricePerLitre":  2.000,
    "evKwh":          null,
    "pricePerKwh":    null,
    "allFuelPrices":  null,
    "notes":          null
  }
}
```

**Response — 200 (unclear image)**
```json
{
  "imageId":        "abc123-...",
  "classification": "unclear",
  "confidence":     "low",
  "extracted":      null
}
```

**Classification values**

| Value | Meaning |
|-------|---------|
| `fuel_receipt` | Petrol station receipt |
| `ev_receipt` | EV charging receipt |
| `pump_photo` | Photo of a fuel price board (no personal expense — multiple prices extracted) |
| `workshop_invoice` | Workshop or mechanic invoice |
| `parts_receipt` | Auto parts purchase |
| `car_wash_receipt` | Car wash receipt |
| `parking_receipt` | Parking receipt or ticket |
| `toll_receipt` | Toll or e-tag statement |
| `insurance_receipt` | Insurance receipt/renewal |
| `registration_receipt` | Rego renewal |
| `other_receipt` | Other recognisable receipt |
| `unclear` | Could not read the image |

**Handling scan results**

| Scenario | Action |
|----------|--------|
| `confidence: "high"` | Pre-fill form, show a success toast. Customer can still edit. |
| `confidence: "medium"` | Pre-fill form with a "Please check the details" notice. Highlight any null fields. |
| `confidence: "low"` | Pre-fill what was found, show a warning. Prompt customer to review everything carefully. |
| `classification: "unclear"` | `extracted` is `null`. Open a blank form. Optionally show "Couldn't read this image — please enter details manually." |

**Special case — pump photo**

When `classification === "pump_photo"`, the `extracted.allFuelPrices` array contains all prices visible on the board:
```json
"allFuelPrices": [
  { "fuelType": "unleaded_91", "pricePerLitre": 1.899 },
  { "fuelType": "unleaded_95", "pricePerLitre": 1.979 },
  { "fuelType": "unleaded_98", "pricePerLitre": 2.059 },
  { "fuelType": "diesel",      "pricePerLitre": 1.849 }
]
```

For pump photos, the customer isn't necessarily logging a personal expense — they're contributing price data. Offer two options:
- **"Save price data only"** — contribute to fuel price intelligence without creating an expense. Dismiss the form.
- **"Log my fill-up"** — open a normal expense form pre-filled with the station name and the price for the fuel type they selected.

Pass `allFuelPrices` through to `POST /c/vehicles/:id/expenses` — the backend stores all the price data in the crowd-sourced pool automatically.

---

## Step 4 — Handle missing odometer

`odometerKm` is often not printed on receipts. If the scan returns `odometerKm: null` for a fuel expense, prompt the customer:

> "What was your odometer reading when you filled up?"
> [ number input ] or [ Skip ]

Odometer data unlocks fuel efficiency calculations in the summary screen. The prompt should be light — a secondary input below the main form, not a blocking modal. "Skip" is always available.

---

## Create expense

### `POST /c/vehicles/:id/expenses`

**Request body**

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `category` | string | Yes | See category values above |
| `expenseDate` | string | Yes | `YYYY-MM-DD` |
| `merchantName` | string | No | Station/workshop/shop name |
| `merchantSuburb` | string | No | |
| `merchantState` | string | No | e.g. `VIC` |
| `amountAud` | number | No | Total amount paid |
| `odometerKm` | number | No | Reading at time of expense |
| `fuelType` | string | No | Fuel expenses only |
| `fuelLitres` | number | No | Fuel expenses only |
| `pricePerLitre` | number | No | Fuel expenses only |
| `evKwh` | number | No | EV charging only |
| `pricePerKwh` | number | No | EV charging only |
| `imageId` | string | No | Cloudflare image ID from the upload step |
| `extractionStatus` | string | No | Pass `"extracted"` if from a scan. Defaults to `"manual"`. |
| `allFuelPrices` | array | No | Pass through from pump photo scan. Contributes all prices to the crowd-sourced pool. |
| `isBusinessExpense` | boolean | No | Default: `false`. For tax tracking. |
| `notes` | string | No | Free-text notes |

**Example — fuel receipt**
```json
{
  "category":         "fuel",
  "expenseDate":      "2026-07-06",
  "merchantName":     "BP Frankston",
  "merchantSuburb":   "Frankston",
  "merchantState":    "VIC",
  "amountAud":        85.40,
  "odometerKm":       87400,
  "fuelType":         "unleaded_95",
  "fuelLitres":       42.700,
  "pricePerLitre":    2.000,
  "imageId":          "abc123-...",
  "extractionStatus": "extracted",
  "isBusinessExpense": false
}
```

**Example — manual parking**
```json
{
  "category":    "parking",
  "expenseDate": "2026-07-06",
  "merchantName": "Wilson Parking Melbourne CBD",
  "amountAud":   22.00
}
```

**Response — 201**
```json
{
  "id":                1,
  "category":          "fuel",
  "merchantName":      "BP Frankston",
  "merchantSuburb":    "Frankston",
  "merchantState":     "VIC",
  "amountAud":         85.40,
  "expenseDate":       "2026-07-06",
  "odometerKm":        87400,
  "fuelType":          "unleaded_95",
  "fuelLitres":        42.700,
  "pricePerLitre":     2.000,
  "evKwh":             null,
  "pricePerKwh":       null,
  "imageUrl":          "https://imagedelivery.net/...public",
  "extractionStatus":  "extracted",
  "isBusinessExpense": false,
  "notes":             null,
  "createdAt":         "2026-07-06T00:00:00.000Z"
}
```

**Side effects (handled automatically by the backend)**
- Fuel/EV expenses with `pricePerLitre` or `pricePerKwh` → price contributed to crowd-sourced fuel price pool
- `category: "workshop"` expenses → auto-written to the vehicle's digital logbook (workshop name, date, odometer, cost, notes)

---

## List expenses

### `GET /c/vehicles/:id/expenses`

Returns up to 200 expenses, newest first.

**Query parameters**

| Param | Type | Notes |
|-------|------|-------|
| `category` | string | Filter to one category |
| `from` | string | Start date `YYYY-MM-DD` (inclusive) |
| `to` | string | End date `YYYY-MM-DD` (inclusive) |
| `businessOnly` | `"true"` | Show only business expenses |

**Response — 200**
```json
{
  "expenses": [
    {
      "id":                2,
      "source":            "user",
      "category":          "fuel",
      "merchantName":      "BP Frankston",
      "merchantSuburb":    "Frankston",
      "merchantState":     "VIC",
      "amountAud":         85.40,
      "expenseDate":       "2026-07-06",
      "odometerKm":        87400,
      "fuelType":          "unleaded_95",
      "fuelLitres":        42.700,
      "pricePerLitre":     2.000,
      "evKwh":             null,
      "pricePerKwh":       null,
      "imageUrl":          "https://imagedelivery.net/...public",
      "extractionStatus":  "extracted",
      "isBusinessExpense": false,
      "notes":             null,
      "createdAt":         "2026-07-06T00:00:00.000Z"
    },
    {
      "id":                42,
      "source":            "workshop",
      "category":          "workshop",
      "merchantName":      "Rodz Somerville",
      "merchantSuburb":    "Somerville",
      "merchantState":     "VIC",
      "amountAud":         617.30,
      "expenseDate":       "2026-06-14",
      "odometerKm":        86200,
      "fuelType":          null,
      "fuelLitres":        null,
      "pricePerLitre":     null,
      "evKwh":             null,
      "pricePerKwh":       null,
      "imageUrl":          null,
      "extractionStatus":  "workshop",
      "isBusinessExpense": false,
      "notes":             "Front pads + rotors, coolant flush",
      "createdAt":         "2026-06-14T04:22:11.000Z",
      "invoiceNumber":     "INV-2026-0042",
      "invoiceStatus":     "paid",
      "invoiceUrl":        "/account/invoices/42"
    }
  ],
  "total": 2
}
```

The list includes an `imageUrl` for expenses that have a scanned receipt — show a thumbnail or a camera icon to indicate a receipt is attached.

### `source` discriminator — new field

Every expense now carries a `source`:

| Value | Meaning | Editable? |
|-------|---------|-----------|
| `"user"` | Customer-entered (manual or scanned receipt) | Yes — full PATCH/DELETE |
| `"workshop"` | Rodz Smart Auto invoice — surfaced automatically as an expense entry | **Read-only** — no edit / delete affordances |

Workshop rows also carry three extra fields not present on user rows:

| Field | Type | Notes |
|-------|------|-------|
| `invoiceNumber` | string | e.g. `"INV-2026-0042"` — display next to the merchant/amount |
| `invoiceStatus` | `"sent"` \| `"paid"` | `"sent"` = awaiting payment; `"paid"` = settled |
| `invoiceUrl` | string | Deep link to the customer's invoice viewer (`/account/invoices/:id`) |

### UI rules for workshop rows

- **No edit / delete buttons.** Long-press or swipe actions must be disabled — the workshop's records are the source of truth.
- **Show a "View invoice" affordance** instead — tap opens `invoiceUrl` in the customer invoice viewer.
- **Show the invoice number** near the merchant name (`"Rodz Somerville · INV-2026-0042"`) so it's obvious this row is a workshop invoice.
- **Show unpaid state** — if `invoiceStatus === "sent"`, badge the row as "Awaiting payment" so the customer can spot outstanding bills at a glance.
- **Category always `"workshop"`** — no need to allow re-categorising.
- **`businessOnly=true` filter** hides workshop rows (they don't carry a per-invoice business flag). Document this in your filter UI copy if it's non-obvious.
- **`category=<foo>` filter** with a value other than `workshop` also hides workshop rows.

Aside from the extra fields and disabled edit UI, workshop rows render identically to user rows — same amount, date, merchant, odometer, category badge.

---

## Update expense

### `PATCH /c/vehicles/:id/expenses/:expenseId`

All fields optional — only send fields you want to change.

**Request body** — same field names as create, all optional.

**Response — 200** — same shape as the create response.

Use this when the customer edits fields after a scan, or corrects something on an existing expense.

---

## Delete expense

### `DELETE /c/vehicles/:id/expenses/:expenseId`

No request body.

**Response — 200**
```json
{ "deleted": true }
```

If the expense had a receipt photo, it is deleted from Cloudflare automatically.

---

## Summary / analytics

### `GET /c/vehicles/:id/expenses/summary`

Aggregated stats for a calendar year. Use this for the dashboard / annual report screen.

**Query parameters**

| Param | Type | Default | Notes |
|-------|------|---------|-------|
| `year` | number | Current year | e.g. `2026` |

**Response — 200**
```json
{
  "year":             2026,
  "totalAud":         1284.50,
  "businessTotalAud": 0,
  "byCategory": [
    { "category": "fuel",     "totalAud": 850.00, "count": 12 },
    { "category": "workshop", "totalAud": 385.00, "count": 1  },
    { "category": "parking",  "totalAud": 49.50,  "count": 5  }
  ],
  "fuelEfficiency": {
    "avgLitresPer100km": 8.2,
    "totalLitres":       340.0,
    "totalFuelAud":      680.00,
    "costPerKm":         0.35
  },
  "monthlyTotals": [
    { "month": "2026-01", "totalAud": 95.00 },
    { "month": "2026-02", "totalAud": 112.50 }
  ]
}
```

**Response fields**

| Field | Notes |
|-------|-------|
| `totalAud` | All expenses for the year — includes workshop invoices |
| `businessTotalAud` | Sum of expenses where `isBusinessExpense = true`. Workshop invoices do NOT contribute (they don't carry the flag). |
| `byCategory` | Sorted by total descending. The `workshop` bucket now includes both customer-entered workshop expenses AND Rodz Smart Auto invoices. |
| `fuelEfficiency` | Only present when there are ≥2 fuel entries with odometer readings. `null` otherwise. Workshop invoices don't affect this calc. |
| `fuelEfficiency.avgLitresPer100km` | Calculated from consecutive odometer readings across all fuel entries |
| `fuelEfficiency.costPerKm` | Total fuel spend divided by total km covered |
| `monthlyTotals` | Only months with spending appear — fill gaps with 0 on the frontend. Includes workshop-invoice amounts. |

**When `fuelEfficiency` is null:**  
Show a prompt: "Add odometer readings to your fuel expenses to unlock fuel efficiency tracking."

---

## CSV export

### `GET /c/vehicles/:id/expenses/export`

Downloads a CSV file. Does not return JSON — handle as a file download.

**Query parameters** — same as the list endpoint (`from`, `to`, `year`, `businessOnly`).

**Response — 200**
```
Content-Type: text/csv
Content-Disposition: attachment; filename="Expenses-LWF251-Suzuki-Vitara-2026.csv"
```

The CSV includes columns: Date, Category, Source, Merchant, Suburb, State, Amount (AUD), Odometer (km), Fuel Type, Litres, Price/Litre, EV kWh, Price/kWh, Business Expense, Invoice #, Notes.

Workshop invoices appear as rows with `Source=workshop` and their `Invoice #` populated. All rows are sorted chronologically (ascending) so the CSV reads as a running ledger.

**Triggering the download in-app**

```javascript
const res = await fetch(`/c/vehicles/${vehicleId}/expenses/export?year=2026`, {
  headers: { Authorization: `Bearer ${token}` }
})
const blob = await res.blob()
const url  = URL.createObjectURL(blob)
const a    = document.createElement('a')
a.href     = url
a.download = `Expenses-${year}.csv`
a.click()
URL.revokeObjectURL(url)
```

On mobile, use the native share sheet with the file blob instead.

---

## Suggested screen structure

### Expense list screen

- **Header:** Year selector (left/right arrows). Current year total in large text.
- **Category filter:** Horizontal scrolling chips — All / Fuel / Workshop / etc. Selecting one calls `GET /c/vehicles/:id/expenses?category=fuel`.
- **Business only toggle:** Switch that appends `businessOnly=true` to the filter.
- **Expense rows:** Date, merchant name (or category if no merchant), amount. Camera icon if `imageUrl` is set. Workshop-invoice rows (`source: "workshop"`) show the invoice number instead and an "Awaiting payment" pill if `invoiceStatus === "sent"`. Tap workshop rows to open `invoiceUrl`; tap user rows to open the detail sheet.
- **FAB:** "+" button → opens Add Expense bottom sheet.
- **Export button:** In the header or toolbar. Triggers CSV download for the selected year.

### Add / edit expense sheet

- **Photo button at top:** "Scan receipt" opens camera → upload → scan → pre-fill. "Take photo later" skips to manual form.
- **Category picker:** Grid or list of category options with icons.
- **Date field:** Defaults to today.
- **Amount field:** Numeric keyboard.
- **Merchant fields:** Name, suburb, state.
- **Fuel fields:** Shown only when `category === "fuel"`. Fuel type picker, litres, price/litre.
- **EV fields:** Shown only when `category === "ev_charging"`. kWh, price/kWh.
- **Odometer field:** Shown for fuel and EV categories. Optional.
- **Business expense toggle:** Off by default.
- **Notes field:** Optional free text.

### Annual summary / dashboard screen

- **Total spend card** with year.
- **Donut chart** by category using `byCategory` data.
- **Monthly bar chart** using `monthlyTotals`. Fill missing months with 0.
- **Fuel efficiency card** from `fuelEfficiency` — show L/100km and $/km. Hide if null.
- **Business deductions card** — show `businessTotalAud` with "Export for tax" button.

---

## Error reference

| Status | Code | When |
|--------|------|------|
| 403 | `FORBIDDEN` | Vehicle doesn't belong to this customer |
| 404 | `NOT_FOUND` | Expense ID doesn't exist |
| 422 | `VALIDATION_ERROR` | Missing required field or invalid enum value |

---

## Notes

- The list endpoint returns a maximum of 200 expenses. For most customers this covers multiple years. Combine with `from`/`to` date filters if you need to paginate by year.
- `allFuelPrices` should be passed through as-is from the scan response when creating the expense — the backend handles inserting all the individual price rows.
- Workshop expenses are automatically written to the vehicle's digital logbook. The customer does not need to do anything separately — when they add a workshop expense with a scanned invoice, it appears in the logbook automatically.
- `extractionStatus` on a saved expense tells you its origin: show a small "AI extracted" badge on entries where `extractionStatus === "extracted"` so the customer knows which ones came from scans.
