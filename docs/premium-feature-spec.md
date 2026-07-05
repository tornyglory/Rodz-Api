# Rodz Premium — Technical Specification

**$29/year subscription.** Turns the Rodz customer app into a complete vehicle ownership platform — not just a workshop companion, but the single source of truth for the full life of a vehicle.

---

## Feature set

| Feature | Free | Premium |
|---------|------|---------|
| AI chat (Q&A, service history, diagnosis) | ✓ | ✓ |
| Book a service via chat | ✓ | ✓ |
| Digital logbook (Rodz jobs only) | ✓ | ✓ |
| 1 vehicle | ✓ | ✓ |
| Multiple vehicles | — | ✓ |
| Vehicle costs tracker (rego, insurance, etc.) | — | ✓ |
| Proactive reminders (email + push) | — | ✓ |
| External workshop invoice import (photo → logbook) | — | ✓ |
| Full logbook PDF export | — | ✓ |
| Vehicle transfer to new owner | — | ✓ |
| AI chat with full ownership context | — | ✓ |
| Expense tracker (scan receipts, fuel, parts, etc.) | — | ✓ |
| Fuel & charging price intelligence | — | ✓ |
| Annual running cost report + tax export (CSV) | — | ✓ |
| AI fuel efficiency and cost insights | — | ✓ |

---

## Build order

Build in this sequence — each phase is independently shippable and the subscription layer gates everything above it.

1. **Phase 1 — Stripe subscription layer** (foundation)
2. **Phase 2 — Vehicle costs tracker + reminders**
3. **Phase 3 — External invoice import**
4. **Phase 4 — PDF logbook export**
5. **Phase 5 — Vehicle transfer**
6. **Phase 6 — Expense tracker** (scan receipts → AI extraction → running cost analytics + tax export)
7. **Phase 7 — Fuel & charging price intelligence** (crowd-sourced price data → AI recommendations)

---

## Phase 1 — Stripe subscription layer

### Database

#### `customer_subscriptions`

```sql
CREATE TABLE customer_subscriptions (
  id                    bigint unsigned NOT NULL AUTO_INCREMENT,
  customer_id           bigint unsigned NOT NULL,
  stripe_customer_id    varchar(255)    NOT NULL,
  stripe_subscription_id varchar(255)   NOT NULL,
  status                enum('active','cancelled','past_due','expired') NOT NULL DEFAULT 'active',
  plan                  varchar(50)     NOT NULL DEFAULT 'premium_annual',
  amount_aud            decimal(8,2)    NOT NULL DEFAULT 29.00,
  current_period_start  datetime        NOT NULL,
  current_period_end    datetime        NOT NULL,
  cancelled_at          datetime        NULL,
  created_at            datetime        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            datetime        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_customer (customer_id),
  KEY idx_stripe_sub (stripe_subscription_id),
  FOREIGN KEY (customer_id) REFERENCES customers(id)
);
```

### Stripe integration

Use Stripe Checkout for the payment flow — no need to build a custom card form.

**Environment variables to add:**
```
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PREMIUM_PRICE_ID=price_...   # $29 AUD annual recurring price
```

**Flow:**

1. Customer taps "Go Premium" → frontend calls `POST /c/subscriptions/checkout`
2. Backend creates a Stripe Checkout session (annual subscription, $29 AUD)
3. Frontend redirects to `session.url` (Stripe-hosted checkout page)
4. On success, Stripe redirects back to `https://app.rodz.com.au/premium/success`
5. Stripe fires webhook `customer.subscription.created` → backend saves subscription record

**Webhook events to handle:**

| Event | Action |
|-------|--------|
| `customer.subscription.created` | Insert `customer_subscriptions` row, `status = active` |
| `customer.subscription.updated` | Update status, period dates |
| `customer.subscription.deleted` | Set `status = cancelled`, `cancelled_at = NOW()` |
| `invoice.payment_failed` | Set `status = past_due` |
| `invoice.payment_succeeded` | Set `status = active`, extend `current_period_end` |

### API endpoints

#### `POST /c/subscriptions/checkout`
Creates a Stripe Checkout session.

**Response — 200**
```json
{ "checkoutUrl": "https://checkout.stripe.com/pay/cs_live_..." }
```

#### `POST /c/subscriptions/webhook`
Public endpoint (no auth) — receives Stripe webhook events. Verify signature using `STRIPE_WEBHOOK_SECRET`. Must return 200 quickly; all processing is synchronous.

#### `GET /c/subscriptions/me`
Returns the customer's current subscription status.

**Response — 200**
```json
{
  "isPremium": true,
  "status": "active",
  "plan": "premium_annual",
  "currentPeriodEnd": "2027-07-04",
  "cancelledAt": null
}
```

Returns `{ "isPremium": false }` if no subscription exists.

#### `POST /c/subscriptions/cancel`
Cancels at period end (Stripe `cancel_at_period_end = true`). Customer retains premium until `currentPeriodEnd`.

**Response — 200**
```json
{ "message": "Your Premium membership will end on 4 July 2027." }
```

### Premium gate helper

Add a shared function used by all premium-gated endpoints:

```typescript
// src/customer/shared/premium.ts
export async function requiresPremium(db: Pool, customerId: number): Promise<boolean> {
  const [[row]] = await db.query<any[]>(
    `SELECT id FROM customer_subscriptions
     WHERE customer_id = ? AND status = 'active' AND current_period_end > NOW()
     LIMIT 1`,
    [customerId],
  )
  return !!row
}
```

Usage in any premium endpoint:
```typescript
if (!await requiresPremium(db, ctx.customerId)) return forbidden()
```

---

## Phase 2 — Vehicle costs tracker + reminders

### Database

#### `vehicle_costs`

```sql
CREATE TABLE vehicle_costs (
  id               bigint unsigned NOT NULL AUTO_INCREMENT,
  vehicle_id       bigint unsigned NOT NULL,
  customer_id      bigint unsigned NOT NULL,
  type             enum('registration','insurance','ctp','roadside','loan','other') NOT NULL,
  label            varchar(150)    NOT NULL,
  provider         varchar(150)    NULL,
  amount_aud       decimal(10,2)   NULL,
  due_date         date            NOT NULL,
  renewal_months   tinyint unsigned NULL,          -- null = one-off, 12 = annual, 6 = 6-monthly
  notes            text            NULL,
  remind_30_days   tinyint(1)      NOT NULL DEFAULT 1,
  remind_7_days    tinyint(1)      NOT NULL DEFAULT 1,
  last_reminded_at datetime        NULL,
  created_at       datetime        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       datetime        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_vehicle (vehicle_id),
  KEY idx_due (due_date),
  FOREIGN KEY (vehicle_id) REFERENCES vehicles(id),
  FOREIGN KEY (customer_id) REFERENCES customers(id)
);
```

**Notes:**
- Registration is pre-populated from `vehicles.rego_expiry` and `vehicles.rego_state` when the customer first enables the costs tracker — they just confirm/edit the amount.
- `renewal_months` drives automatic rollover: when a reminder fires and the cost is renewed, a new row is created for `due_date + renewal_months`.

### API endpoints

All require premium gate.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/c/vehicles/:id/costs` | List all costs for a vehicle |
| `POST` | `/c/vehicles/:id/costs` | Add a cost entry |
| `PATCH` | `/c/vehicles/:id/costs/:costId` | Edit a cost entry |
| `DELETE` | `/c/vehicles/:id/costs/:costId` | Remove a cost entry |

**`GET /c/vehicles/:id/costs` response**
```json
{
  "costs": [
    {
      "id": 1,
      "type": "registration",
      "label": "VIC Registration",
      "provider": "VicRoads",
      "amountAud": 890.00,
      "dueDate": "2027-03-01",
      "renewalMonths": 12,
      "remind30Days": true,
      "remind7Days": true,
      "daysUntilDue": 269
    },
    {
      "id": 2,
      "type": "insurance",
      "label": "RACV Comprehensive",
      "provider": "RACV",
      "amountAud": 1200.00,
      "dueDate": "2026-11-15",
      "renewalMonths": 12,
      "remind30Days": true,
      "remind7Days": true,
      "daysUntilDue": 133
    }
  ]
}
```

### Reminders

A scheduled Lambda (EventBridge cron, runs daily at 8am AEST) checks for costs due in 30 days or 7 days and sends an email reminder.

**Lambda:** `src/scheduled/cost-reminders.ts`

Logic:
1. Query `vehicle_costs` WHERE `due_date` is in 30 days OR 7 days AND `last_reminded_at` is NULL or >20 days ago
2. JOIN to `customer_subscriptions` to confirm still premium
3. Send reminder email via SES
4. Update `last_reminded_at = NOW()`

Email subject: *"Your VIC Registration is due in 30 days — $890"*

### AI chat context

When the customer is premium, inject costs into the chat system prompt:

```
## Upcoming costs
- VIC Registration — due 1 Mar 2027 (269 days) — $890
- RACV Comprehensive Insurance — due 15 Nov 2026 (133 days) — $1,200/yr
```

The AI can then proactively mention: *"Your registration is due in about 9 months. Your rego inspection will need to be done first — want me to book you in?"*

---

## Phase 3 — External workshop invoice import

### Database

#### `vehicle_service_log_external`

```sql
CREATE TABLE vehicle_service_log_external (
  id             bigint unsigned NOT NULL AUTO_INCREMENT,
  vehicle_id     bigint unsigned NOT NULL,
  customer_id    bigint unsigned NOT NULL,
  image_id       varchar(255)    NOT NULL,    -- Cloudflare image ID of the original invoice photo
  workshop_name  varchar(200)    NULL,
  workshop_suburb varchar(100)   NULL,
  service_date   date            NULL,
  odometer_km    int unsigned    NULL,
  services       text            NULL,        -- AI-extracted summary of work done
  amount_aud     decimal(10,2)   NULL,
  invoice_number varchar(100)    NULL,
  ai_raw         json            NULL,        -- full Gemini extraction for debugging
  status         enum('pending','extracted','failed') NOT NULL DEFAULT 'pending',
  created_at     datetime        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     datetime        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_vehicle (vehicle_id),
  KEY idx_date (service_date),
  FOREIGN KEY (vehicle_id)   REFERENCES vehicles(id),
  FOREIGN KEY (customer_id)  REFERENCES customers(id)
);
```

### API endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/c/vehicles/:id/logbook/upload-url` | Get Cloudflare upload URL for invoice photo |
| `POST` | `/c/vehicles/:id/logbook/import` | Submit uploaded invoice photo for AI extraction |
| `PATCH` | `/c/vehicles/:id/logbook/external/:entryId` | Customer edits/corrects extracted data |
| `DELETE` | `/c/vehicles/:id/logbook/external/:entryId` | Remove an external entry |

### Invoice extraction flow

1. Customer taps "Import invoice" → photos the paper invoice
2. Frontend calls `GET /c/vehicles/:id/logbook/upload-url` → uploads image to Cloudflare
3. Frontend calls `POST /c/vehicles/:id/logbook/import` with `{ imageId }`
4. Lambda fetches image, sends to Gemini with prompt:

```
Extract the following from this workshop invoice image.
Return valid JSON only:
{
  "workshopName": string | null,
  "workshopSuburb": string | null,
  "serviceDate": "YYYY-MM-DD" | null,
  "odometerKm": number | null,
  "services": "short plain-English summary of work done" | null,
  "amountAud": number | null,
  "invoiceNumber": string | null
}
If a field is not visible or unclear, use null.
```

5. Response saved to `vehicle_service_log_external` with `status = extracted`
6. Response returned to frontend immediately with extracted data for customer to review/correct
7. Customer confirms or edits → `PATCH` saves final values

**`POST /c/vehicles/:id/logbook/import` response**
```json
{
  "id": 5,
  "status": "extracted",
  "workshopName": "Frankston Automotive",
  "workshopSuburb": "Frankston",
  "serviceDate": "2024-11-03",
  "odometerKm": 162000,
  "services": "Full service — oil, filter, spark plugs, brake inspection",
  "amountAud": 385.00,
  "invoiceNumber": "INV-2241",
  "imageUrl": "https://imagedelivery.net/...public"
}
```

If extraction fails (illegible image, wrong image type, API error), `status = failed` and all fields null — the review form opens fully blank. The customer enters everything manually. The original image is still saved and attached to the expense so there's a record of the source document.

### Logbook timeline merge

`GET /c/vehicles/:id/logbook` already returns Rodz jobs. Merge external entries into the same timeline sorted by date:

```typescript
// External entries shape (same as Rodz entries with source = 'external')
{
  id: `ext-${r.id}`,
  source: 'external',
  date: r.service_date,
  odometerKm: r.odometer_km,
  title: r.services?.split('.')[0] ?? 'Service',
  workshop: r.workshop_name,
  tech: null,
  cost: r.amount_aud,
  status: null,
  invoiceId: null,
  invoiceNumber: r.invoice_number,
  invoiceUrl: null,
  aiSummary: r.services,
  imageUrl: imageUrls(r.image_id).public,   // link to original invoice photo
  photos: [],
  lineItems: [],
}
```

The frontend can show a camera icon on external entries to distinguish them from Rodz jobs.

---

## Phase 4 — PDF logbook export

### Approach

Use a Lambda that generates an HTML document and converts it to PDF using a headless Chromium layer (e.g. `@sparticuz/chromium` — works on Lambda, no separate service needed).

### API endpoint

`GET /c/vehicles/:id/logbook/export`

Premium gate required. Returns a PDF binary with:
```
Content-Type: application/pdf
Content-Disposition: attachment; filename="Logbook-LWF251-Suzuki-Vitara-2017.pdf"
```

### PDF contents

1. **Cover page** — vehicle photo (if set), make/model/year/rego, current odometer, "Verified by Rodz" badge for Rodz-serviced entries
2. **Summary** — total spend, number of services, average service interval
3. **Timeline** — all entries (Rodz + external) in chronological order. Rodz entries show full line items. External entries show the original invoice photo thumbnail.
4. **QR code** — links to the live digital logbook (the logbook token URL)
5. **Footer** — "Generated by Rodz Smart Auto · rodz.com.au · {date}"

### Lambda config

- Memory: 1024MB (Chromium needs it)
- Timeout: 30s
- Layer: `@sparticuz/chromium` pre-built Lambda layer

---

## Phase 5 — Vehicle transfer

Allows a customer (seller) to transfer a vehicle and its full logbook to a new owner.

### Flow

1. Seller taps "Transfer vehicle" on the vehicle detail screen
2. Seller enters new owner's email address
3. Backend:
   - Generates a one-time transfer token (64-char hex), stored in a new `vehicle_transfers` table
   - Emails the buyer with a link: `https://app.rodz.com.au/transfer/:token`
   - Token expires in 7 days
4. Buyer clicks the link:
   - If they have a Rodz account → log in → vehicle appears in their garage
   - If they don't → sign up → vehicle appears immediately after signup
5. On acceptance:
   - Update `vehicle_owners`: set `is_current = 0` for seller, insert new row for buyer
   - Mark transfer as complete
   - Notify seller by email: "Your 2017 Suzuki Vitara has been transferred to [buyer email]"

### Database

#### `vehicle_transfers`

```sql
CREATE TABLE vehicle_transfers (
  id             bigint unsigned NOT NULL AUTO_INCREMENT,
  vehicle_id     bigint unsigned NOT NULL,
  from_customer_id bigint unsigned NOT NULL,
  to_email       varchar(255)    NOT NULL,
  to_customer_id bigint unsigned NULL,           -- set on acceptance
  token          char(64)        NOT NULL,
  status         enum('pending','accepted','expired','cancelled') NOT NULL DEFAULT 'pending',
  expires_at     datetime        NOT NULL,
  accepted_at    datetime        NULL,
  created_at     datetime        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_token (token),
  KEY idx_vehicle (vehicle_id),
  FOREIGN KEY (vehicle_id)         REFERENCES vehicles(id),
  FOREIGN KEY (from_customer_id)   REFERENCES customers(id)
);
```

### API endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/c/vehicles/:id/transfer` | Initiate transfer — premium gate on sender |
| `GET` | `/c/transfer/:token` | Public — fetch transfer details (buyer sees vehicle info) |
| `POST` | `/c/transfer/:token/accept` | Buyer accepts — requires auth (or triggers signup flow) |
| `DELETE` | `/c/vehicles/:id/transfer` | Seller cancels a pending transfer |

---

## Phase 6 — Expense tracker

Customers scan receipts and photos directly into the app. Gemini reads the image, classifies what it is, and extracts structured data. The customer reviews and confirms. Over time the system knows exactly what it costs to run each vehicle — fuel, servicing, parts, rego, insurance, tolls, parking — and can produce an annual running cost report and tax-ready export.

### Supported expense types

| Category | What gets scanned |
|----------|------------------|
| `fuel` | Bowser receipts, pump screen photos |
| `ev_charging` | EV charging receipts, RFID tap receipts, charger screen photos |
| `workshop` | Invoices from non-Rodz workshops (feeds into logbook too) |
| `parts` | Receipts from Repco, Supercheap, eBay, etc. |
| `car_wash` | Receipts |
| `parking` | Receipts or meter photos |
| `tolls` | E-tag statements, individual toll receipts |
| `registration` | Rego renewal receipts |
| `insurance` | Insurance renewal receipts |
| `roadside` | RACV/NRMA membership receipts |
| `other` | Anything else vehicle-related |

### Database

#### `vehicle_expenses`

```sql
CREATE TABLE vehicle_expenses (
  id                    bigint unsigned NOT NULL AUTO_INCREMENT,
  vehicle_id            bigint unsigned NOT NULL,
  customer_id           bigint unsigned NOT NULL,
  category              enum('fuel','ev_charging','workshop','parts','car_wash','parking','tolls','registration','insurance','roadside','other') NOT NULL,
  merchant_name         varchar(200)    NULL,
  merchant_suburb       varchar(100)    NULL,
  merchant_state        char(3)         NULL,
  amount_aud            decimal(10,2)   NULL,
  expense_date          date            NOT NULL,
  odometer_km           int unsigned    NULL,
  -- Fuel-specific
  fuel_type             enum('unleaded_91','unleaded_95','unleaded_98','diesel','lpg','e10') NULL,
  fuel_litres           decimal(8,3)    NULL,
  price_per_litre       decimal(6,3)    NULL,
  -- EV-specific
  ev_kwh                decimal(8,3)    NULL,
  price_per_kwh         decimal(6,3)    NULL,
  -- Image
  image_id              varchar(255)    NULL,
  extraction_status     enum('manual','extracted','failed') NOT NULL DEFAULT 'manual',
  ai_raw                json            NULL,
  -- Tax / business
  is_business_expense   tinyint(1)      NOT NULL DEFAULT 0,
  notes                 text            NULL,
  created_at            datetime        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            datetime        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_vehicle_date (vehicle_id, expense_date),
  KEY idx_customer (customer_id),
  FOREIGN KEY (vehicle_id)    REFERENCES vehicles(id),
  FOREIGN KEY (customer_id)   REFERENCES customers(id)
);
```

**Notes:**
- `odometer_km` is critical for fuel efficiency calculations — prompt customers to enter it when adding a fuel expense
- `is_business_expense` drives the tax export — customers toggle this per entry
- When `category = 'workshop'`, the backend automatically writes to **both** `vehicle_expenses` (cost tracking) and `vehicle_service_log_external` (logbook) from a single scan. The customer scans one old invoice and it appears in the expense tracker AND the digital logbook timeline, merged with their Rodz service history. This makes Phase 6 the primary entry point for external invoice import — Phase 3's standalone import flow is effectively superseded.
- `ai_raw` stores the full Gemini JSON response for debugging extraction failures

### API endpoints

All require premium gate.

| Method | Path | Description |
|--------|------|-------------|
| `GET`    | `/c/vehicles/:id/expenses` | List expenses (with filters) |
| `POST`   | `/c/vehicles/:id/expenses` | Add expense manually |
| `PATCH`  | `/c/vehicles/:id/expenses/:expenseId` | Edit an expense |
| `DELETE` | `/c/vehicles/:id/expenses/:expenseId` | Delete expense + Cloudflare image |
| `GET`    | `/c/vehicles/:id/expenses/upload-url` | Get Cloudflare upload URL for receipt scan |
| `POST`   | `/c/vehicles/:id/expenses/scan` | Submit image for AI extraction |
| `GET`    | `/c/vehicles/:id/expenses/summary` | Annual/monthly cost summary |
| `GET`    | `/c/vehicles/:id/expenses/export` | Download CSV for tax/accounting |

---

#### `GET /c/vehicles/:id/expenses`

**Query parameters**

| Param | Type | Description |
|-------|------|-------------|
| `category` | string | Filter by category |
| `from` | date | Start date `YYYY-MM-DD` |
| `to` | date | End date `YYYY-MM-DD` |
| `businessOnly` | boolean | Only business-flagged expenses |

**Response — 200**
```json
{
  "expenses": [
    {
      "id":                 12,
      "category":           "fuel",
      "merchantName":       "BP Frankston",
      "merchantSuburb":     "Frankston",
      "merchantState":      "VIC",
      "amountAud":          85.40,
      "expenseDate":        "2026-07-05",
      "odometerKm":         87400,
      "fuelType":           "unleaded_95",
      "fuelLitres":         42.7,
      "pricePerLitre":      2.000,
      "evKwh":              null,
      "pricePerKwh":        null,
      "imageUrl":           "https://imagedelivery.net/.../public",
      "extractionStatus":   "extracted",
      "isBusinessExpense":  false,
      "notes":              null,
      "createdAt":          "2026-07-05T10:30:00.000Z"
    }
  ],
  "total": 1
}
```

---

#### `POST /c/vehicles/:id/expenses`

Manual entry — no image required.

**Request**
```json
{
  "category":          "fuel",
  "merchantName":      "Shell Cranbourne",
  "merchantSuburb":    "Cranbourne",
  "merchantState":     "VIC",
  "amountAud":         72.00,
  "expenseDate":       "2026-07-06",
  "odometerKm":        88100,
  "fuelType":          "unleaded_95",
  "fuelLitres":        36.0,
  "pricePerLitre":     2.000,
  "isBusinessExpense": false,
  "notes":             null
}
```

Only `category` and `expenseDate` are required. All other fields are optional.

**Response — 201** — returns the created expense object.

---

#### `GET /c/vehicles/:id/expenses/upload-url`

Returns a Cloudflare direct upload URL for a receipt photo or pump image.

**Response — 200**
```json
{
  "uploadUrl": "https://upload.imagedelivery.net/...",
  "imageId":   "cf-image-uuid"
}
```

---

#### `POST /c/vehicles/:id/expenses/scan`

Submit an uploaded image to Gemini for classification and extraction. Returns extracted data for the customer to review before saving.

**Request**
```json
{ "imageId": "cf-image-uuid" }
```

**Gemini prompt (server-side):**
```
You are analysing an image from a vehicle owner's expense tracker.

Step 1 — Classify the image. Choose ONE of:
fuel_receipt, ev_receipt, pump_photo, workshop_invoice, parts_receipt,
car_wash_receipt, parking_receipt, toll_receipt, insurance_receipt,
registration_receipt, other_receipt, unclear

Step 2 — Extract all fields relevant to the classification.

Return valid JSON only, no markdown, no explanation:
{
  "classification": "<type>",
  "confidence": "high" | "medium" | "low",
  "category": "<vehicle_expenses.category enum value>",
  "merchantName": string | null,
  "merchantSuburb": string | null,
  "merchantState": string | null,
  "amountAud": number | null,
  "expenseDate": "YYYY-MM-DD" | null,
  "odometerKm": number | null,
  "fuelType": "unleaded_91"|"unleaded_95"|"unleaded_98"|"diesel"|"lpg"|"e10" | null,
  "fuelLitres": number | null,
  "pricePerLitre": number | null,
  "evKwh": number | null,
  "pricePerKwh": number | null,
  "notes": "any other relevant detail visible on the receipt" | null
}
Use null for any field not visible or not applicable to this image type.
```

**Response — 200 (successful extraction)**
```json
{
  "imageId":          "cf-image-uuid",
  "classification":   "fuel_receipt",
  "confidence":       "high",
  "extracted": {
    "category":       "fuel",
    "merchantName":   "BP Frankston",
    "merchantSuburb": "Frankston",
    "merchantState":  "VIC",
    "amountAud":      85.40,
    "expenseDate":    "2026-07-05",
    "odometerKm":     87400,
    "fuelType":       "unleaded_95",
    "fuelLitres":     42.7,
    "pricePerLitre":  2.000,
    "evKwh":          null,
    "pricePerKwh":    null,
    "notes":          null
  }
}
```

**Response — 200 (unclear image)**
```json
{
  "imageId":        "cf-image-uuid",
  "classification": "unclear",
  "confidence":     "low",
  "extracted":      null
}
```

The frontend displays the extracted data in a pre-filled form. The customer reviews, corrects anything wrong, then confirms — which calls `POST /c/vehicles/:id/expenses` with the `imageId` included. The image is never saved until the customer confirms.

**Odometer handling in the review form:**
- If `odometerKm` was extracted → pre-fill the field
- If `odometerKm` is null → show an empty field with a prompt:
  - For `fuel` and `ev_charging`: *"Add your odometer reading to track fuel efficiency"*
  - For `workshop`: *"Add your odometer reading to track service intervals"*
  - For all other categories: hide the odometer field entirely — not worth the friction
- Odometer is never required — the customer can confirm without it. Fuel efficiency calculations simply exclude entries with no odometer reading.

**Pump photo handling:** When `classification = "pump_photo"`, the extraction pulls price-per-litre from the pump display. This is the entry point into Phase 7 (fuel price intelligence) — the price is contributed to `fuel_station_prices` automatically when the expense is confirmed.

---

#### `GET /c/vehicles/:id/expenses/summary`

Returns aggregated cost data for the vehicle.

**Query parameters:** `year` (default: current year), `month` (optional, for monthly breakdown)

**Response — 200**
```json
{
  "year": 2026,
  "totalAud": 4820.50,
  "businessTotalAud": 1200.00,
  "byCategory": [
    { "category": "fuel",         "totalAud": 1840.00, "count": 22 },
    { "category": "workshop",     "totalAud": 1450.00, "count": 4  },
    { "category": "registration", "totalAud":  890.00, "count": 1  },
    { "category": "insurance",    "totalAud":  640.50, "count": 1  }
  ],
  "fuelEfficiency": {
    "avgLitresPer100km": 8.2,
    "totalLitres":       460.0,
    "totalFuelAud":      1840.00,
    "costPerKm":         0.21
  },
  "monthlyTotals": [
    { "month": "2026-01", "totalAud": 380.00 },
    { "month": "2026-02", "totalAud": 290.00 }
  ]
}
```

`fuelEfficiency` is calculated from fuel entries that have both `fuel_litres` and consecutive `odometer_km` values. Only returned if at least 2 fuel entries with odometer readings exist.

---

#### `GET /c/vehicles/:id/expenses/export`

Returns a CSV file download — all expenses for the vehicle (or filtered by year/date range/business only).

**Query parameters:** `from`, `to`, `businessOnly`, `year`

**Response headers:**
```
Content-Type: text/csv
Content-Disposition: attachment; filename="Expenses-LWF251-Suzuki-Vitara-2026.csv"
```

**CSV columns:**
```
Date, Category, Merchant, Suburb, State, Amount (AUD), Odometer (km),
Fuel Type, Litres, Price/Litre, EV kWh, Price/kWh, Business Expense, Notes
```

This is the primary tax and accounting export. Customers can open it directly in Excel or upload to their accountant. Each row is one expense entry.

---

### Chat integration — adding expenses via Rod

Customers can add expenses directly through the AI chat by sending a receipt photo. This reuses the existing chat image upload flow:

1. Customer sends an image (receipt, pump photo) in the chat with a message like *"Add this fuel receipt"*
2. Rod detects the intent and the image
3. Rod calls an internal `scanExpense` tool (Gemini extraction, same logic as the scan endpoint)
4. Rod presents the extracted data conversationally: *"Got it — $85.40 at BP Frankston on 5 July, 42.7L of 95 unleaded at $2.00/L. Was this a business expense?"*
5. Customer confirms → Rod saves the expense and responds: *"Added to your expenses. You've spent $1,840 on fuel this year."*

This makes the chat the primary input method on mobile — no need to navigate to the expense screen to log a receipt.

---

## Phase 7 — Fuel & charging price intelligence

Every fuel or EV charging expense confirmed by a customer contributes price data to a shared, crowd-sourced price database. Over time, Rod can tell customers where the cheapest fuel is in their area, track price trends, and factor this into driving recommendations.

This data grows automatically as more customers use the expense tracker — no separate "report a price" feature needed.

### Database

#### `fuel_station_prices`

```sql
CREATE TABLE fuel_station_prices (
  id              bigint unsigned NOT NULL AUTO_INCREMENT,
  expense_id      bigint unsigned NULL,
  customer_id     bigint unsigned NOT NULL,
  station_name    varchar(200)    NOT NULL,
  station_suburb  varchar(100)    NULL,
  station_state   char(3)         NULL,
  fuel_type       enum('unleaded_91','unleaded_95','unleaded_98','diesel','lpg','e10','ev_kwh') NOT NULL,
  price           decimal(6,3)    NOT NULL,
  price_unit      enum('per_litre','per_kwh') NOT NULL DEFAULT 'per_litre',
  image_id        varchar(255)    NULL,             -- pump photo if sourced from a photo
  reported_at     datetime        NOT NULL,
  created_at      datetime        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_station_fuel (station_name, station_suburb, fuel_type),
  KEY idx_reported (reported_at),
  KEY idx_suburb_fuel (station_suburb, station_state, fuel_type),
  FOREIGN KEY (expense_id)   REFERENCES vehicle_expenses(id) ON DELETE SET NULL,
  FOREIGN KEY (customer_id)  REFERENCES customers(id)
);
```

**Notes:**
- A row is inserted automatically when a confirmed fuel/EV expense has `pricePerLitre` or `pricePerKwh` data
- Pump photos (classification = `pump_photo`) can contribute price data without a personal expense — the customer taps "Save price only" rather than logging a full expense
- `reported_at` is the `expense_date` from the source expense, not `created_at` — the price was observed on that date
- Multiple fuel types (91, 95, 98, diesel) can be extracted from a single pump photo — multiple rows are inserted

### How prices are contributed

**From a fuel receipt:** When the customer confirms a fuel expense with `pricePerLitre` populated, automatically insert into `fuel_station_prices`.

**From a pump photo:** Gemini extracts ALL visible prices from the pump board (e.g. 91 @ $1.899, 95 @ $1.979, 98 @ $2.099, diesel @ $1.899). Each price is a separate row. The customer doesn't need to be buying fuel — they can just photograph a sign.

**From EV charging:** When `pricePerKwh` is present, insert a row with `fuel_type = 'ev_kwh'`.

### API endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/c/fuel-prices` | Get recent prices near a location |
| `GET` | `/c/fuel-prices/trends` | Price trend for a station and fuel type |

---

#### `GET /c/fuel-prices`

Returns the most recent observed price for each station in a given area for a given fuel type.

**Query parameters**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `suburb` | string | Yes | Suburb to search |
| `state` | string | No | State filter |
| `fuelType` | string | No | Default: `unleaded_95` |
| `radius` | string | No | `local` (same suburb) or `nearby` (adjacent suburbs) — default: `nearby` |

**Response — 200**
```json
{
  "suburb":    "Frankston",
  "fuelType":  "unleaded_95",
  "asOf":      "2026-07-06T08:00:00.000Z",
  "stations": [
    {
      "stationName":   "BP Frankston",
      "suburb":        "Frankston",
      "state":         "VIC",
      "price":         1.979,
      "priceUnit":     "per_litre",
      "reportedAt":    "2026-07-05T10:30:00.000Z",
      "ageHours":      21
    },
    {
      "stationName":   "Coles Express Frankston",
      "suburb":        "Frankston",
      "state":         "VIC",
      "price":         1.959,
      "priceUnit":     "per_litre",
      "reportedAt":    "2026-07-04T16:00:00.000Z",
      "ageHours":      40
    }
  ]
}
```

`ageHours` = hours since last reported price. Stations not updated in >72 hours should be flagged as stale. Sort by price ascending (cheapest first).

---

#### `GET /c/fuel-prices/trends`

Price history for a specific station and fuel type over time.

**Query parameters:** `stationName`, `suburb`, `fuelType`, `days` (default: 90)

**Response — 200**
```json
{
  "stationName": "BP Frankston",
  "suburb":      "Frankston",
  "fuelType":    "unleaded_95",
  "dataPoints": [
    { "date": "2026-07-05", "price": 1.979 },
    { "date": "2026-06-28", "price": 2.019 },
    { "date": "2026-06-14", "price": 1.899 }
  ],
  "avgPrice":   1.966,
  "minPrice":   1.899,
  "maxPrice":   2.019
}
```

---

### AI chat integration — Rod's fuel knowledge

Once enough price data accumulates (target: 3+ months, 50+ price observations in an area), Rod gains fuel price awareness for the customer's area:

**Injected into system prompt (premium customers):**
```
## Fuel prices near Frankston VIC (last 48 hours)
- Coles Express Frankston: 95 @ $1.959/L (cheapest nearby)
- BP Frankston: 95 @ $1.979/L
- Shell Frankston: 95 @ $2.009/L

## This vehicle's fuel efficiency
Avg 8.2L/100km based on last 22 fill-ups (460L, $1,840 total this year)
Cost per km: $0.21
```

Rod can then proactively say: *"Fuel prices are down this week — Coles Express in Frankston has 95 for $1.959 right now. At your usual 8.2L/100km that's about $16.06 per 100km."*

---

## AI chat — premium context

When the customer is premium, the chat system prompt gets additional context injected:

```
## Upcoming ownership costs
- VIC Registration — due 1 Mar 2027 (in 269 days) — $890
- RACV Comprehensive Insurance — due 15 Nov 2026 (in 133 days) — $1,200/yr

## Full service history (all workshops)
2024-11-03 @ 162,000km — Frankston Automotive — $385: Full service, oil, filter, spark plugs
[Rodz entries already included]

## Vehicle running costs (2026 year to date)
Total spent: $4,820 across 28 expenses
- Fuel: $1,840 (22 fill-ups, avg 8.2L/100km, $0.21/km)
- Servicing: $1,450 (4 services)
- Registration: $890
- Insurance: $641

## Fuel prices near Frankston VIC (last 48 hours)
- Coles Express Frankston: 95 @ $1.959/L
- BP Frankston: 95 @ $1.979/L
- Shell Frankston: 95 @ $2.009/L
```

Rod can reason across the complete ownership picture — not just when the oil was last changed, but the running cost of the vehicle, fuel efficiency trends, upcoming renewals, and the cheapest nearby fuel. Example Rod responses this unlocks:

- *"You've spent $4,820 on your Vitara so far this year — $1,840 of that is fuel. At 8.2L/100km you're getting reasonable efficiency for a petrol SUV."*
- *"Your rego is due in 269 days and will need a roadworthy — want me to book you in a week before?"*
- *"Fuel prices in Frankston are down this week. Coles Express has 95 for $1.959 right now."*

---

## Frontend screens to build (Premium)

| Screen | Phase | Notes |
|--------|-------|-------|
| Go Premium upsell (paywall) | 1 | Show on any premium-gated action. List the features. Single CTA: "Get Rodz Premium — $29/yr" |
| Checkout redirect | 1 | Redirect to Stripe Checkout URL. On return, show success/failure state |
| Subscription status (in profile) | 1 | Shows plan, renewal date, cancel option |
| Vehicle costs list | 2 | Per-vehicle tab. Cards showing each cost with days-until-due badge |
| Add / edit cost | 2 | Simple form: type, label, provider, amount, due date, renewal frequency |
| Import invoice | 3 | Camera/file picker → upload → extracted data review form → confirm |
| Logbook (updated) | 3 | Existing logbook + external entries merged into timeline. "Import invoice" button |
| Export logbook | 4 | Single button tap → downloads PDF |
| Transfer vehicle | 5 | Enter buyer email → confirmation screen → "Transfer sent" state |
| Accept transfer (public) | 5 | Pre-auth landing page showing vehicle details → "Accept transfer" → login/signup |
| Expense list | 6 | Per-vehicle screen. Filterable by category, date range, business. Running total at top. "Scan receipt" + "Add manually" buttons |
| Scan receipt | 6 | Camera/file picker → upload → Gemini extracts → pre-filled review form → confirm. Show `confidence` indicator (`high`/`medium`/`low`). Allow full manual correction on any field. If extraction fails entirely, open blank form with the image thumbnail visible at the top so the customer can read it themselves and type the values in |
| Add expense manually | 6 | Form: category picker, merchant, amount, date, odometer, fuel fields (conditional on category), business toggle, notes |
| Expense analytics | 6 | Annual summary card: total spend, by-category breakdown, fuel efficiency (L/100km, cost/km), monthly trend chart |
| Export expenses (CSV) | 6 | Filter → download. Positioned as "Tax & accounting export" |
| Fuel price map / list | 7 | Nearby stations sorted by price for selected fuel type. Age indicator on each price ("reported 21h ago"). Stale prices (>72h) dimmed |
| Station price trend | 7 | Tap a station to see price history chart over 90 days |
| Pump photo submission | 7 | Camera → Gemini extracts all fuel types shown → confirm prices → contributed without creating a personal expense |

---

## Stripe products to create

Before any dev work, create these in the Stripe dashboard:

1. **Product:** Rodz Premium
2. **Price:** $29.00 AUD, recurring, annual interval
3. Note the **Price ID** (`price_xxx`) → add to Lambda env as `STRIPE_PREMIUM_PRICE_ID`
4. Set up **Webhook** pointing to `POST /c/subscriptions/webhook` — enable the 5 events listed in Phase 1
5. Note the **Webhook signing secret** → add to Lambda env as `STRIPE_WEBHOOK_SECRET`

---

## Environment variables to add

| Variable | Used by |
|----------|---------|
| `STRIPE_SECRET_KEY` | All subscription Lambdas |
| `STRIPE_WEBHOOK_SECRET` | Webhook Lambda |
| `STRIPE_PREMIUM_PRICE_ID` | Checkout Lambda |

All other config (SES, Cloudflare, DB) is already set.
