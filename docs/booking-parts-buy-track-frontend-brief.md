# Booking Parts — Buy + Track — Frontend Brief

Once the sourcing panel shows prices, the workshop needs to actually
**buy** the parts (currently a manual click-through to the seller's
site) and **track** them through to arrival. This layer sits directly
below the sourcing panel on the booking detail view, showing every
part the workshop has committed to purchasing plus its status.

Backend deployed 2026-08-07. All routes on the admin API
(`https://lukck5txvh.execute-api.ap-southeast-2.amazonaws.com`).

---

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET`    | `/bookings/{id}/parts-orders`   | List orders placed for this booking |
| `POST`   | `/bookings/{id}/parts-orders`   | Record a new placed order |
| `PATCH`  | `/parts-orders/{orderId}`       | Update status / tracking / arrived date / notes |
| `DELETE` | `/parts-orders/{orderId}`       | Cancel + remove |

Store-scoped: `super_admin` any booking; `store_manager` / `technician` only bookings at their store. `technician` cannot create orders (POST) but can update status (PATCH — marking parts as arrived).

All requests: `Authorization: Bearer <staff_jwt>`.

---

## Data model summary

```jsonc
{
  "id":                17,
  "bookingId":         108,
  "serviceJobId":      null,                    // populated once the job exists
  "offeringId":        3,                       // source snapshot (may become null if snapshot rotates)
  "partNameId":        386,
  "partName":          "Brake Fluid",
  "partCategory":      "Fluid",
  "supplier":          "ebay",                  // ebay | burson | repco | other
  "marketplace":       "EBAY_AU",
  "externalOrderId":   "13-14528-73920",        // eBay order # OR Burson invoice ref
  "externalOrderUrl":  "https://www.ebay.com.au/itm/...",
  "itemTitle":         "Toyota Genuine Brake Fluid DOT4 1L",
  "quantity":          1,
  "priceNative":       24.67,
  "currency":          "AUD",
  "shippingNative":    0.00,
  "totalAud":          24.67,
  "status":            "placed",                // placed | confirmed | shipped | arrived | cancelled | returned | not_arrived
  "expectedDelivery":  "2026-08-13",
  "arrivedAt":         null,
  "trackingNumber":    null,
  "trackingCarrier":   null,
  "placedByStaffId":   1,
  "placedBy":          "Nev Rodda",
  "placedAt":          "2026-08-07T00:36:22.000Z",
  "notes":             null
}
```

Statuses flow one-way in normal use: `placed → shipped → arrived`. `confirmed` is optional between `placed` and `shipped` (used when the supplier confirms receipt but hasn't dispatched yet). `cancelled` / `returned` / `not_arrived` are terminal.

---

## POST — creating an order (two shapes)

### Shape A — from the sourcing snapshot (recommended for eBay)

The workshop clicks "**Order this**" on an offering row in the sourcing panel. Frontend:

1. Opens `offering.productUrl` in a new tab (eBay listing).
2. Shows a modal: *"Once you've completed the purchase, paste the eBay order number below."*
3. When the manager pastes + saves, POST:

```jsonc
POST /bookings/108/parts-orders
{
  "offeringId":      3,                        // the row they clicked in sourcing
  "externalOrderId": "13-14528-73920",         // eBay order number
  "notes":           "Bought during Wed morning check-in"   // optional
}
```

Backend auto-populates everything else from the offering snapshot: title, price, currency, shipping, total AUD, `expectedDelivery` (from the offering's `deliveryMaxDays`), supplier, marketplace. Frontend just needs to pass the eBay order number.

Response: the fully-hydrated order (same shape as above).

### Shape B — free-form (walk-in / phone order / alternate supplier)

For walk-ins to Repco / Burson / etc. — anything not in an eBay snapshot:

```jsonc
POST /bookings/108/parts-orders
{
  "partNameId":       354,
  "supplier":         "burson",             // ebay | burson | repco | other
  "itemTitle":        "Ryco Oil Filter Z432",
  "priceNative":      12.50,
  "currency":         "AUD",
  "shippingNative":   0.00,
  "totalAud":         12.50,                // defaults to priceNative if omitted
  "externalOrderId":  "BURS-INV-8823",
  "externalOrderUrl": null,
  "quantity":         1,
  "expectedDelivery": "2026-08-10",         // YYYY-MM-DD; optional
  "notes":            "Picked up in-store"
}
```

Required for Shape B: `partNameId`, `supplier`, `itemTitle`, `priceNative`, `currency`. Everything else defaults.

### Errors

| Status | Code | When |
|---|---|---|
| `403` | `FORBIDDEN` | Technician tried to POST |
| `404` | `NOT_FOUND` | Booking not in your store |
| `422` | `VALIDATION_ERROR` | Missing required fields OR offeringId doesn't exist |

---

## GET — listing orders on a booking

```
GET /bookings/108/parts-orders
```

Returns:

```jsonc
{
  "orders": [
    { /* order object as above */ },
    { /* order object as above */ }
  ]
}
```

Sorted newest-first (`placed_at DESC`). Multiple orders per part are fine — e.g. workshop bought oil filter from Repco AND ordered a backup from eBay.

---

## PATCH — updating status

```
PATCH /parts-orders/17
```

Body — all fields optional, at least one required:

```jsonc
{
  "status":            "shipped",                 // one of the enum values
  "trackingNumber":    "AUP123456789",
  "trackingCarrier":   "AusPost",
  "expectedDelivery":  "2026-08-11",              // update ETA if it changed
  "externalOrderId":   "13-14528-73920",          // set after eBay confirms
  "externalOrderUrl":  "https://...",
  "notes":             "Delayed at customs",
  "arrivedAt":         "2026-08-12"               // YYYY-MM-DD
}
```

**Convenience:** setting `status: "arrived"` automatically stamps `arrivedAt = today` unless you provide an explicit `arrivedAt`. Setting `status` back to `placed` / `in_progress` clears `arrivedAt`.

Response: the freshly-updated order.

---

## DELETE — cancel + remove

```
DELETE /parts-orders/17
```

Response: `{ "deleted": true }`. Records are hard-deleted. For "we ordered it but the seller cancelled", prefer `PATCH status: "cancelled"` — keeps the audit trail. Only DELETE for clearly-erroneous entries.

---

## Suggested UI — "Orders" panel

Sits directly below the "Parts Sourcing" panel on the booking detail view. Only visible once the booking has at least one order OR the manager clicks "Order this" from sourcing.

```
┌────────────────────────────────────────────────────────────────────┐
│ 📦 Orders Placed                       2 of 4 parts ordered       │
├────────────────────────────────────────────────────────────────────┤
│ ✓ Brake Fluid — Toyota Genuine DOT4 1L                            │
│   A$24.67 · placed 5 min ago · Nev Rodda                           │
│   eBay #13-14528-73920 · expected Wed 13 Aug                       │
│   Status: [ Placed ▼ ]  Tracking: [ + add ]         [ View eBay ]  │
│                                                                    │
│ ✓ Oil Filter — Ryco Z432                                          │
│   A$12.50 · placed yesterday · Nev Rodda · [ ⓘ from Burson ]       │
│   Invoice #BURS-INV-8823 · expected Mon 10 Aug                    │
│   Status: [ Shipped ▼ ]  Tracking: AUP123456789 (AusPost)         │
│                                                                    │
│ ✗ Engine Oil — Castrol Magnatec 5W-30 5L                          │
│   Not ordered — click "Order this" on sourcing panel above         │
│                                                                    │
│ ✗ Cabin Air Filter — Not ordered                                  │
│                                                                    │
│ Total spent: A$37.17         Total budget (from sourcing): A$102.35│
└────────────────────────────────────────────────────────────────────┘
```

### Fields per row

- **Part name + item title** — headline.
- **Total AUD + placed-at + placed-by** — audit line.
- **Supplier flag** — eBay logo / Burson-brand / Repco-brand icon based on `supplier`. External order number displayed.
- **Expected delivery** — `expectedDelivery` field, formatted `"expected Wed 13 Aug"`. If past today and status ≠ `arrived`/`cancelled`, colour it red and add a "chase supplier?" hint.
- **Status dropdown** — reflects current `status`; changing it fires `PATCH /parts-orders/{id}` with the new value.
- **Tracking field** — if `trackingNumber` set, show `123456789 (Carrier)`. Otherwise "+ add" opens an inline form → PATCH.
- **"View eBay"** button (or Repco, etc.) — opens `externalOrderUrl` in a new tab.

### Buy flow — the "Order this" button on sourcing

1. On the sourcing panel, every offering row has an **"Order this"** button.
2. Click → opens `offering.productUrl` in new tab AND opens an in-app modal:
   ```
   ┌─ Log this order ─────────────────────────────┐
   │ Complete your purchase on eBay, then paste  │
   │ the order number below.                      │
   │                                              │
   │ eBay listing: [thumbnail + title]           │
   │ Price: A$24.67 delivered                     │
   │                                              │
   │ eBay order number: [_____________________]  │
   │ Notes (optional):  [_____________________]  │
   │                                              │
   │              [ Cancel ]  [ Save order → ]   │
   └──────────────────────────────────────────────┘
   ```
3. Save → `POST /bookings/{id}/parts-orders` with `{ offeringId, externalOrderId, notes }`.
4. On success: close modal, refresh the Orders panel below the sourcing panel.

### Free-form entry (walk-in orders)

Little **"Add manual order"** button in the Orders panel header. Opens a fuller form (all Shape B fields) for orders that didn't come through eBay sourcing.

### Overdue flagging

Compare `expectedDelivery` against today's date:

- **> 0 days in future** — normal display
- **Today or 1-2 days late + status not `arrived`** — amber highlight, "arriving today/soon"
- **>2 days late + status not `arrived`** — red highlight, "overdue"

For status = `arrived`, always green regardless of dates.

---

## Progress rollup

The Orders panel header should show `2 of 4 parts ordered` where:

- **Denominator** = number of unique `partNameId`s across all queries in the sourcing snapshot for this booking (i.e. shopping list count)
- **Numerator** = number of unique `partNameId`s with at least one non-cancelled order

Frontend computes both from the two endpoint responses. When numerator = denominator, show a ✓ badge on the panel: "Ready to service".

---

## When to show the panel

- **Sourcing not run** → hide Orders panel entirely (show only sourcing).
- **Sourcing run, no orders placed** → show Orders panel with all parts as `✗ Not ordered`. Big "the manager needs to order these" cue.
- **Some orders placed** → show placed orders + remaining unordered parts.
- **All ordered** → show all rows in green, progress badge "Ready to service".

---

## Not addressed here

- **Auto-tracking via eBay Order API** — needs eBay user-consented OAuth (separate from the application-level Browse API we use today) + Managed Access approval. When it lands, we'd auto-flip `placed → confirmed → shipped → arrived` based on eBay order status polling. For now, staff updates manually via the dropdown.
- **Bulk "order all recommended" button** — one-click place N orders from the top offering of each shopping-list part. Blocked on the eBay Buy API integration above (or an interim "open N tabs" flow which browsers block anyway).
- **Late-order Slack/email alerts** — nightly Lambda checks `expected_delivery < CURDATE()` and `status IN ('placed','shipped')`, flags to staff. Easy to add later; no schema changes needed.
- **Parts arrival → job card sync** — when all parts on a booking are `arrived`, mark the job card as "parts ready", clear any "awaiting parts" badge. Requires linking `part_orders → service_job`. `service_job_id` column is already there on `part_orders`, just unpopulated.
- **Margin reporting** — how much the workshop paid vs. what they charged the customer. Needs a link between `part_orders` and the eventual `service_job_items` (invoice line). Deferred.
