# Suppliers, Part Names & Parts — Frontend Brief

**Base URL:** `https://fzzrkscwd7.execute-api.ap-southeast-2.amazonaws.com`

All routes require `Authorization: Bearer <accessToken>`.

Three tables work together to manage parts:

```
part_names   — master list of part type names (e.g. "Front Brake Pad Set")
suppliers    — companies you buy parts from (e.g. "Repco")
parts        — a specific priced part: name + supplier + part number + cost + sell price
```

**Typical setup order:**
1. Add suppliers (Settings → Suppliers)
2. Add part names (Settings → Part Names)
3. When ordering or quoting a part, create a parts record using a name + supplier + pricing

**Role access:**

| Action | Who |
|--------|-----|
| Read (`GET`) all three | All roles |
| Create / Update / Delete | `store_manager` and `super_admin` only |

---

## Part Names

A reference list of standard part type names. Used as a picker when creating a parts record or quoting — so staff don't have to type free-text descriptions every time.

### GET /part-names

```
GET /part-names
GET /part-names?category=brakes
GET /part-names?search=brake+pad
Authorization: Bearer <accessToken>
```

### Query parameters

| Param | Type | Notes |
|-------|------|-------|
| `category` | string | Exact category match. Omit → all. |
| `search` | string | Partial match on name. |

### Response `200`

```json
{
  "partNames": [
    { "id": 1, "name": "Front Brake Pad Set",  "category": "brakes" },
    { "id": 2, "name": "Rear Brake Pad Set",   "category": "brakes" },
    { "id": 3, "name": "Oil Filter",           "category": "filters" },
    { "id": 4, "name": "Air Filter",           "category": "filters" }
  ]
}
```

Results are ordered by `category` then `name`.

---

### POST /part-names

```
POST /part-names
Authorization: Bearer <accessToken>
Content-Type: application/json

{
  "name": "Front Brake Pad Set",
  "category": "brakes"
}
```

| Field | Required | Notes |
|-------|----------|-------|
| `name` | Yes | The part type name. |
| `category` | No | Free-text category. Use consistently — this drives the category filter. |

### Response `201`

```json
{
  "partName": { "id": 1, "name": "Front Brake Pad Set", "category": "brakes" }
}
```

### Errors

| Status | Code | When |
|--------|------|------|
| `422` | `VALIDATION_ERROR` | `name` is missing |
| `403` | `FORBIDDEN` | Technician role |

---

### PATCH /part-names/{id}

Send only the fields you want to change.

```
PATCH /part-names/1
Authorization: Bearer <accessToken>
Content-Type: application/json

{ "category": "brake-pads" }
```

**Response `200`** — returns `{ "partName": { ... } }`.

### Errors

| Status | Code | When |
|--------|------|------|
| `422` | `VALIDATION_ERROR` | No fields sent |
| `404` | `NOT_FOUND` | Part name does not exist or is deleted |
| `403` | `FORBIDDEN` | Technician role |

---

### DELETE /part-names/{id}

Soft-deletes the part name. Existing parts records that used this name are not affected.

```
DELETE /part-names/1
Authorization: Bearer <accessToken>
```

**Response `204`** — no content.

---

## Suppliers

Companies you buy parts from.

### GET /suppliers

```
GET /suppliers
GET /suppliers?search=Repco
Authorization: Bearer <accessToken>
```

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

| Field | Required | Notes |
|-------|----------|-------|
| `name` | Yes | Supplier company name. |
| `contactName` | No | Primary contact person. |
| `phone` | No | |
| `email` | No | |
| `website` | No | |
| `accountNumber` | No | Your account number with this supplier. |
| `notes` | No | Internal notes e.g. payment terms, delivery cut-off. |

**Response `201`** — returns `{ "supplier": { ... } }`.

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

{ "accountNumber": "ROD-0099", "notes": "Now Net 14 terms." }
```

**Response `200`** — returns `{ "supplier": { ... } }`.

### Errors

| Status | Code | When |
|--------|------|------|
| `422` | `VALIDATION_ERROR` | No fields sent |
| `404` | `NOT_FOUND` | Supplier does not exist or is deleted |
| `403` | `FORBIDDEN` | Technician role |

---

### DELETE /suppliers/{id}

Soft-deletes the supplier. Parts that reference it are not affected — `supplierName` will return `null` on those parts.

```
DELETE /suppliers/1
Authorization: Bearer <accessToken>
```

**Response `204`** — no content.

---

## Parts

A parts record ties a part name, a supplier, a part number, and pricing together. This is the record you create when you stock or order a specific part.

### GET /parts

Returns all active parts. Supplier name is included — no second fetch needed.

```
GET /parts
GET /parts?supplierId=1
GET /parts?category=brakes
GET /parts?search=brake+pad
Authorization: Bearer <accessToken>
```

| Param | Type | Notes |
|-------|------|-------|
| `supplierId` | number | Filter to parts from a specific supplier. |
| `category` | string | Exact category match. |
| `search` | string | Partial match on part name, your part number, or supplier part number. |

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

| Field | Required | Notes |
|-------|----------|-------|
| `partNumber` | Yes | Your internal reference e.g. `"BP-F-001"`. |
| `name` | Yes | Part name — pick from `GET /part-names` or enter custom. |
| `costPrice` | Yes | What you pay the supplier. Never shown to customers. |
| `sellPrice` | Yes | What you charge the customer. Used as `unitPrice` on quotes. |
| `category` | No | Should match the category used in `part_names` for consistent filtering. |
| `supplierId` | No | FK to suppliers. |
| `supplierPartNumber` | No | The supplier's own part reference. |
| `gstApplicable` | No | Defaults to `true`. |
| `stockOnHand` | No | Current stock count. Defaults to `0`. |
| `reorderPoint` | No | Low-stock threshold. Defaults to `0`. |

**Response `201`** — returns `{ "part": { ... } }`.

### Errors

| Status | Code | When |
|--------|------|------|
| `422` | `VALIDATION_ERROR` | `partNumber`, `name`, `costPrice`, or `sellPrice` missing |
| `403` | `FORBIDDEN` | Technician role |

---

### PATCH /parts/{id}

Send only the fields you want to change. Useful for updating stock on hand or adjusting pricing.

```
PATCH /parts/5
Authorization: Bearer <accessToken>
Content-Type: application/json

{ "sellPrice": 105.00, "stockOnHand": 8 }
```

**Response `200`** — returns `{ "part": { ... } }`.

### Errors

| Status | Code | When |
|--------|------|------|
| `422` | `VALIDATION_ERROR` | No fields sent |
| `404` | `NOT_FOUND` | Part does not exist or is deleted |
| `403` | `FORBIDDEN` | Technician role |

---

### DELETE /parts/{id}

Soft-deletes the part — no longer appears in `GET /parts`.

```
DELETE /parts/5
Authorization: Bearer <accessToken>
```

**Response `204`** — no content.

---

## Object reference

### Part name object

| Field | Type | Notes |
|-------|------|-------|
| `id` | number | |
| `name` | string | |
| `category` | string \| null | |

### Supplier object

| Field | Type | Notes |
|-------|------|-------|
| `id` | number | |
| `name` | string | |
| `contactName` | string \| null | |
| `phone` | string \| null | |
| `email` | string \| null | |
| `website` | string \| null | |
| `accountNumber` | string \| null | |
| `notes` | string \| null | |
| `createdAt` | string | UTC ISO-8601 |

### Part object

| Field | Type | Notes |
|-------|------|-------|
| `id` | number | |
| `partNumber` | string | Your internal reference |
| `name` | string | |
| `category` | string \| null | |
| `supplierId` | number \| null | |
| `supplierName` | string \| null | Joined from suppliers — null if no supplier or supplier deleted |
| `supplierPartNumber` | string \| null | Supplier's own reference |
| `costPrice` | number | Buy price — never show to customers |
| `sellPrice` | number | Sell price — use as `unitPrice` on quotes |
| `gstApplicable` | boolean | |
| `stockOnHand` | number | |
| `reorderPoint` | number | Highlight row when `stockOnHand <= reorderPoint` |

---

## Frontend implementation guide

### Settings — Part Names screen

Simple list management under Settings → Part Names.

- Group by `category` with category headings
- Each row: `name`, `category`, edit + delete actions
- Add → modal with `name` and `category` inputs
- Edit → same modal pre-filled
- Delete → confirmation then `DELETE /part-names/{id}`

**On load:**
```
GET /part-names
→ group by category, render list
```

No page reload needed — update state directly from API responses.

---

### Settings — Suppliers screen

List management under Settings → Suppliers.

- Each row: `name`, `contactName`, `phone`, `accountNumber`
- Add/edit → drawer with all fields
- Delete → confirmation then `DELETE /suppliers/{id}`

---

### Settings — Parts screen

List management under Settings → Parts.

- Filter bar: supplier dropdown (`GET /suppliers`), category input, search input
- Each row: `partNumber`, `name`, `supplierName`, `costPrice`, `sellPrice`, `stockOnHand`
- Highlight any row where `stockOnHand <= reorderPoint` as a low-stock warning
- Add/edit → drawer with all fields; supplier is a searchable dropdown from `GET /suppliers`

**Supplier dropdown in the parts form:**
```
GET /suppliers
→ [{ value: id, label: name }, ...]
```

---

### Quote builder — adding a part as a line item

When a staff member adds a part line item to a quote:

**Step 1 — Pick the part name:**
```
GET /part-names?search=brake
→ staff selects "Front Brake Pad Set"
```

**Step 2 — Find a priced record for this part:**
```
GET /parts?search=Front+Brake+Pad+Set
→ shows existing priced records with supplier + pricing
→ staff selects one to pre-fill
```

**Step 3 — Pre-fill the line item:**
```
description  ← part.name
type         ← "part"
unitPrice    ← part.sellPrice   (never use costPrice here)
qty          ← 1 (staff adjusts)
```

**If no parts record exists yet**, staff can enter pricing manually or create one via Settings → Parts before returning to the quote.

`costPrice` is for internal reporting only — never display it on the quote builder or approval page.
