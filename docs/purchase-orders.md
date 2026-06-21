# Purchase Orders — Frontend Brief

**Base URL:** `https://fzzrkscwd7.execute-api.ap-southeast-2.amazonaws.com`

All routes require `Authorization: Bearer <accessToken>`.

---

## Overview

A purchase order (PO) tracks parts ordered from a supplier for a specific job. The typical flow:

1. Customer approves a quote — some line items are `part` type with `approved: true`
2. Staff creates a PO from those approved part items (or manually)
3. PO is marked `ordered` when the order is placed with the supplier
4. Staff records received quantities as parts arrive — PO auto-advances to `partial` or `received`
5. Job can proceed — the job drawer shows a parts status badge

**Role access:**

| Action | Who |
|--------|-----|
| Read (`GET`) | All roles |
| Create / Update / Delete | `store_manager` and `super_admin` only |

---

## Status lifecycle

```
draft → ordered → partial → received
      ↘         ↘         ↘
        cancelled  cancelled  cancelled
```

| Status | Meaning |
|--------|---------|
| `draft` | Created but not yet sent to supplier |
| `ordered` | Order placed — `orderedAt` is set |
| `partial` | Some items received, awaiting the rest |
| `received` | All items received — `receivedAt` is set |
| `cancelled` | Order cancelled |

Status transitions are enforced by the backend. Invalid transitions return `409 INVALID_TRANSITION`.

---

## Endpoints

---

### GET /purchase-orders

Returns purchase orders for the caller's store(s) with pagination and search.

```
GET /purchase-orders
GET /purchase-orders?status=ordered&limit=50&offset=0
GET /purchase-orders?search=Repco
GET /purchase-orders?jobId=42
GET /purchase-orders?storeId=1
Authorization: Bearer <accessToken>
```

| Param | Type | Notes |
|-------|------|-------|
| `search` | string | Partial match on `poNumber` or `supplier` name. |
| `status` | string | One of `draft`, `ordered`, `partial`, `received`, `cancelled`. |
| `jobId` | number | Returns all POs that have at least one item linked to this job. |
| `storeId` | number | `super_admin` only — filter to a specific store. |
| `limit` | number | Page size. Default `50`, max `200`. |
| `offset` | number | Number of records to skip. Default `0`. |

### Response `200`

```json
{
  "stats": {
    "totalPOs": 38,
    "awaitingDelivery": 5,
    "receivedThisMonth": 12,
    "totalSpend": 8640.00
  },
  "purchaseOrders": [
    {
      "id": 1,
      "poNumber": "PO-2606-001",
      "storeId": 1,
      "supplier": "Repco",
      "status": "ordered",
      "orderedAt": "2026-06-07T09:00:00Z",
      "expectedDelivery": "2026-06-09",
      "receivedAt": null,
      "subtotal": 96.00,
      "gst": 9.60,
      "total": 105.60,
      "supplierInvoiceRef": null,
      "notes": "Call James on arrival",
      "createdByStaffId": 3,
      "createdAt": "2026-06-07T08:45:00Z",
      "items": [
        {
          "id": 1,
          "partId": 5,
          "serviceJobId": 12,
          "description": "Front Brake Pad Set",
          "quantityOrdered": 1,
          "quantityReceived": 0,
          "unitCost": 48.00,
          "notes": null
        }
      ]
    }
  ],
  "total": 38,
  "limit": 50,
  "offset": 0
}
```

Items are always included in the list response — no second fetch needed.

Total pages = `Math.ceil(total / limit)`. Has next page = `offset + purchaseOrders.length < total`.

> **`stats` block** — store-scoped aggregate figures, unaffected by `status`, `search`, or `jobId` filters.

| Field | Type | Notes |
|-------|------|-------|
| `stats.totalPOs` | number | All purchase orders in scope |
| `stats.awaitingDelivery` | number | POs with status `ordered` or `partial` — parts on the way |
| `stats.receivedThisMonth` | number | POs moved to `received` this calendar month |
| `stats.totalSpend` | number | Sum of totals for `ordered`, `partial`, and `received` POs — money committed or landed |

---

### GET /purchase-orders/{id}

Returns a single PO with full item list.

```
GET /purchase-orders/1
Authorization: Bearer <accessToken>
```

**Response `200`** — `{ "purchaseOrder": { ... } }` — same shape as a list item.

| Status | Code | When |
|--------|------|------|
| `404` | `NOT_FOUND` | PO not found or deleted |

---

### POST /purchase-orders

Creates a new PO in `draft` status. Items are required at creation — add more later via `POST /purchase-orders/{id}/items`.

```
POST /purchase-orders
Authorization: Bearer <accessToken>
Content-Type: application/json

{
  "supplier": "Repco",
  "expectedDelivery": "2026-06-09",
  "notes": "Call James on arrival",
  "storeId": 1,
  "items": [
    {
      "description": "Front Brake Pad Set",
      "quantityOrdered": 1,
      "unitCost": 48.00,
      "partId": 5,
      "serviceJobId": 12,
      "notes": null
    }
  ]
}
```

| Field | Required | Notes |
|-------|----------|-------|
| `supplier` | Yes | Free-text supplier name. |
| `items` | Yes | At least one item. |
| `items[].description` | Yes | |
| `items[].quantityOrdered` | Yes | |
| `items[].unitCost` | Yes | Cost price — what you pay the supplier. Never show to customers. |
| `storeId` | No | Defaults to caller's primary store. |
| `expectedDelivery` | No | `YYYY-MM-DD`. |
| `notes` | No | Internal notes e.g. delivery instructions. |
| `items[].partId` | No | FK to `parts` table if using a catalogued part. |
| `items[].serviceJobId` | No | FK to `service_jobs` — links item to a specific job. |
| `items[].notes` | No | Per-item notes. |

`subtotal`, `gst`, and `total` are calculated by the backend from the items.

**Response `201`** — `{ "purchaseOrder": { ... } }`.

| Status | Code | When |
|--------|------|------|
| `422` | `VALIDATION_ERROR` | `supplier` or `items` missing / item missing required fields |
| `403` | `FORBIDDEN` | Technician role |

---

### PATCH /purchase-orders/{id}

Update the PO header. Send only the fields you want to change.

```
PATCH /purchase-orders/1
Authorization: Bearer <accessToken>
Content-Type: application/json

{ "status": "ordered" }
```

| Field | Notes |
|-------|-------|
| `status` | Triggers a status transition. `ordered` sets `orderedAt`. `received` sets `receivedAt`. |
| `expectedDelivery` | `YYYY-MM-DD`. Send `null` to clear. |
| `supplierInvoiceRef` | Supplier's invoice number — record when parts arrive. Send `null` to clear. |
| `notes` | Internal notes. Send `null` to clear. |

**Response `200`** — `{ "purchaseOrder": { ... } }`.

| Status | Code | When |
|--------|------|------|
| `404` | `NOT_FOUND` | PO not found |
| `409` | `INVALID_TRANSITION` | Status transition not allowed |
| `422` | `VALIDATION_ERROR` | No fields sent |
| `403` | `FORBIDDEN` | Technician role |

---

### DELETE /purchase-orders/{id}

Cancels the PO. Only allowed on `draft` or `ordered` POs. Sets `status = cancelled` and soft-deletes the record.

```
DELETE /purchase-orders/1
Authorization: Bearer <accessToken>
```

**Response `204`** — no content.

| Status | Code | When |
|--------|------|------|
| `404` | `NOT_FOUND` | PO not found |
| `409` | `PO_NOT_CANCELLABLE` | PO is `partial`, `received`, or already `cancelled` |
| `403` | `FORBIDDEN` | Technician role |

---

## Item endpoints

All item endpoints return the full updated PO (header + all items) so the UI can re-render in one step.

---

### POST /purchase-orders/{id}/items

Adds a new item to an existing PO. Only allowed on `draft` POs.

```
POST /purchase-orders/1/items
Authorization: Bearer <accessToken>
Content-Type: application/json

{
  "description": "Oil Filter",
  "quantityOrdered": 2,
  "unitCost": 12.50,
  "partId": 8,
  "serviceJobId": 12,
  "notes": null
}
```

| Field | Required | Notes |
|-------|----------|-------|
| `description` | Yes | |
| `quantityOrdered` | Yes | |
| `unitCost` | Yes | Cost price. |
| `partId` | No | |
| `serviceJobId` | No | |
| `notes` | No | |

PO totals (`subtotal`, `gst`, `total`) are recalculated automatically.

**Response `200`** — `{ "purchaseOrder": { ... } }` with updated items and totals.

| Status | Code | When |
|--------|------|------|
| `404` | `NOT_FOUND` | PO not found |
| `409` | `INVALID_STATE` | PO is not in `draft` status |
| `422` | `VALIDATION_ERROR` | Required fields missing |
| `403` | `FORBIDDEN` | Technician role |

---

### PATCH /purchase-orders/{id}/items/{itemId}

Two modes depending on which fields you send:

**Mode 1 — Edit item details** (`draft` POs only)

```
PATCH /purchase-orders/1/items/1
Authorization: Bearer <accessToken>
Content-Type: application/json

{ "description": "Rear Brake Pad Set", "unitCost": 52.00 }
```

| Field | Notes |
|-------|-------|
| `description` | |
| `quantityOrdered` | Recalculates PO totals. |
| `unitCost` | Recalculates PO totals. |
| `notes` | Send `null` to clear. |

**Mode 2 — Record received quantity** (`ordered` or `partial` POs only)

```
PATCH /purchase-orders/1/items/1
Authorization: Bearer <accessToken>
Content-Type: application/json

{ "quantityReceived": 1 }
```

| Field | Notes |
|-------|-------|
| `quantityReceived` | How many have arrived. Backend auto-advances PO to `partial` (some received) or `received` (all received). |

**Response `200`** — `{ "purchaseOrder": { ... } }` with updated items and status.

| Status | Code | When |
|--------|------|------|
| `404` | `NOT_FOUND` | PO or item not found |
| `409` | `INVALID_STATE` | Wrong PO status for the operation |
| `422` | `VALIDATION_ERROR` | No fields sent / negative quantity |
| `403` | `FORBIDDEN` | Technician role |

---

### DELETE /purchase-orders/{id}/items/{itemId}

Removes an item from a PO. Only allowed on `draft` POs. Recalculates PO totals.

```
DELETE /purchase-orders/1/items/1
Authorization: Bearer <accessToken>
```

**Response `200`** — `{ "purchaseOrder": { ... } }` with the item removed and totals updated.

| Status | Code | When |
|--------|------|------|
| `404` | `NOT_FOUND` | PO or item not found |
| `409` | `INVALID_STATE` | PO is not in `draft` status |
| `403` | `FORBIDDEN` | Technician role |

---

## Object reference

### Purchase order object

| Field | Type | Notes |
|-------|------|-------|
| `id` | number | |
| `poNumber` | string | Auto-generated e.g. `PO-2606-001` |
| `storeId` | number | |
| `supplier` | string | |
| `status` | string | `draft` \| `ordered` \| `partial` \| `received` \| `cancelled` |
| `orderedAt` | string \| null | UTC ISO-8601 — set when status → `ordered` |
| `expectedDelivery` | string \| null | `YYYY-MM-DD` |
| `receivedAt` | string \| null | UTC ISO-8601 — set when status → `received` |
| `subtotal` | number | Sum of `quantityOrdered × unitCost` across all items |
| `gst` | number | 10% of subtotal |
| `total` | number | subtotal + gst |
| `supplierInvoiceRef` | string \| null | Supplier's invoice number |
| `notes` | string \| null | |
| `createdByStaffId` | number \| null | |
| `createdAt` | string | UTC ISO-8601 |
| `items` | array | Always included |

### Purchase order item object

| Field | Type | Notes |
|-------|------|-------|
| `id` | number | |
| `partId` | number \| null | FK to `parts` table |
| `serviceJobId` | number \| null | FK to `service_jobs` — which job this item is for |
| `description` | string | |
| `quantityOrdered` | number | |
| `quantityReceived` | number | Starts at `0`. Highlight row when < `quantityOrdered`. |
| `unitCost` | number | Cost price — never show to customers |
| `notes` | string \| null | |

---

## Frontend implementation guide

### Creating a PO from an approved quote

When a quote has `status: "approved"` and contains approved part items:

```
GET /quotes/:id
→ filter items where type === "part" && approved === true
→ pre-fill the Create PO form:
    supplier      ← blank (staff selects from GET /suppliers)
    items[].description      ← item.description
    items[].quantityOrdered  ← item.qty
    items[].unitCost         ← item.unitPrice  (use costPrice from parts if available)
    items[].serviceJobId     ← the linked service_jobs.id (if known)
    items[].partId           ← item.partId (if set)
```

### Job drawer — parts status badge

Use `jobId` to check if any POs exist for a job:

```
GET /purchase-orders?jobId=:jobId
→ no results       → no badge (parts not ordered)
→ status draft     → "Preparing order" badge
→ status ordered   → "Parts ordered" badge
→ status partial   → "Partially received" badge  
→ status received  → "Parts ready" badge ✓
```

### Purchase Orders list screen

- Search bar → `GET /purchase-orders?search=...`
- Status filter tabs → `GET /purchase-orders?status=ordered`
- Each row: `poNumber`, `supplier`, status badge, `expectedDelivery`, `total`, item count
- Tap row → drawer with full item list

### PO drawer — receiving parts

When status is `ordered` or `partial`, show a `quantityReceived` input on each item row:

```
PATCH /purchase-orders/{id}/items/{itemId}
{ "quantityReceived": n }
→ backend auto-advances PO status
→ re-render drawer from response
```

When all items are received the PO transitions to `received` automatically — no manual status change needed.

### PO drawer — editing a draft

When status is `draft`, items are editable and new items can be added:

- Edit row → `PATCH /purchase-orders/{id}/items/{itemId}` with changed fields
- Delete row → `DELETE /purchase-orders/{id}/items/{itemId}`
- Add item → `POST /purchase-orders/{id}/items`
- "Place Order" button → `PATCH /purchase-orders/{id}` `{ "status": "ordered" }`
- "Cancel PO" → `DELETE /purchase-orders/{id}`
