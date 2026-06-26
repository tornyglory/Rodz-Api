# Staff Notifications — Frontend Brief

Real-time inbox for staff. Notifications are created automatically by the backend when key events occur. Staff only see notifications for stores they have access to.

---

## Events that generate notifications

| Event | `type` value | When it fires |
|---|---|---|
| Customer makes a booking | `booking_received` | `POST /bookings` |
| Customer approves a quote | `quote_approved` | `POST /q/{token}/approve` (customer email link) or `POST /quotes/{id}/approve` (staff manual) |
| A job is marked completed | `job_completed` | `PATCH /jobs/:id` with `status: "completed"` |
| An invoice is marked paid | `invoice_paid` | `POST /invoices/:id/mark-paid` |

---

## Endpoints

All endpoints require a valid staff JWT (`Authorization: Bearer <token>`).

### `GET /notifications`

Returns the 50 most recent notifications for the logged-in staff member, newest first.

**Query parameters**

| Param | Type | Description |
|---|---|---|
| `unread` | `"true"` | Optional. Return only unread notifications. |

**Response `200`**

```json
{
  "notifications": [
    {
      "id": 12,
      "type": "booking_received",
      "title": "New Booking",
      "body": "Sarah Johnson booked for 2026-06-24 (Morning)",
      "storeId": 2,
      "bookingId": 88,
      "quoteId": null,
      "jobId": null,
      "invoiceId": null,
      "readAt": null,
      "createdAt": "2026-06-24T03:51:16.000Z"
    },
    {
      "id": 11,
      "type": "invoice_paid",
      "title": "Invoice Paid",
      "body": "Invoice INV-2606-003 paid — $520.00",
      "storeId": 2,
      "bookingId": null,
      "quoteId": null,
      "jobId": null,
      "invoiceId": 17,
      "readAt": "2026-06-24T02:10:00.000Z",
      "createdAt": "2026-06-24T02:09:45.000Z"
    }
  ],
  "unreadCount": 3
}
```

**Fields**

| Field | Type | Notes |
|---|---|---|
| `id` | number | Notification ID |
| `type` | string | One of `booking_received`, `quote_approved`, `job_completed`, `invoice_paid` |
| `title` | string | Short heading — safe to display as-is |
| `body` | string | One-line description of the event |
| `storeId` | number \| null | The store this event belongs to |
| `bookingId` | number \| null | Set for `booking_received` |
| `quoteId` | number \| null | Set for `quote_approved` |
| `jobId` | number \| null | Set for `job_completed` |
| `invoiceId` | number \| null | Set for `invoice_paid` |
| `readAt` | ISO string \| null | `null` = unread |
| `createdAt` | ISO string | When the notification was created |

---

### `PATCH /notifications/{id}/read`

Marks a single notification as read. No request body required.

**Path params:** `id` — notification ID

**Response `200`** — returns the updated notification object (same shape as above).

**Response `404`** — notification not found, or already read, or doesn't belong to this staff member.

---

### `PATCH /notifications/read-all`

Marks all unread notifications as read for the logged-in staff member. No request body required.

**Response `200`**

```json
{ "updated": 5 }
```

`updated` is the number of notifications that were marked read (0 if none were unread).

---

## Implementation guide

### Unread badge

Use `unreadCount` from `GET /notifications` to drive the badge on the bell icon in the nav. The count is kept in sync in real time via WebSocket — do not poll on a timer.

Fetch `GET /notifications` once on app load to get the initial count. After that, increment by 1 each time a WS push arrives, and reset to 0 when the drawer is opened (after `PATCH /notifications/read-all`).

```
GET /notifications → unreadCount: 3  →  show badge "3"
unreadCount: 0                        →  hide badge
```

> For WebSocket setup, reconnect logic, and toast display, see `websocket-notifications.md`.

### Notification panel / drawer

On bell click, open a drawer and fetch `GET /notifications` (no filter — show all). Render each item with:
- Icon based on `type` (calendar for booking, tick for job/invoice, quote icon for approval)
- `title` in bold, `body` below it
- Relative timestamp (`createdAt`) — e.g. "2 minutes ago"
- Unread items should be visually distinct (e.g. left border accent, slightly darker background)
- An `readAt` of `null` means unread

### On open: mark all read

When the notification drawer opens, fire `PATCH /notifications/read-all` in the background. This clears the badge. No need to wait for the response before rendering the list.

### Deep links

Use the entity ID fields to navigate when a notification is tapped:

| `type` | Navigate to |
|---|---|
| `booking_received` | `/bookings/{bookingId}` |
| `quote_approved` | `/quotes/{quoteId}` |
| `job_completed` | `/jobs/{jobId}` |
| `invoice_paid` | `/invoices/{invoiceId}` |

When navigating, also fire `PATCH /notifications/{id}/read` if `readAt` is null (though `read-all` on open will usually have handled it already).

### Type icons and colours (suggested)

| `type` | Icon | Accent colour |
|---|---|---|
| `booking_received` | Calendar | Blue |
| `quote_approved` | CheckCircle | Green |
| `job_completed` | Wrench / Tool | Indigo |
| `invoice_paid` | CurrencyDollar | Emerald |

---

## Empty state

When `notifications` is an empty array: show "No notifications yet" inside the drawer.

When `?unread=true` returns empty: show "You're all caught up".

---

## Error handling

All endpoints return standard error shapes:

```json
{ "error": { "code": "...", "message": "..." } }
```

If `GET /notifications` fails, show a silent retry — don't disrupt the page. Badge should stay at its last known value rather than going to zero.
