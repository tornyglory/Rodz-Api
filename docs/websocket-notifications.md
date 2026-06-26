# WebSocket Notifications — Frontend Brief

Real-time push delivery for staff notifications. When a booking arrives, a quote is approved, a job is completed, or an invoice is paid, the server pushes the notification directly to every connected staff member for that store. No polling required.

---

## Environment variable

Add to your `.env` / deployment config:

```
VITE_WS_URL=wss://9x6wj1gzf6.execute-api.ap-southeast-2.amazonaws.com/prod
```

The HTTP API and WS API are separate AWS endpoints — do not reuse `VITE_API_URL`.

---

## Connection URL

```
wss://9x6wj1gzf6.execute-api.ap-southeast-2.amazonaws.com/prod?token=<accessToken>
```

The `accessToken` from `/auth/login` is passed as a query param because browsers cannot set custom headers during a WebSocket handshake. The server validates the JWT on connect and rejects with HTTP 401 if it is missing or invalid.

The server stores the connection for **24 hours** — you do not need to reconnect periodically.

---

## When to connect / disconnect

| Event | Action |
|---|---|
| Login succeeds (`POST /auth/login` → 200) | Open WS connection |
| App loads with existing token (`GET /auth/me` → 200) | Open WS connection |
| Logout | Close connection (code 1000) |
| Token expires / 401 redirect | Close connection, do not reconnect until next login |

Open one connection per session. If the user has multiple tabs open, each tab will have its own connection and each will receive the push independently — this is fine.

---

## Message format

Every server push has this envelope:

```json
{
  "type": "notification",
  "notification": { ... }
}
```

Check `message.type === "notification"` before acting — future message types may be added.

The `notification` object has the same shape as the REST API (`GET /notifications`):

```json
{
  "id": 17,
  "type": "invoice_paid",
  "title": "Invoice Paid",
  "body": "Invoice INV-2606-002 paid — $897.60",
  "readAt": null,
  "createdAt": "2026-06-25T23:46:54.785Z",
  "storeId": 1,
  "bookingId": null,
  "quoteId": null,
  "jobId": null,
  "invoiceId": 6
}
```

`readAt` will always be `null` on a freshly pushed notification. `createdAt` is ISO 8601 UTC.

---

## Notification types

| `type` | When it fires | Navigate on tap |
|---|---|---|
| `booking_received` | Customer submits a booking | `/bookings/{bookingId}` |
| `quote_approved` | Customer or staff approves a quote | `/quotes/{quoteId}` |
| `job_completed` | A job is marked completed | `/jobs/{jobId}` |
| `invoice_paid` | An invoice is marked paid | `/invoices/{invoiceId}` |

---

## What to do when a message arrives

1. **Parse the payload** — `JSON.parse(event.data)`
2. **Guard on type** — ignore if `parsed.type !== "notification"`
3. **Prepend to local state** — push to the front of your notifications list so it appears at the top
4. **Increment `unreadCount`** — add 1 to the badge counter
5. **Show a toast** — display `notification.title` + `notification.body` for 4–5 seconds with an action to navigate to the related record

---

## Reconnect strategy

AWS API Gateway closes idle WS connections after 10 minutes. The client must reconnect when this happens.

```
onclose(event):
  if event.code === 1000 → intentional, do nothing
  else → schedule reconnect with exponential backoff

Backoff: 1s → 2s → 4s → 8s → 16s → 30s (cap)
Reset backoff counter on successful open
```

Also reconnect immediately when the tab becomes visible again after being hidden:

```js
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && ws.readyState !== WebSocket.OPEN) {
    reconnect()
  }
})
```

When reconnecting after a gap, fetch `GET /notifications` once to pick up any notifications that arrived while disconnected.

---

## Suggested implementation

```ts
// ws.ts
const WS_URL = import.meta.env.VITE_WS_URL

let ws: WebSocket | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let backoff = 1000
let intentionalClose = false

export function connectWS(token: string, onNotification: (n: Notification) => void) {
  intentionalClose = false
  open(token, onNotification)
}

export function disconnectWS() {
  intentionalClose = true
  if (reconnectTimer) clearTimeout(reconnectTimer)
  ws?.close(1000)
  ws = null
}

function open(token: string, onNotification: (n: Notification) => void) {
  ws = new WebSocket(`${WS_URL}?token=${token}`)

  ws.onopen = () => {
    backoff = 1000
  }

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data)
      if (msg.type === 'notification') {
        onNotification(msg.notification)
      }
    } catch {
      // ignore malformed frames
    }
  }

  ws.onclose = (event) => {
    if (intentionalClose) return
    reconnectTimer = setTimeout(() => {
      open(token, onNotification)
      backoff = Math.min(backoff * 2, 30_000)
    }, backoff)
  }

  ws.onerror = () => {
    ws?.close()
  }
}
```

Call `connectWS(accessToken, handler)` immediately after login or after `GET /auth/me` confirms the session. Call `disconnectWS()` on logout and on 401 redirect.

---

## Replace polling

The previous `staff-notifications.md` brief said to poll every 30–60 seconds. **Remove that timer.** The WS push replaces it.

Keep only:
- `GET /notifications` on **initial app load** — to populate the inbox before the WS connection is established
- `GET /notifications` on **tab focus after reconnect** — to catch any gap during a disconnect

Do not set a recurring interval.

---

## Initial load flow

```
App loads / login succeeds
  ├── GET /notifications          → populate inbox + set unreadCount from response
  └── connectWS(token, handler)   → start receiving real-time pushes

Tab hidden → tab visible
  └── if WS was closed: reconnect, then GET /notifications once
```

---

## Notification inbox (existing behaviour, unchanged)

`GET /notifications` — fetch the 50 most recent, populate the drawer.

On drawer open — call `PATCH /notifications/read-all` in the background, clear badge.

On individual tap — navigate to deep link, call `PATCH /notifications/{id}/read` if `readAt` is null.

See `staff-notifications.md` for full REST API reference.

---

## Toast design (suggestion)

Show a dismissible toast in the bottom-right corner:

```
[icon]  Invoice Paid                    ×
        Invoice INV-2606-002 paid — $897.60
        [View Invoice]
```

| `type` | Icon | Accent |
|---|---|---|
| `booking_received` | Calendar | Blue |
| `quote_approved` | CheckCircle | Green |
| `job_completed` | Wrench | Indigo |
| `invoice_paid` | CurrencyDollar | Emerald |

Auto-dismiss after 5 seconds. If multiple arrive in quick succession, stack them.

---

## Local dev

The WS API is the same in dev and production — it connects to the live backend. Set `VITE_WS_URL` in `.env.local`:

```
VITE_WS_URL=wss://9x6wj1gzf6.execute-api.ap-southeast-2.amazonaws.com/prod
```

If `VITE_WS_URL` is not set, skip the connection attempt silently — do not throw.

---

## What the server does (no action needed)

- On connect: stores `(connectionId, staffId, storeId, role, expires_at)` in MySQL
- On notification event: queries all active connections for the relevant store, pushes to each
- On stale connection (AWS returns 410 Gone): auto-deletes the row
- On disconnect: deletes the row immediately

`super_admin` connections receive pushes for **all stores**. Store-scoped staff only receive pushes for their own store.

---

# Jobs & Hoists Real-time Updates

The same WS connection carries two additional message types — `job_updated`, `hoist_updated`, and `jobs_reordered` — that keep the jobs board, hoists view, and My Day in sync across all open tabs without polling or refreshes.

---

## When the server pushes

### `job_updated`

Fires on every field change to a job.

| Endpoint | Trigger |
|---|---|
| `PATCH /jobs/{id}` | Status, time, tech, hoist, notes, odometer |
| `PATCH /hoists/{id}/jobs/reorder` | *(sends `jobs_reordered` instead — see below)* |

### `hoist_updated`

Fires whenever a hoist's derived status changes.

| Endpoint | Trigger |
|---|---|
| `PATCH /jobs/{id}` | Any status change re-evaluates the hoist status |
| `PATCH /jobs/{id}` with new `hoistId` | Both old and new hoists are re-evaluated |
| `PATCH /hoists/{id}` | Tech assigned or unassigned |
| `PATCH /hoists/{id}/jobs/reorder` | Reorder may shift slot/time which changes hoist state |

### `jobs_reordered`

Fires instead of multiple `job_updated` messages when a drag-reorder cascades time changes across multiple jobs.

| Endpoint | Trigger |
|---|---|
| `PATCH /hoists/{id}/jobs/reorder` | All affected jobs as one batch |

---

## Message shapes

### `job_updated`

Full job object — same shape as `GET /jobs`:

```json
{
  "type": "job_updated",
  "job": {
    "id": 12,
    "jobNumber": "J00012",
    "bookingId": 9,
    "bookingRef": "BK-2606-009",
    "customerId": 5,
    "vehicleId": 7,
    "customer": "Sarah Thompson",
    "customerEmail": "sarah@example.com",
    "vehicle": "2019 Subaru Forester",
    "rego": "ABC123",
    "service": "Full Service",
    "services": [ { "serviceTypeId": 1, "name": "Full Service", "category": "service", "customerDescription": null } ],
    "hoist": "Hoist 1",
    "hoistId": 1,
    "status": "in_progress",
    "tech": "Howard R.",
    "assignedStaffId": 4,
    "store": "Somerville",
    "date": "2026-06-26",
    "slot": "morning",
    "startTime": "10:00",
    "durationMins": 90,
    "sortOrder": 1,
    "notes": null,
    "quoteId": null,
    "quoteStatus": null,
    "odometerIn": null,
    "startedAt": "2026-06-26T00:02:11.000Z",
    "completedAt": null
  }
}
```

### `hoist_updated`

Full hoist object — same shape as `GET /hoists`:

```json
{
  "type": "hoist_updated",
  "hoist": {
    "id": 1,
    "label": "Hoist 1",
    "store": "Somerville",
    "isTyreBay": false,
    "sortOrder": 1,
    "roles": [],
    "assignedTech": "Howard R.",
    "assignedStaffId": 4,
    "status": "in_progress"
  }
}
```

Hoist `status` values: `available` | `in_progress` | `awaiting_parts` | `awaiting_approval` | `completed`

### `jobs_reordered`

Partial update — only the sort/time fields that changed:

```json
{
  "type": "jobs_reordered",
  "jobs": [
    { "id": 12, "sortOrder": 1, "startTime": "09:00", "slot": "morning" },
    { "id": 11, "sortOrder": 2, "startTime": "10:30", "slot": "morning" }
  ]
}
```

A `hoist_updated` message always follows a `jobs_reordered` message in the same push batch.

---

## Frontend handling

Patch local state in place — no re-fetch needed.

### `job_updated`

```ts
case 'job_updated': {
  const idx = jobs.findIndex(j => j.id === msg.job.id)
  if (idx !== -1) {
    jobs[idx] = msg.job          // replace in place
  } else {
    jobs.unshift(msg.job)        // new job for today — prepend
  }
  break
}
```

### `hoist_updated`

```ts
case 'hoist_updated': {
  const idx = hoists.findIndex(h => h.id === msg.hoist.id)
  if (idx !== -1) hoists[idx] = msg.hoist
  break
}
```

### `jobs_reordered`

```ts
case 'jobs_reordered': {
  for (const update of msg.jobs) {
    const job = jobs.find(j => j.id === update.id)
    if (job) {
      job.sortOrder = update.sortOrder
      job.startTime = update.startTime
      job.slot      = update.slot
    }
  }
  break
}
```

All views that read from the shared jobs/hoists store (`JobsView`, `HoistsView`, `MyDayView`, `DashboardView`) update automatically — no additional wiring needed per view.

**My Day benefits most from this.** Technicians keep the page open all day. When a coordinator reassigns a job or changes a start time, it appears on the tech's screen in under a second. My Day filters by `assignedStaffId`, so any `job_updated` for a job assigned to that tech shows or hides automatically.

---

## Store scoping

Same as notifications — pushes go to connections where `store_id` matches the job's store, plus all `super_admin` connections (`store_id IS NULL`).
