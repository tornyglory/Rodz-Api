# Purchase Orders — Pagination, Search & Detail

This covers all recent changes to the purchase orders endpoints. See `purchase-orders.md` for the full reference.

---

## GET /purchase-orders — pagination

`GET /purchase-orders` now returns `total`, `limit`, and `offset` alongside the array. The existing `status`, `search`, `jobId`, and `storeId` filters are unchanged.

### New query params

| Param | Type | Default | Max |
|-------|------|---------|-----|
| `limit` | number | `50` | `200` |
| `offset` | number | `0` | — |

### Updated response shape

```json
{
  "purchaseOrders": [...],
  "total": 38,
  "limit": 50,
  "offset": 0
}
```

### Paging

```
page 1 → GET /purchase-orders?limit=50&offset=0
page 2 → GET /purchase-orders?limit=50&offset=50
```

Total pages = `Math.ceil(total / limit)`.  
Has next page = `offset + purchaseOrders.length < total`.

### Combining filters

```
GET /purchase-orders?status=ordered&limit=50&offset=0
GET /purchase-orders?search=Repco&limit=20&offset=0
GET /purchase-orders?storeId=1&status=draft&limit=50&offset=50
```

> `jobId` is typically used to load POs for a specific job — pagination still applies but is less relevant there.

### Search fields

`search` does a partial match across:
- PO number (e.g. `PO-2606-001`)
- Supplier name

---

## GET /purchase-orders/{id} — single PO

Returns one purchase order by ID with all items included.

```
GET /purchase-orders/1
Authorization: Bearer <accessToken>
```

### Response `200`

```json
{
  "purchaseOrder": {
    "id": 1,
    "poNumber": "PO-2606-001",
    "storeId": 1,
    "supplier": "Bursons",
    "status": "draft",
    "orderedAt": null,
    "expectedDelivery": "2026-06-10",
    "receivedAt": null,
    "subtotal": 400.00,
    "gst": 40.00,
    "total": 440.00,
    "supplierInvoiceRef": null,
    "notes": "Leave at the door.",
    "createdByStaffId": 1,
    "createdAt": "2026-06-08T00:05:14.000Z",
    "items": [
      {
        "id": 1,
        "partId": 1,
        "serviceJobId": 5,
        "description": "Tyre",
        "partNumber": "GDB1232",
        "quantityOrdered": 4,
        "quantityReceived": 0,
        "unitCost": 100.00,
        "notes": null
      }
    ]
  }
}
```

### Field notes

| Field | Notes |
|-------|-------|
| `poNumber` | Format `PO-YYMM-NNN` e.g. `PO-2606-001`. |
| `status` | `draft` → `ordered` → `partial` → `received`. Can also be `cancelled`. |
| `orderedAt` | ISO datetime. `null` until status advances to `ordered`. |
| `expectedDelivery` | ISO date `YYYY-MM-DD`. `null` if not set. |
| `receivedAt` | ISO datetime. `null` until status reaches `received`. |
| `subtotal` / `gst` / `total` | Computed from items. `gst` is always 10% of `subtotal`. |
| `supplierInvoiceRef` | Optional supplier invoice number. `null` if not set. |
| `createdByStaffId` | FK to staff who created the PO. |
| `items[].partId` | FK to parts catalogue. `null` if entered manually. |
| `items[].serviceJobId` | FK to the job this part is for. `null` if not linked. |
| `items[].partNumber` | Supplier part number. `null` if not set. |
| `items[].quantityReceived` | Incremented as stock arrives. Used to derive `partial` status. |

### Errors

| Status | Code | When |
|--------|------|------|
| `404` | `NOT_FOUND` | PO does not exist |
| `403` | `FORBIDDEN` | Outside the caller's store access |

---

## Bugs fixed in this release

| Bug | Detail |
|-----|--------|
| `GET /purchase-orders/{id}` was returning 500 | `deleted_at` column referenced before DB migration was run — fixed |
| `expectedDelivery` was returning `"Wed Jun 10"` | Date formatting bug in response builder — now correctly returns `"2026-06-10"` |
