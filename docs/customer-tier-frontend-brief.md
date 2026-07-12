# Customer Tier (Free / Silver / Gold) — Frontend Brief

Replaces the boolean "premium / not premium" with a three-value `tier` so Silver and Gold can be granted independently. `isPremium` is still returned (derived as `tier !== 'free'`) so nothing on the customer portal breaks — but the staff drawer's Grant/Revoke Premium control should become a three-way selector that calls the new `/tier` endpoint.

Backend is live.

---

## Base URL

```
https://fzzrkscwd7.execute-api.ap-southeast-2.amazonaws.com
```

Staff endpoints require a staff JWT. Customer endpoints require a customer JWT.

---

## What's on the customer object

Every customer response now includes:

```json
{
  "id": 123,
  "firstName": "Jane",
  ...
  "tier":      "silver",
  "isPremium": true
}
```

| Field | Type | Notes |
|-------|------|-------|
| `tier` | `"free" \| "silver" \| "gold"` | Membership tier. Source of truth. |
| `isPremium` | boolean | Derived server-side: `tier !== "free"`. Kept for backwards compatibility. |

Returned by:

- **Staff:** `GET /customers`, `GET /customers/:id`, `POST /customers`, `PATCH /customers/:id`
- **Customer portal:** `GET /c/me`, `POST /c/auth/login`, `POST /c/auth/signup`, `POST /c/auth/magic-link/{token}`

---

## Feature gating

| Feature bucket | Gate |
|----------------|------|
| Silver features — AI assistant, full logbook, maintenance | `customer.isPremium === true` (i.e. `tier !== 'free'`) |
| Gold features — Expenses, Fuel, Network insights | `customer.tier === 'gold'` |

Prefer gating on `tier` when you can — `isPremium` will remain but any code that needs to distinguish Silver from Gold must read `tier`.

---

## Set tier (staff)

```
PATCH /customers/:id/tier
Authorization: Bearer <staffToken>
Content-Type: application/json

{ "tier": "gold" }
```

**Body** — `tier: "free" | "silver" | "gold"`. Anything else → `422 VALIDATION_ERROR`.

**Response — 200:**

```json
{
  "id":        123,
  "tier":      "gold",
  "isPremium": true
}
```

Reads back cleanly on the next `GET /customers` / `GET /customers/:id`.

### Errors

| Status | Code | When |
|--------|------|------|
| `403` | `FORBIDDEN` | `technician` role calling — read-only for them |
| `404` | `NOT_FOUND` | Customer id doesn't exist |
| `422` | `VALIDATION_ERROR` | `tier` missing or not in the enum |

---

## Compatibility — old `/premium` endpoint

`PATCH /customers/:id/premium` still works. It now writes to both columns:

- `isPremium: true` → `tier = 'silver'` (or preserves `'gold'` if the customer was already Gold)
- `isPremium: false` → `tier = 'free'`

Keep it as a fallback while the segmented selector rolls out — no rush to remove callers.

---

## Staff drawer control

Replace the two-button Grant Premium / Revoke Premium with a three-way segmented selector:

```
[ Free ]  [ Silver ]  [ Gold ]
```

On change, call `PATCH /customers/:id/tier` with `{ tier: <selected> }`. Update the local customer object with the response so the tier badge / feature gates refresh without a round-trip refetch.

---

## Smoke test

- [ ] `GET /customers` — every item has `tier` (`"free" | "silver" | "gold"`) and matching `isPremium`
- [ ] `GET /c/me` — same on the customer portal
- [ ] `PATCH /customers/:id/tier` with `{ "tier": "gold" }` — returns `{ tier: "gold", isPremium: true }`, drawer updates
- [ ] `PATCH /customers/:id/tier` with `{ "tier": "free" }` on a Gold customer — downgrades, `isPremium` → `false`, Gold features disappear
- [ ] `PATCH /customers/:id/tier` with `{ "tier": "platinum" }` — `422`
- [ ] `PATCH /customers/:id/tier` as `technician` — `403`
- [ ] Old `PATCH /customers/:id/premium` with `{ "isPremium": true }` — sets `tier: "silver"` (or leaves at `"gold"`)
