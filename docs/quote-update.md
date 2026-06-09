# PATCH /quotes/{id} — Update Quote

Single endpoint for all quote mutations: line items, metadata, status transitions, and odometer.

---

## Request

```
PATCH /quotes/{id}
Authorization: Bearer <accessToken>
Content-Type: application/json
```

Send only the fields you want to change. Every field is optional, but at least one must be present.

---

## Fields

| Field | Type | Notes |
|-------|------|-------|
| `items` | `Item[]` | Replaces the **entire** item list. Send the complete desired list — this is not additive. Totals are recalculated automatically. Blocked on `approved`, `invoiced`, `paid`. |
| `notes` | `string \| null` | Internal notes. Overwrites the current value. Send `null` to clear. |
| `odometerIn` | `number \| null` | Vehicle odometer reading at quote time. Send `null` to clear. |
| `techId` | `number` | Reassign the quote to a different staff member (by `staff.id`). |
| `bookingId` | `number \| null` | Link or unlink the quote from a booking. Send `null` to unlink. |
| `status` | `string` | Status transition — see [Status transitions](#status-transitions) below. |

---

## Status transitions

Only specific transitions are accepted. Any other `status` value returns `409 INVALID_TRANSITION`.

| Current status | Allowed `status` values |
|----------------|------------------------|
| `sent` | `rejected` |
| `approved` | `invoiced` |
| `invoiced` | `paid` |

**Draft → Sent is handled separately.** Sending `status: "sent"` on a draft quote returns `409 USE_SEND_ENDPOINT` — use `POST /quotes/{id}/send` instead.

---

## Item object shape

Each entry in the `items` array:

| Field | Type | Notes |
|-------|------|-------|
| `description` | `string` | Required. Line item label shown on the quote. |
| `type` | `"labour" \| "part"` | Defaults to `"labour"` if omitted. |
| `qty` | `number` | Defaults to `1` if omitted. |
| `unitPrice` | `number` | Required. Price per unit (ex-GST). |
| `hours` | `number \| null` | Labour hours — optional, display only. |
| `catalogItemId` | `number \| null` | Link to a catalog item. Silently nulled if the ID doesn't exist. |
| `serviceTypeId` | `number \| null` | Link to a service type. Silently nulled if the ID doesn't exist. |
| `partId` | `number \| null` | Explicit part ID. Use when referencing an existing part record. |
| `partNumber` | `string \| null` | Part number — triggers upsert into `parts` table if `type = "part"`. |
| `partName` | `string \| null` | Part name for the upsert. Falls back to `description` if omitted. |
| `supplierId` | `number \| null` | Supplier for the part upsert. |
| `costPrice` | `number \| null` | Cost price for the part upsert. |

---

## Example — update odometer and notes

```json
{
  "odometerIn": 87400,
  "notes": "Customer mentioned grinding noise at low speed"
}
```

## Example — replace all line items

```json
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
      "partNumber": "BP-1234",
      "qty": 1,
      "unitPrice": 95.00
    }
  ]
}
```

## Example — advance status to invoiced

```json
{ "status": "invoiced" }
```

## Example — clear odometer

```json
{ "odometerIn": null }
```

---

## Response `200`

Returns the full updated quote object — same shape as `POST /quotes`.

```json
{
  "quote": {
    "id": 31,
    "quoteNumber": "Q-2506-007",
    "bookingId": 14,
    "customerName": "Sarah Mitchell",
    "customerEmail": "sarah@example.com",
    "customerPhone": "021 555 1234",
    "vehicle": "2018 Toyota Camry",
    "rego": "ABC123",
    "store": "Penrose",
    "tech": "J. Smith",
    "status": "invoiced",
    "notes": "Customer mentioned grinding noise at low speed",
    "odometerIn": 87400,
    "token": null,
    "sentAt": "2026-06-01T03:00:00.000Z",
    "createdAt": "2026-05-28",
    "subtotal": 275.00,
    "gst": 27.50,
    "total": 302.50,
    "items": [
      {
        "id": 88,
        "catalogItemId": 4,
        "partId": null,
        "partNumber": null,
        "partName": null,
        "costPrice": null,
        "serviceTypeId": null,
        "supplierId": null,
        "supplierName": null,
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

### `approved` field on items

| Value | Meaning |
|-------|---------|
| `null` | Customer hasn't reviewed (quote is draft or sent) |
| `true` | Customer approved this line item |
| `false` | Customer rejected this line item |

---

## Errors

| Status | Code | When |
|--------|------|------|
| `404` | `QUOTE_NOT_FOUND` | Quote does not exist |
| `422` | `VALIDATION_ERROR` | No recognised fields sent |
| `409` | `QUOTE_LOCKED` | `items` sent but quote is `approved`, `invoiced`, or `paid` |
| `409` | `INVALID_TRANSITION` | `status` value is not a valid transition from the current status |
| `409` | `USE_SEND_ENDPOINT` | Sent `status: "sent"` on a draft — use `POST /quotes/{id}/send` |
| `403` | `FORBIDDEN` | Caller is not the quote owner, not a manager, or outside store access |

---

## Locked statuses

Items (`items` field) cannot be modified once the quote reaches any of these statuses:

- `approved`
- `invoiced`
- `paid`

All other fields (`notes`, `odometerIn`, `techId`, `bookingId`, `status`) remain editable on locked quotes, subject to valid status transitions.
