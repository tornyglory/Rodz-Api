# Bank Details — Frontend Brief

**Base URL:** `https://fzzrkscwd7.execute-api.ap-southeast-2.amazonaws.com`

All requests require `Authorization: Bearer <accessToken>`.

---

## Overview

Global bank transfer details shown on invoices. One set of values for the whole business — not per-store. Displayed on the Settings page under a Banking tab. Only the `super_admin` role can edit them.

---

## Endpoints

### GET /settings/bank-details

Fetch the current bank transfer details.

```
GET /settings/bank-details
Authorization: Bearer <accessToken>
```

**Response `200`**

```json
{
  "bankDetails": {
    "accountName": "Rodz Smart Auto",
    "bsb": "063-000",
    "accountNumber": "1234 5678",
    "reference": "Invoice #"
  }
}
```

- Never returns `404` — if not yet configured, all fields come back as empty strings `""`
- Available to all authenticated roles (`super_admin`, `store_manager`, `technician`)

---

### PATCH /settings/bank-details

Save updated bank transfer details. `super_admin` only.

```
PATCH /settings/bank-details
Authorization: Bearer <accessToken>
Content-Type: application/json

{
  "accountName": "Rodz Smart Auto",
  "bsb": "063-000",
  "accountNumber": "1234 5678",
  "reference": "Invoice #"
}
```

All four fields are required.

| Field | Rules |
|-------|-------|
| `accountName` | 1–100 characters |
| `bsb` | Must match `NNN-NNN` format (e.g. `063-000`) |
| `accountNumber` | Digits and spaces only, 1–20 characters |
| `reference` | 1–50 characters |

**Response `200`** — returns the saved values

```json
{
  "bankDetails": {
    "accountName": "Rodz Smart Auto",
    "bsb": "063-000",
    "accountNumber": "1234 5678",
    "reference": "Invoice #"
  }
}
```

**Error responses**

| Status | When |
|--------|------|
| `403` | Role is not `super_admin` |
| `422` | Validation failure — `error` field describes the problem |

**422 example**
```json
{ "error": "Invalid BSB format — expected NNN-NNN (e.g. 063-000)." }
```

---

## Suggested UI

### Settings → Banking tab

```
┌─────────────────────────────────────────────────┐
│  Bank Transfer Details                          │
│  Shown on invoices as a payment option.         │
│                                                 │
│  Account Name                                   │
│  ┌─────────────────────────────────────────┐   │
│  │ Rodz Smart Auto                         │   │
│  └─────────────────────────────────────────┘   │
│                                                 │
│  BSB                   Account Number           │
│  ┌──────────────┐      ┌──────────────────┐    │
│  │ 063-000      │      │ 1234 5678        │    │
│  └──────────────┘      └──────────────────┘    │
│                                                 │
│  Payment Reference                              │
│  ┌─────────────────────────────────────────┐   │
│  │ Invoice #                               │   │
│  └─────────────────────────────────────────┘   │
│  Customers are asked to include their invoice   │
│  number after this prefix, e.g. "Invoice #1042" │
│                                                 │
│                              [Save Changes]     │
└─────────────────────────────────────────────────┘
```

### Behaviour

- Load the form on page open with `GET /settings/bank-details` — pre-fill all four fields
- If all fields are empty strings the form is blank (not yet configured)
- The Save button calls `PATCH /settings/bank-details` with all four fields
- On `200` — show a success toast, update the form with the returned values
- On `422` — show the `error` string inline below the relevant field
- On `403` — this shouldn't happen if the UI hides the Banking tab for non-super_admin users, but handle it gracefully

### Role visibility

- **`super_admin`** — can see and edit the Banking tab
- **`store_manager` / `technician`** — hide the Banking tab entirely (they get a `403` on PATCH anyway)

---

## How it appears on invoices

When bank details are configured, invoices include a "Pay by bank transfer" section:

```
Pay by bank transfer
  Account name:    Rodz Smart Auto
  BSB:             063-000
  Account number:  1234 5678
  Reference:       Invoice #1042
```

The invoice number is appended automatically to the `reference` value at generation time. If all bank detail fields are empty, this section is omitted from the invoice.
