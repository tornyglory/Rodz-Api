# WebSocket — Guest Bookings Real-time Brief

Companion to `docs/ws-jobs-hoists-brief.md`. When a guest completes the
`/book` flow on `workshop.rodz.com.au`, the backend now pushes the
newly-created booking to every connected workshop tab so the
Bookings page's **Pending** column updates without a manual refresh.

Backend is deployed and pushing. Verified end-to-end (`[ws] pushed ok`
in the public booking Lambda's CloudWatch logs).

No new connection is needed — wire this into the existing WS message
handler alongside the notification / job_updated cases.

---

## One new message type

```ts
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data)
  switch (msg.type) {
    case 'notification':    // existing
    case 'job_updated':     // existing
    case 'hoist_updated':   // existing
    case 'jobs_reordered':  // existing
    case 'booking_created': handleBookingCreated(msg.booking); break
  }
}
```

Every guest booking submit triggers **two** messages back-to-back:

1. `{ type: 'notification', notification: {...} }` — the existing bell/toast payload. No change to how this is handled.
2. `{ type: 'booking_created', booking: {...} }` — new. This is what the Bookings page uses to update the list.

---

## `booking_created`

**When it arrives:** a new guest booking has just been submitted via
`POST /public/bookings` and inserted into the DB as `status: 'pending'`
with `hoist_id` + `assigned_staff_id` already locked in from the
customer's picked tech.

**Shape** — full Booking object, byte-identical to what
`GET /bookings?status=pending` returns for each item:

```jsonc
{
  "type": "booking_created",
  "booking": {
    "id":             123,
    "bookingRef":     "ABCD2345",
    "customerId":     456,
    "customer":       "Nev Rodda",
    "customerEmail":  "nev@example.com",
    "vehicleId":      789,
    "vehicle":        "2020 Toyota Corolla",
    "rego":           "ABC123",
    "status":         "pending",
    "date":           "2026-08-05",
    "time":           "08:30",
    "slot":           "morning",
    "hoistId":        1,
    "hoistName":      "Hoist 1",
    "assignedStaffId": 3,
    "techLabel":      "H. Rodda",
    "storeId":        1,
    "storeName":      "Somerville",
    "dropOffType":    "drop_off",
    "customerNotes":  null,
    "services":       [ { "serviceTypeId": 12, "serviceName": "Brake Inspection", ... } ],
    "createdAt":      "2026-08-03T20:45:22.000Z"
    // …every field the list endpoint returns, no exceptions
  }
}
```

**Frontend action:** unshift the `booking` object into the pending
column's list. That's it — the shape already matches what your
`Booking` type / model expects because the backend uses the exact
same `BOOKING_SELECT_BY_ID` + `buildBooking` pipeline for both the
list endpoint and this push.

```ts
function handleBookingCreated(booking: Booking) {
  // The pending column already knows how to render a Booking —
  // just drop this one at the top.
  pendingBookings.value.unshift(booking)
}
```

---

## What this replaces

Before: workshop staff waited for either the notification toast (and
manually navigated to Bookings) or an auto-poll refresh to see a new
guest booking. During that gap another customer could theoretically
attempt to grab the same hoist — DB-level locking prevents the
double-book, but staff situational awareness was lagging.

After: the Pending card appears the moment the DB row is created.
Hoist + tech are pre-populated on the card; no "Assign hoist" step
because the customer already picked one. Confirm Booking button
proceeds via the existing `PATCH /bookings/:id { status: 'confirmed' }`.

---

## Existing behaviour that hasn't changed

- The `notification` push still fires and still populates the bell +
  the `staff_notifications` DB row. Keep handling that exactly as
  today.
- The DB row is created with `status: 'pending'` and slot-locking
  happens on INSERT regardless of whether the WS delivered — the
  availability query excludes pending bookings' hoists.
- On confirm, `PATCH /bookings/:id` still fires the existing
  `job_updated` / `hoist_updated` messages (from
  `docs/ws-jobs-hoists-brief.md`) so the Jobs board picks up the new
  service_jobs row without needing anything from this brief.

---

## Edge cases + gotchas

- **Idempotent replay** (customer refreshes the booking form and
  re-POSTs with the same `meta.sessionId`) — the backend returns the
  existing booking with `idempotent: true` and does NOT push a
  second `booking_created`. Frontend won't see duplicates.
- **Deduplication key** — use `booking.id`. If a client somehow
  receives two `booking_created` messages for the same id (network
  reconnect / message replay), unshift-if-not-present.
- **Ordering** — messages are per-store and delivered in send order.
  If a WS reconnect is racing an in-flight POST, worst case the
  Pending column briefly duplicates until the next full refresh —
  the `id`-based de-dup covers this.
- **No WS available** (customer app closed, or the connection
  dropped): the booking is still safely in the DB and shows up on
  the next `GET /bookings` refresh. WS is a delivery optimization,
  not the source of truth.

---

## Testing checklist

- [ ] Open the workshop app on the Bookings page. Verify the WS
      connection is live (check DevTools → Network → WS frames).
- [ ] From another tab (or a different device), submit a guest
      booking via `workshop.rodz.com.au/book`.
- [ ] The Pending column on the first tab should populate the new
      card **within ~1 second**, without any user interaction.
- [ ] The card should show the assigned hoist + tech (already picked
      by the customer), NOT an "Assign hoist" empty state.
- [ ] Clicking "Confirm Booking" on the new card should transition
      to Confirmed and trigger the existing `job_updated` push.
- [ ] Reload the Bookings page — the pending card should still be
      there (WS was just a delivery mechanism; the source of truth
      is `GET /bookings`).
