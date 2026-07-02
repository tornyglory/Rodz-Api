# Hoist Enable / Disable — Frontend Brief

Staff with `store_manager` or `super_admin` role can take a hoist offline instantly. The website booking calendar loses that hoist's capacity on the next page load.

---

## Reading hoist status

Hoist status is returned as part of the store list. Call this on settings page load.

### `GET /stores`

**Auth:** `Authorization: Bearer <staff_jwt>`

Every hoist in every store now includes `isActive`:

```json
{
  "stores": [
    {
      "id": 1,
      "name": "Somerville",
      "hoists": [
        {
          "id": 1,
          "label": "Hoist 1",
          "store": "Somerville",
          "isTyreBay": false,
          "sortOrder": 1,
          "roles": ["Log Book Service"],
          "assignedTech": "John S.",
          "assignedStaffId": 3,
          "status": "available",
          "isActive": true
        },
        {
          "id": 2,
          "label": "Hoist 2",
          "store": "Somerville",
          "isTyreBay": false,
          "sortOrder": 2,
          "roles": ["Oil & Filter"],
          "assignedTech": "Mechanicc G.",
          "assignedStaffId": 8,
          "status": "available",
          "isActive": false
        }
      ]
    }
  ]
}
```

**Key change:** all hoists are returned regardless of active state. Previously inactive hoists were hidden, making them impossible to re-enable. Now use `isActive` to decide how to render each hoist card.

---

## Toggling a hoist

### `PATCH /stores/:storeId/hoists/:hoistId`

**Auth:** `Authorization: Bearer <staff_jwt>` — `store_manager` or `super_admin` only. Technicians get 403.

**Disable:**
```json
{ "isActive": false }
```

**Enable:**
```json
{ "isActive": true }
```

**Response — 200**
```json
{
  "hoist": {
    "id": 2,
    "label": "Hoist 2",
    "store": "Somerville",
    "isTyreBay": false,
    "sortOrder": 2,
    "roles": ["Oil & Filter"],
    "assignedTech": "Mechanicc G.",
    "assignedStaffId": 8,
    "status": "available",
    "isActive": false
  }
}
```

Update the local hoist state with the returned object — no need to re-fetch the full store list.

---

## UI

Each hoist card in Settings → Store should show a toggle:

```
Hoist 1   ●━━○  [Online]    ← isActive: true
Hoist 2   ○━━●  [Offline]   ← isActive: false  (card greyed out)
Tyre Bay  ●━━○  [Online]    ← isActive: true
```

**Behaviour:**
- Toggle fires immediately on click (optimistic UI is fine — the API is fast)
- On success: update the hoist card from the response body
- Greyed-out card and "Offline" label when `isActive: false`
- Show a toast: `"Hoist 2 taken offline"` / `"Hoist 2 back online"`
- Technicians do not see the toggle at all

**What happens on the website:** capacity drops (or recovers) on the customer's next `GET /public/blocks` call. No delay.

---

## Error responses

| HTTP | Meaning |
|------|---------|
| 403 | Caller is a technician, or a store_manager trying to modify another store's hoist |
| 404 | `HOIST_NOT_FOUND` — hoist ID doesn't belong to that store |
| 422 | `VALIDATION_ERROR` — no valid fields provided |
