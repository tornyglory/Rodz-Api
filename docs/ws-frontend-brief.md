# WebSocket — Frontend Implementation Brief

One persistent connection per session carries all real-time updates: notification toasts, live job state, and live hoist state. Replace all polling with this.

---

## Setup

```
VITE_WS_URL=wss://9x6wj1gzf6.execute-api.ap-southeast-2.amazonaws.com/prod
```

This is a separate endpoint from `VITE_API_URL` — do not reuse it.

---

## Connection

```
wss://9x6wj1gzf6.execute-api.ap-southeast-2.amazonaws.com/prod?token=<accessToken>
```

The JWT cannot be sent as a header on a WebSocket handshake (browser limitation), so it goes as a query param. The server validates it on connect and drops the socket with HTTP 401 if it's missing or invalid.

**Open** immediately after login or after `GET /auth/me` confirms the session.  
**Close** (code 1000) on logout or 401 redirect. Do not reconnect until the next login.

One connection per tab — multiple tabs each get their own connection and each receive every push independently. That's fine.

---

## Reconnect

AWS API Gateway closes idle connections after 10 minutes. Handle unexpected closes with exponential backoff:

```ts
const BACKOFF = [1000, 2000, 4000, 8000, 16000, 30000]
let attempt = 0

ws.onclose = (e) => {
  if (intentionalClose) return
  setTimeout(connect, BACKOFF[Math.min(attempt++, BACKOFF.length - 1)])
}

ws.onopen = () => {
  attempt = 0
  fetchNotifications()   // catch any missed while disconnected
}
```

Also reconnect when the tab becomes visible after being hidden:

```ts
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && ws.readyState !== WebSocket.OPEN) {
    connect()
  }
})
```

---

## Message handler

Every frame is JSON. Dispatch on `type`:

```ts
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data)
  switch (msg.type) {
    case 'notification':    handleNotification(msg.notification);  break
    case 'job_updated':     handleJobUpdated(msg.job);             break
    case 'hoist_updated':   handleHoistUpdated(msg.hoist);        break
    case 'jobs_reordered':  handleJobsReordered(msg.jobs);        break
  }
}
```

Ignore unknown `type` values — new types may be added.

---

## Message types

### `notification`

Fired when: booking received, quote approved, job completed, invoice paid.

```json
{
  "type": "notification",
  "notification": {
    "id": 17,
    "type": "invoice_paid",
    "title": "Invoice Paid",
    "body": "Invoice INV-2606-002 paid — $897.60",
    "readAt": null,
    "createdAt": "2026-06-26T00:46:54.785Z",
    "storeId": 1,
    "bookingId": null,
    "quoteId": null,
    "jobId": null,
    "invoiceId": 6
  }
}
```

| `type` value | When |
|---|---|
| `booking_received` | Customer submits a booking |
| `quote_approved` | Customer or staff approves a quote |
| `job_completed` | Job marked completed |
| `invoice_paid` | Invoice marked paid |

**What to do:**
1. Prepend to the local notifications list
2. Increment `unreadCount` by 1
3. Show a toast (see below)

---

### `job_updated`

Fired when: any field on a job changes (status, tech, time, hoist, notes, odometer), or a new job is created from a confirmed booking.

Full job object — identical shape to `GET /jobs` items:

```json
{
  "type": "job_updated",
  "job": {
    "id": 14,
    "jobNumber": "J00014",
    "bookingId": 14,
    "bookingRef": "BK-2606-014",
    "customerId": 5,
    "vehicleId": 7,
    "customer": "Sarah Thompson",
    "customerEmail": "sarah@example.com",
    "vehicle": "2019 Subaru Forester",
    "rego": "ABC123",
    "service": "Full Service",
    "services": [
      { "serviceTypeId": 1, "name": "Full Service", "category": "service", "customerDescription": null }
    ],
    "hoist": "Hoist 1",
    "hoistId": 1,
    "status": "open",
    "tech": "M. Guy",
    "assignedStaffId": 8,
    "store": "Somerville",
    "date": "2026-06-26",
    "slot": "morning",
    "startTime": "10:00",
    "durationMins": 90,
    "sortOrder": 2,
    "notes": null,
    "quoteId": null,
    "quoteStatus": null,
    "odometerIn": null,
    "startedAt": null,
    "completedAt": null
  }
}
```

**What to do:**
```ts
function handleJobUpdated(job) {
  const idx = jobs.findIndex(j => j.id === job.id)
  if (idx !== -1) {
    jobs[idx] = job           // replace existing
  } else {
    jobs.unshift(job)         // new job — prepend
  }
}
```

All views that read from the jobs store (`JobsView`, `HoistsView`, `MyDayView`, `Dashboard`) update automatically.

---

### `hoist_updated`

Fired when: tech is assigned/unassigned to a hoist, or any job on it changes status (which changes the hoist's derived status).

Full hoist object — identical shape to `GET /hoists` items:

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
    "assignedTech": "M. Guy",
    "assignedStaffId": 8,
    "status": "available"
  }
}
```

`status` values: `available` | `in_progress` | `awaiting_parts` | `awaiting_approval` | `completed`

**What to do:**
```ts
function handleHoistUpdated(hoist) {
  const idx = hoists.findIndex(h => h.id === hoist.id)
  if (idx !== -1) hoists[idx] = hoist
}
```

---

### `jobs_reordered`

Fired when: a drag-reorder cascades new `startTime`, `slot`, and `sortOrder` across jobs on a hoist. Sent instead of multiple `job_updated` messages. A `hoist_updated` always follows in the same batch.

Partial update — only the fields that changed:

```json
{
  "type": "jobs_reordered",
  "jobs": [
    { "id": 14, "sortOrder": 1, "startTime": "09:00", "slot": "morning" },
    { "id": 12, "sortOrder": 2, "startTime": "10:30", "slot": "morning" }
  ]
}
```

**What to do:**
```ts
function handleJobsReordered(updates) {
  for (const u of updates) {
    const job = jobs.find(j => j.id === u.id)
    if (job) {
      job.sortOrder = u.sortOrder
      job.startTime = u.startTime
      job.slot      = u.slot
    }
  }
}
```

---

## Notifications: remove polling, keep these two fetches

**Remove** any recurring timer that polls `GET /notifications`.

**Keep:**
- `GET /notifications` on initial app load — populate the inbox and get `unreadCount` before the WS connection opens
- `GET /notifications` on reconnect (`ws.onopen`) — catch any notifications that arrived during a disconnect gap

Everything after that is driven by WS pushes.

---

## Notification inbox behaviour (unchanged)

- Bell badge = `unreadCount` from initial fetch, incremented by 1 per incoming `notification` push
- On drawer open: call `PATCH /notifications/read-all` in the background, reset badge to 0
- On item tap: navigate to deep link, call `PATCH /notifications/{id}/read` if `readAt` is null

### Deep links

| `notification.type` | Navigate to |
|---|---|
| `booking_received` | `/bookings/{bookingId}` |
| `quote_approved` | `/quotes/{quoteId}` |
| `job_completed` | `/jobs/{jobId}` |
| `invoice_paid` | `/invoices/{invoiceId}` |

---

## Toast

Show for every incoming `notification` push. Auto-dismiss after 5 seconds. Stack if multiples arrive quickly.

```
┌──────────────────────────────────────┐
│  [icon]  Invoice Paid            ×   │
│          INV-2606-002 paid $897.60   │
│          [View Invoice]              │
└──────────────────────────────────────┘
```

| `type` | Icon | Colour |
|---|---|---|
| `booking_received` | Calendar | Blue |
| `quote_approved` | CheckCircle | Green |
| `job_completed` | Wrench | Indigo |
| `invoice_paid` | CurrencyDollar | Emerald |

The "View" button navigates to the deep link above and marks the notification read.

---

## Store scoping

Staff connected with `storeId = 1` receive pushes for store 1 only.  
`super_admin` connections (`storeId = null`) receive pushes for all stores.  
No filtering needed on the frontend — the server only sends what's relevant.

---

## Initial load sequence

```
Login / GET /auth/me → 200
  ├── connectWS(token)
  └── GET /notifications → set unreadCount, populate inbox

WS opens
  └── (no action needed — pushes will arrive)

WS closes unexpectedly
  └── reconnect with backoff
        └── on reconnect: GET /notifications once
```

---

## What fires what (backend reference)

| Action | Messages pushed |
|---|---|
| `PATCH /jobs/:id` (any field) | `job_updated` + `hoist_updated` for the job's hoist |
| `PATCH /jobs/:id` with `hoistId` (job moved) | `job_updated` + `hoist_updated` for both old and new hoist |
| `PATCH /hoists/:id` (tech assign) | `hoist_updated` |
| `PATCH /hoists/:id/jobs/reorder` | `jobs_reordered` + `hoist_updated` |
| Booking confirmed → job created | `job_updated` + `hoist_updated` |
| `POST /bookings` | `notification` (`booking_received`) |
| `POST /quotes/:id/approve` or customer link | `notification` (`quote_approved`) |
| `PATCH /jobs/:id` with `status: completed` | `notification` (`job_completed`) |
| `POST /invoices/:id/mark-paid` | `notification` (`invoice_paid`) |

All notification pushes also write to the `staff_notifications` table and are available via `GET /notifications`.
