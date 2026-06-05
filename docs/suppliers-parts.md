# Suppliers & Parts — Frontend Brief

**Base URL:** `https://fzzrkscwd7.execute-api.ap-southeast-2.amazonaws.com`

All routes require `Authorization: Bearer <accessToken>`.

Suppliers are the companies you buy parts from. Parts are the physical items you stock and sell. The two are linked — each part optionally belongs to a supplier.

**Typical workflow:** Create suppliers first (Settings → Suppliers), then create parts and assign them to a supplier. When building a quote, search parts to pre-fill line item descriptions and pricing.

**Role access:**

| Action | Who |
|--------|-----|
| Read (`GET`) | All roles |
| Create / Update / Delete | `store_manager` and `super_admin` only |

---

## Suppliers

### GET /suppliers

Returns all active suppliers ordered alphabetically.

```
GET /suppliers
GET /suppliers?search=Repco
Authorization: Bearer <accessToken>
```

### Query parameters

| Param | Type | Notes |
|-------|------|-------|
| `search` | string | Partial match on supplier name. |

### Response `200`

```json
{
  "suppliers": [
    {
      "id": 1,
      "name": "Repco",
      "contactName": "James Hewitt",
      "phone": "03 9123 4567",
      "email": "james@repco.com.au",
      "website": "https://repco.com.au",
      "accountNumber": "ROD-0042",
      "notes": "Net 30 terms. Order before 2pm for same-day delivery.",
      "createdAt": "2026-06-05T08:00:00Z"
    }
  ]
}
```

---

### POST /suppliers

```
POST /suppliers
Authorization: Bearer <accessToken>
Content-Type: application/json
```

### Request body

```json
{
  "name": "Repco",
  "contactName": "James Hewitt",
  "phone": "03 9123 4567",
  "email": "james@repco.com.au",
  "website": "https://repco.com.au",
  "accountNumber": "ROD-0042",
  "notes": "Net 30 terms. Order before 2pm for same-day delivery."
}
```

### Field rules

| Field | Required | Notes |
|-------|----------|-------|
| `name` | Yes | Supplier company name. |
| `contactName` | No | Primary contact person. |
| `phone` | No | Contact phone number. |
| `email` | No | Contact email address. |
| `website` | No | Supplier website URL. |
| `accountNumber` | No | Your account number with this supplier. Shown on purchase orders. |
| `notes` | No | Internal notes e.g. terms, delivery info. |

### Response `201`

```json
{
  "supplier": {
    "id": 1,
    "name": "Repco",
    "contactName": "James Hewitt",
    "phone": "03 9123 4567",
    "email": "james@repco.com.au",
    "website": "https://repco.com.au",
    "accountNumber": "ROD-0042",
    "notes": "Net 30 terms. Order before 2pm for same-day delivery.",
    "createdAt": "2026-06-05T08:00:00Z"
  }
}
```

### Errors

| Status | Code | When |
|--------|------|------|
| `422` | `VALIDATION_ERROR` | `name` is missing |
| `403` | `FORBIDDEN` | Technician role |

---

### PATCH /suppliers/{id}

Send only the fields you want to change.

```
PATCH /suppliers/1
Authorization: Bearer <accessToken>
Content-Type: application/json

{
  "accountNumber": "ROD-0099",
  "notes": "Updated — now Net 14 terms."
}
```

### Response `200`

Returns the full updated supplier object wrapped in `{ "supplier": { ... } }`.

### Errors

| Status | Code | When |
|--------|------|------|
| `422` | `VALIDATION_ERROR` | No fields sent |
| `404` | `NOT_FOUND` | Supplier does not exist or is deleted |
| `403` | `FORBIDDEN` | Technician role |

---

### DELETE /suppliers/{id}

Soft-deletes the supplier. Existing parts that reference it are not affected — `supplierName` will return `null` on those parts after deletion.

```
DELETE /suppliers/1
Authorization: Bearer <accessToken>
```

No body. **Response `204`** — no content.

### Errors

| Status | Code | When |
|--------|------|------|
| `404` | `NOT_FOUND` | Supplier does not exist or is already deleted |
| `403` | `FORBIDDEN` | Technician role |

---

## Parts

### GET /parts

Returns all active parts. Supplier name is included in the response — no second fetch needed.

```
GET /parts
GET /parts?supplierId=1
GET /parts?category=brakes
GET /parts?search=brake+pad
Authorization: Bearer <accessToken>
```

### Query parameters

| Param | Type | Notes |
|-------|------|-------|
| `supplierId` | number | Filter to parts from a specific supplier. |
| `category` | string | Exact category match (free-text — whatever was set on the part). |
| `search` | string | Partial match on part name, part number, or supplier part number. |

### Response `200`

```json
{
  "parts": [
    {
      "id": 5,
      "partNumber": "BP-F-001",
      "name": "Front Brake Pad Set",
      "category": "brakes",
      "supplierId": 1,
      "supplierName": "Repco",
      "supplierPartNumber": "REC-DB1234",
      "costPrice": 48.00,
      "sellPrice": 95.00,
      "gstApplicable": true,
      "stockOnHand": 12,
      "reorderPoint": 4
    }
  ]
}
```

---

### POST /parts

```
POST /parts
Authorization: Bearer <accessToken>
Content-Type: application/json
```

### Request body

```json
{
  "partNumber": "BP-F-001",
  "name": "Front Brake Pad Set",
  "category": "brakes",
  "supplierId": 1,
  "supplierPartNumber": "REC-DB1234",
  "costPrice": 48.00,
  "sellPrice": 95.00,
  "gstApplicable": true,
  "stockOnHand": 12,
  "reorderPoint": 4
}
```

### Field rules

| Field | Required | Notes |
|-------|----------|-------|
| `partNumber` | Yes | Your internal part reference e.g. `"BP-F-001"`. Must be unique. |
| `name` | Yes | Part name shown on quotes and job sheets. |
| `costPrice` | Yes | What you pay the supplier — never shown to customers. |
| `sellPrice` | Yes | What you charge the customer. Use this as `unitPrice` when adding to a quote. |
| `category` | No | Free-text category e.g. `"brakes"`, `"filters"`, `"tyres"`. Used for filtering. |
| `supplierId` | No | FK to suppliers. Set this to link the part to a supplier. |
| `supplierPartNumber` | No | The supplier's own part reference number. |
| `gstApplicable` | No | Whether GST applies. Defaults to `true`. |
| `stockOnHand` | No | Current stock count. Defaults to `0`. |
| `reorderPoint` | No | Stock level that triggers a reorder alert. Defaults to `0`. |

### Response `201`

```json
{
  "part": {
    "id": 5,
    "partNumber": "BP-F-001",
    "name": "Front Brake Pad Set",
    "category": "brakes",
    "supplierId": 1,
    "supplierName": "Repco",
    "supplierPartNumber": "REC-DB1234",
    "costPrice": 48.00,
    "sellPrice": 95.00,
    "gstApplicable": true,
    "stockOnHand": 12,
    "reorderPoint": 4
  }
}
```

### Errors

| Status | Code | When |
|--------|------|------|
| `422` | `VALIDATION_ERROR` | `partNumber`, `name`, `costPrice`, or `sellPrice` missing |
| `403` | `FORBIDDEN` | Technician role |

---

### PATCH /parts/{id}

Send only the fields you want to change.

```
PATCH /parts/5
Authorization: Bearer <accessToken>
Content-Type: application/json

{
  "sellPrice": 105.00,
  "stockOnHand": 8
}
```

### Response `200`

Returns the full updated part object wrapped in `{ "part": { ... } }`.

### Errors

| Status | Code | When |
|--------|------|------|
| `422` | `VALIDATION_ERROR` | No fields sent |
| `404` | `NOT_FOUND` | Part does not exist or is deleted |
| `403` | `FORBIDDEN` | Technician role |

---

### DELETE /parts/{id}

Soft-deletes the part — it will no longer appear in `GET /parts`.

```
DELETE /parts/5
Authorization: Bearer <accessToken>
```

No body. **Response `204`** — no content.

### Errors

| Status | Code | When |
|--------|------|------|
| `404` | `NOT_FOUND` | Part does not exist or is already deleted |
| `403` | `FORBIDDEN` | Technician role |

---

## Object reference

### Supplier object

| Field | Type | Notes |
|-------|------|-------|
| `id` | number | |
| `name` | string | Company name |
| `contactName` | string \| null | |
| `phone` | string \| null | |
| `email` | string \| null | |
| `website` | string \| null | |
| `accountNumber` | string \| null | Your account number with this supplier |
| `notes` | string \| null | Internal notes |
| `createdAt` | string | UTC ISO-8601 |

### Part object

| Field | Type | Notes |
|-------|------|-------|
| `id` | number | |
| `partNumber` | string | Your internal reference |
| `name` | string | |
| `category` | string \| null | Free-text — use consistently for filtering to work |
| `supplierId` | number \| null | FK to suppliers |
| `supplierName` | string \| null | Joined from suppliers — null if no supplier set or supplier deleted |
| `supplierPartNumber` | string \| null | Supplier's own reference number |
| `costPrice` | number | Buy price — never show to customers |
| `sellPrice` | number | Sell price — use as `unitPrice` when adding to a quote |
| `gstApplicable` | boolean | |
| `stockOnHand` | number | Current stock count |
| `reorderPoint` | number | Alert threshold |

---

## Frontend implementation guide

### Settings — Suppliers screen

Standard CRUD list under Settings → Suppliers.

- Table rows: `name`, `contactName`, `phone`, `accountNumber`
- Edit → drawer/modal pre-filled with all fields
- Add → same drawer empty
- Delete → confirmation then `DELETE /suppliers/{id}`, remove from list on `204`

---

### Settings — Parts screen

Standard CRUD list under Settings → Parts.

- Filter bar: supplier dropdown (populated from `GET /suppliers`), category input, search input
- Table rows: `partNumber`, `name`, `supplierName`, `costPrice`, `sellPrice`, `stockOnHand`
- Highlight rows where `stockOnHand <= reorderPoint` (low stock indicator)
- Edit → drawer/modal pre-filled; supplier is a searchable dropdown from `GET /suppliers`
- Add → same drawer empty
- Delete → confirmation then `DELETE /parts/{id}`, remove from list on `204`

**Loading the supplier dropdown in the parts form:**

```
GET /suppliers
→ populate a searchable <select> with { value: id, label: name }
```

---

### Quote builder — adding a part as a line item

When a staff member adds a part to a quote, they search the parts catalogue and the fields pre-fill:

```
GET /parts?search=brake+pad
→ staff selects a result
→ pre-fill line item:
    description  ← part.name
    type         ← "part"
    unitPrice    ← part.sellPrice
    qty          ← 1 (staff adjusts)
```

`costPrice` is never sent to the frontend quote builder — it's for internal reporting only. Only `sellPrice` is used as the line item `unitPrice`.

After pre-filling, staff can override any field before saving the line item to the quote.
