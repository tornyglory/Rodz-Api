# Vehicle Service History — Design Brief

## Concept

Every invoice raised for a vehicle represents real work that was done. When an invoice is created, a row is written to `vehicle_service_log`. That table drives a clean, kilometre-ordered history the vehicle owner can view — showing what was done, when, at what mileage, and with attached photos.

The items and photos are not duplicated — they stay in `invoice_items` and `photos` and are joined at read time. The log table just holds the key indexable fields per invoice so queries by vehicle + odometer are fast.

---

## New table: `vehicle_service_log`

One row per invoice. Written automatically when an invoice is created. Updated when the invoice is updated. Deleted when the invoice is deleted (cascade).

```sql
CREATE TABLE vehicle_service_log (
  id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  invoice_id     BIGINT UNSIGNED NOT NULL,
  vehicle_rego   VARCHAR(20)     NOT NULL,
  invoice_number VARCHAR(20)     NOT NULL,
  service_date   DATE            NOT NULL,   -- date of invoice creation
  odometer       INT UNSIGNED    NULL,       -- odometer_in from invoice
  store          VARCHAR(100)    NULL,       -- store name (denormalised for read speed)
  tech           VARCHAR(100)    NULL,       -- "F. LastName" (denormalised)
  total          DECIMAL(10,2)   NOT NULL DEFAULT 0,
  status         ENUM('draft','sent','paid') NOT NULL DEFAULT 'draft',
  ai_summary     TEXT            NULL,       -- AI-generated plain English summary of the service
  created_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  UNIQUE KEY     uq_vsl_invoice  (invoice_id),
  INDEX          idx_vsl_rego_odo  (vehicle_rego, odometer DESC),
  INDEX          idx_vsl_rego_date (vehicle_rego, service_date DESC),

  FOREIGN KEY    fk_vsl_invoice (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

**Why denormalise `store` and `tech`?**
The history view is customer-facing and needs to be fast. Avoiding a JOIN to `stores` and `staff` on every history read is worth the small duplication. These values rarely change after an invoice is raised.

---

## When the log is written

| Invoice event | Log action |
|---------------|------------|
| `POST /invoices` (create) | INSERT row |
| `POST /jobs/:id/invoice` (create from job) | INSERT row |
| `PATCH /invoices/:id` (odometer, date, staff change) | UPDATE row |
| `DELETE /invoices/:id` | CASCADE DELETE (FK handles it) |
| `POST /invoices/:id/send` | UPDATE status → `sent` |
| `POST /invoices/:id/mark-paid` | UPDATE status → `paid` |

Draft invoices are included from the moment of creation — they represent work that's in progress or just completed. The `status` field on the log reflects the invoice status so the history view can filter or label accordingly.

---

## API endpoint

### GET /vehicles/{rego}/service-history

Returns the kilometre-ordered service history for a vehicle. Intended as a clean owner-facing view — no internal notes, no draft-specific fields.

```
GET /vehicles/ABC123/service-history
GET /vehicles/ABC123/service-history?limit=20&beforeOdometer=80000
Authorization: Bearer <accessToken>
```

**Query parameters:**

| Param | Type | Notes |
|-------|------|-------|
| `limit` | number | Page size. Default `25`, max `100`. |
| `beforeOdometer` | number | Cursor — entries with odometer less than this value (pagination). |
| `beforeDate` | string | Secondary cursor (`YYYY-MM-DD`) for entries without an odometer reading. |

**Response `200`:**

```json
{
  "vehicle": {
    "rego": "ABC123",
    "label": "2018 Toyota Camry",
    "odometerCurrent": 87500
  },
  "history": [
    {
      "invoiceId": 3,
      "invoiceNumber": "INV-2606-001",
      "invoiceUrl": "/invoice/93bf8765986ce661058f1de95ff04242447b59040e16e5cd9d1abeaf8a97f0de",
      "serviceDate": "2026-06-19",
      "odometer": 87000,
      "store": "Rodz Frankston",
      "tech": "J. Smith",
      "total": 495.00,
      "status": "paid",
      "aiSummary": "Your vehicle received a full service including an oil and filter change. Rear brake pads were replaced on both sides — photos show significant wear before replacement. Wiper blades were also renewed.",
      "items": [
        { "description": "Full service",     "type": "labour", "qty": 1,  "unitPrice": 180.00 },
        { "description": "Oil filter",        "type": "part",   "qty": 1,  "unitPrice": 45.00  },
        { "description": "Rear brake pads",   "type": "part",   "qty": 2,  "unitPrice": 135.00 }
      ],
      "photos": [
        {
          "id": 12,
          "imageId": "abc-123",
          "caption": "Worn rear pads — metal on metal",
          "urls": {
            "thumbnail": "https://imagedelivery.net/.../thumbnail",
            "public":    "https://imagedelivery.net/.../public"
          }
        }
      ]
    },
    {
      "invoiceId": 1,
      "invoiceNumber": "INV-2504-001",
      "serviceDate": "2026-04-03",
      "odometer": 82500,
      "store": "Rodz Frankston",
      "tech": "J. Smith",
      "total": 220.00,
      "status": "paid",
      "items": [
        { "description": "Interim service",  "type": "labour", "qty": 1, "unitPrice": 150.00 },
        { "description": "Wiper blades",     "type": "part",   "qty": 2, "unitPrice": 35.00  }
      ],
      "photos": []
    }
  ],
  "hasMore": false,
  "nextCursor": null,
  "nextCursorDate": null
}
```

**History entry fields:**

| Field | Type | Notes |
|-------|------|-------|
| `invoiceId` | number | Links back to the full invoice |
| `invoiceNumber` | string | Display reference e.g. `INV-2606-001` |
| `invoiceUrl` | string \| null | Public invoice URL (`/invoice/{token}`). Null until the invoice is sent. |
| `serviceDate` | string | `YYYY-MM-DD` — date invoice was created |
| `odometer` | number \| null | km at time of service. Null if not recorded on the invoice. |
| `store` | string | Store that did the work |
| `tech` | string | Technician who raised the invoice (`"F. LastName"`) |
| `total` | number | Invoice total inc. GST |
| `status` | string | `draft` \| `sent` \| `paid` |
| `aiSummary` | string \| null | AI-generated plain English summary of the service. Null until generated. |
| `items` | array | All line items on the invoice |
| `items[].description` | string | Line item label |
| `items[].type` | string | `labour` \| `part` \| `other` |
| `items[].qty` | number | Quantity |
| `items[].unitPrice` | number | Price per unit |
| `photos` | array | All photos across all invoice items — returned flat, sorted by upload date |
| `photos[].urls.thumbnail` | string | Use for gallery / timeline cards |
| `photos[].urls.public` | string | Use for full-screen view |

**Sort order:** `odometer DESC`, then `serviceDate DESC` for entries without odometer. Entries with no odometer reading appear at the bottom.

---

## Implementation plan

### Step 1 — DB migration

Run this on the database:

```sql
CREATE TABLE vehicle_service_log (
  id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  invoice_id     BIGINT UNSIGNED NOT NULL,
  vehicle_rego   VARCHAR(20)     NOT NULL,
  invoice_number VARCHAR(20)     NOT NULL,
  service_date   DATE            NOT NULL,
  odometer       INT UNSIGNED    NULL,
  store          VARCHAR(100)    NULL,
  tech           VARCHAR(100)    NULL,
  total          DECIMAL(10,2)   NOT NULL DEFAULT 0,
  status         ENUM('draft','sent','paid') NOT NULL DEFAULT 'draft',
  created_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  UNIQUE KEY     uq_vsl_invoice    (invoice_id),
  INDEX          idx_vsl_rego_odo  (vehicle_rego, odometer DESC),
  INDEX          idx_vsl_rego_date (vehicle_rego, service_date DESC),

  FOREIGN KEY    fk_vsl_invoice (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

Backfill existing invoices:

```sql
INSERT INTO vehicle_service_log
  (invoice_id, vehicle_rego, invoice_number, service_date, odometer, store, tech, total, status)
SELECT
  i.id,
  i.vehicle_rego,
  i.invoice_number,
  DATE(i.created_at),
  i.odometer_in,
  s.name,
  CONCAT(LEFT(st.first_name, 1), '. ', st.last_name),
  i.total,
  i.status
FROM invoices i
JOIN stores s  ON s.id  = i.store_id
JOIN staff  st ON st.id = i.staff_id
ON DUPLICATE KEY UPDATE invoice_id = invoice_id;
```

### Step 2 — Write to log from invoice handlers

Add a shared helper to `src/invoices/_helpers.ts`:

```typescript
export async function upsertServiceLog(db: mysql.Pool, invoiceId: number) {
  await db.query(`
    INSERT INTO vehicle_service_log
      (invoice_id, vehicle_rego, invoice_number, service_date, odometer, store, tech, total, status)
    SELECT
      i.id, i.vehicle_rego, i.invoice_number, DATE(i.created_at),
      i.odometer_in,
      s.name,
      CONCAT(LEFT(st.first_name, 1), '. ', st.last_name),
      i.total, i.status
    FROM invoices i
    JOIN stores s  ON s.id  = i.store_id
    JOIN staff  st ON st.id = i.staff_id
    WHERE i.id = ?
    ON DUPLICATE KEY UPDATE
      odometer   = VALUES(odometer),
      total      = VALUES(total),
      status     = VALUES(status),
      store      = VALUES(store),
      tech       = VALUES(tech),
      updated_at = NOW()
  `, [invoiceId])
}
```

`ai_summary` is intentionally excluded from the upsert — it is written separately by the AI generation step and must not be overwritten on every invoice update.

The `invoiceUrl` is constructed at read time from `invoices.token` — it is not stored in the log table. When the history endpoint returns an entry, it joins back to the invoice to get the token and builds `/invoice/{token}` if the token is non-null.
```

Call `upsertServiceLog(db, insertId)` at the end of:
- `src/invoices/create.ts`
- `src/invoices/create-from-job.ts`
- `src/invoices/update.ts`
- `src/invoices/send.ts`
- `src/invoices/mark-paid.ts`

Deletion is handled automatically by the `ON DELETE CASCADE` foreign key.

### Step 3 — History GET endpoint

New file: `src/vehicles/service-history.ts`

Reads from `vehicle_service_log`, joins `invoice_items` and `photos` for the full picture. Sorted by `odometer DESC, service_date DESC`. Cursor-paginated.

Register in `cdk/lib/rodz-api-stack2.ts`:

```
GET /vehicles/{rego}/service-history
```

---

## Frontend — owner history view

**Layout per history card:**

```
┌─────────────────────────────────────────────────────┐
│  87,000 km          Jun 2026          Rodz Frankston │
│                                        J. Smith      │
├─────────────────────────────────────────────────────┤
│  "Your vehicle received a full service including     │
│   an oil and filter change. Rear brake pads were     │
│   replaced on both sides — photos show significant   │
│   wear before replacement."                          │
│                                                      │
│   View invoice →                                     │
├─────────────────────────────────────────────────────┤
│  [photo] [photo]                      Total $495 ✓  │
└─────────────────────────────────────────────────────┘
```

- `aiSummary` is the primary text body of the card — human-readable narrative of what was done
- `invoiceUrl` renders as a **"View invoice →"** link directly beneath the summary. Only show if `invoiceUrl` is not null (invoice has been sent)
- The invoice link opens the full public invoice page (`/invoice/{token}`) — the same page the customer received by email. It shows all line items, photos, totals, and payment status.
- Show `odometer` as `87,000 km` (thousands separator, always)
- If `odometer` is null, show `"Odometer not recorded"` in that position
- `status: paid` → green tick. `status: sent` → "Invoice sent". `status: draft` → grey "In progress" (hide from owner-facing view if preferred)
- Photos render as a horizontal thumbnail strip using `urls.thumbnail`. Tap → full-screen `urls.public`
- Sort is newest (highest km) at top

**Important:** Always use `<img src={urls.thumbnail}>` — never `fetch()` Cloudflare image URLs (CORS blocked in browser).
