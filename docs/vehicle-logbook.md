# Vehicle Digital Logbook — Frontend Brief

**Base URL:** `https://fzzrkscwd7.execute-api.ap-southeast-2.amazonaws.com`

---

## Overview

The Digital Logbook gives customers a public, shareable URL showing the full service history for their vehicle — no login required. The flow:

1. Staff opens a vehicle in the portal and generates a logbook token (idempotent — safe to call repeatedly)
2. A shareable link is constructed: `https://<your-frontend>/logbook/<token>`
3. The public logbook page fetches the vehicle's service history using that token — no auth header needed

---

## Endpoints

---

### POST /vehicles/{rego}/logbook-token

Generates a logbook token for the vehicle, or returns the existing one if already created. Safe to call multiple times — always returns the same token once set.

**Requires:** `Authorization: Bearer <accessToken>`

```
POST /vehicles/ABC123/logbook-token
Authorization: Bearer <accessToken>
```

**Response `200`**

```json
{
  "token": "a3f9c2e1d4b7082f6e5c1a0d3b9f4e2c8a7d1f0e6b3c5a2d9e4f7b0c1a3d8e6"
}
```

| Status | Code | When |
|--------|------|------|
| `404` | `NOT_FOUND` | Vehicle not found or inactive |

**Usage:** Construct the shareable URL as `https://<your-frontend>/logbook/<token>` and display it to the staff member (copy button, QR code, etc.).

---

### GET /logbook/{token}

Returns the full service history for the vehicle identified by the token. **No authentication required** — this is a public endpoint intended for customer-facing pages.

```
GET /logbook/a3f9c2e1d4b7082f6e5c1a0d3b9f4e2c8a7d1f0e6b3c5a2d9e4f7b0c1a3d8e6
```

#### Pagination

History is sorted by odometer (descending), then by service date (descending). Default page size is 25, max 100.

| Param | Type | Notes |
|-------|------|-------|
| `limit` | number | Records per page. Default `25`, max `100`. |
| `beforeOdometer` | number | Cursor for the next page — pass `nextCursor` from the previous response. |

**First page:**
```
GET /logbook/{token}
```

**Next page (cursor-based):**
```
GET /logbook/{token}?beforeOdometer=85000&limit=25
```

**Response `200`**

```json
{
  "vehicle": {
    "rego": "ABC123",
    "label": "2019 Toyota Camry",
    "odometerCurrent": 92450
  },
  "lifetimeTotal": 3840.00,
  "history": [
    {
      "invoiceId": 42,
      "invoiceNumber": "INV-2405-042",
      "invoiceUrl": "https://<frontend>/invoice/<invoice-token>",
      "serviceDate": "2024-05-12",
      "odometer": 91200,
      "store": "Rodz Automotive Penrose",
      "tech": "Mike",
      "total": 320.00,
      "status": "paid",
      "aiSummary": "Full synthetic oil service and brake fluid flush. Rear pads at 40% — monitor at next visit.",
      "items": [
        {
          "description": "Synthetic Engine Oil 5W-30",
          "type": "part",
          "qty": 5,
          "unitPrice": 18.00
        },
        {
          "description": "Oil Filter",
          "type": "part",
          "qty": 1,
          "unitPrice": 12.00
        },
        {
          "description": "Labour — Oil Service",
          "type": "labour",
          "qty": 1,
          "unitPrice": 110.00
        }
      ],
      "photos": [
        {
          "url": "https://imagedelivery.net/...",
          "thumbnailUrl": "https://imagedelivery.net/.../thumbnail"
        }
      ]
    }
  ],
  "hasMore": true,
  "nextCursor": 91200
}
```

| Status | Code | When |
|--------|------|------|
| `404` | `NOT_FOUND` | Token not found or vehicle inactive |

---

## Field reference

### `vehicle`

| Field | Type | Notes |
|-------|------|-------|
| `rego` | string | Vehicle registration |
| `label` | string \| null | `"YYYY Make Model"` e.g. `"2019 Toyota Camry"` |
| `odometerCurrent` | number \| null | Latest recorded odometer reading |

### `history[]`

| Field | Type | Notes |
|-------|------|-------|
| `invoiceId` | number | |
| `invoiceNumber` | string | e.g. `"INV-2405-042"` |
| `invoiceUrl` | string \| null | Deep link to the customer-facing invoice page |
| `serviceDate` | string | `YYYY-MM-DD` |
| `odometer` | number \| null | Odometer at time of service |
| `store` | string \| null | Store name |
| `tech` | string \| null | Technician name |
| `total` | number | Invoice total (inc. GST) |
| `status` | string | `sent` \| `paid` |
| `aiSummary` | string \| null | AI-generated plain-English summary of the service |
| `items` | array | Line items — see below |
| `photos` | array | All photos attached to this invoice's line items |

### `history[].items[]`

| Field | Type | Notes |
|-------|------|-------|
| `description` | string | |
| `type` | string | `part` \| `labour` \| `other` |
| `qty` | number | |
| `unitPrice` | number | Retail price (safe to display to customer) |

### Pagination fields

| Field | Type | Notes |
|-------|------|-------|
| `hasMore` | boolean | `true` if another page exists |
| `nextCursor` | number \| null | Pass as `?beforeOdometer=<value>` to fetch the next page. `null` if no more pages or if the last record has no odometer. |
| `lifetimeTotal` | number | Sum of all sent/paid invoices for this vehicle — display as a headline stat |

---

## Frontend implementation guide

### Staff portal — sharing the logbook

On the vehicle detail screen, add a "Share Logbook" button:

```
POST /vehicles/{rego}/logbook-token
→ token returned
→ construct URL: https://<your-frontend>/logbook/<token>
→ show copy-to-clipboard + optional QR code
```

The token is permanent once generated. Subsequent calls return the same token, so it's safe to call on every page load.

### Public logbook page (`/logbook/:token`)

This page requires **no login**. Fetch on load:

```
GET /logbook/{token}
→ render vehicle header (rego, label, odometerCurrent, lifetimeTotal)
→ render history list sorted by odometer descending
```

**Suggested page layout:**

- **Header:** vehicle label + rego, current odometer, lifetime spend
- **Timeline/list:** one card per service visit
  - Date + odometer
  - Store + tech
  - AI summary (if present) — highlight this prominently
  - Line items (collapsible)
  - Photos (lightbox)
  - "View Invoice" link (if `invoiceUrl` is set)

### Infinite scroll / load more

```
GET /logbook/{token}                           // first page
→ if hasMore, show "Load more" button
→ GET /logbook/{token}?beforeOdometer={nextCursor}  // next page
→ append to list
```

If `nextCursor` is `null` but `hasMore` is `true`, the last record has no odometer — fall back to omitting the `beforeOdometer` param (this edge case is rare).
