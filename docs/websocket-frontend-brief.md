# WebSocket — Frontend Implementation Brief

The backend WebSocket push is fully working and verified. A direct test push to the active connection succeeded at the API Gateway level but nothing appeared in the UI — the frontend is receiving messages but not handling them.

---

## Connection

**URL:** `wss://9x6wj1gzf6.execute-api.ap-southeast-2.amazonaws.com/prod`

Connect with the staff JWT passed as a query param — API Gateway validates it via the `$connect` Lambda before the connection is accepted:

```ts
const ws = new WebSocket(
  `wss://9x6wj1gzf6.execute-api.ap-southeast-2.amazonaws.com/prod?token=${jwt}`
)
```

A `401` on connect means the token is missing or invalid. A `101 Switching Protocols` means the connection is live and the session is registered server-side.

---

## Reconnection

API Gateway drops idle WebSocket connections after **10 minutes of inactivity**. The frontend must reconnect automatically:

```ts
function connect() {
  const ws = new WebSocket(`wss://9x6wj1gzf6.execute-api.ap-southeast-2.amazonaws.com/prod?token=${getJwt()}`)

  ws.onclose = () => {
    setTimeout(connect, 3000) // reconnect after 3s
  }

  ws.onerror = () => {
    ws.close() // triggers onclose → reconnect
  }

  ws.onmessage = handleMessage
}
```

Alternatively send a ping every 8–9 minutes to keep the connection alive.

---

## Message handling

All messages from the server have this shape:

```ts
interface WsMessage {
  type: string
  [key: string]: unknown
}
```

The `type` field determines what to do. Parse and dispatch:

```ts
function handleMessage(event: MessageEvent) {
  let msg: WsMessage
  try {
    msg = JSON.parse(event.data)
  } catch {
    return
  }

  switch (msg.type) {
    case 'notification':
      handleNotification(msg.notification as ApiNotification)
      break
    case 'job_updated':
      handleJobUpdated(msg.job)
      break
    case 'hoist_updated':
      handleHoistUpdated(msg.hoist)
      break
    case 'jobs_reordered':
      handleJobsReordered(msg.jobs)
      break
  }
}
```

---

## `notification` messages

Triggered by: new website booking, quote approved, job completed, invoice paid.

**Payload:**

```ts
interface ApiNotification {
  id:        number
  type:      'booking_received' | 'quote_approved' | 'job_completed' | 'invoice_paid'
  title:     string
  body:      string
  storeId:   number | null
  bookingId: number | null
  quoteId:   number | null
  jobId:     number | null
  invoiceId: number | null
  readAt:    null             // always null on push — not read yet
  createdAt: string           // ISO 8601
}
```

**Example push received from server:**

```json
{
  "type": "notification",
  "notification": {
    "id": 57,
    "type": "booking_received",
    "title": "New Booking",
    "body": "Howie Test — 1991 Nissan 300ZX — 2026-06-30 (Afternoon)",
    "storeId": 1,
    "bookingId": 35,
    "quoteId": null,
    "jobId": null,
    "invoiceId": null,
    "readAt": null,
    "createdAt": "2026-06-28T16:11:09.000Z"
  }
}
```

**What to do on receipt:**

1. Prepend the notification to the local notification list
2. Increment the unread badge count by 1
3. Show a toast using `notification.title` and `notification.body`

```ts
function handleNotification(notification: ApiNotification) {
  // 1. Add to notification list
  setNotifications(prev => [notification, ...prev])

  // 2. Increment unread count
  setUnreadCount(prev => prev + 1)

  // 3. Toast
  showToast({
    title: notification.title,
    body:  notification.body,
  })
}
```

---

## Notification REST endpoints

Use these to populate the bell on load and to mark notifications read.

### `GET /notifications`

Returns the 50 most recent notifications for the logged-in staff member.

Query param `?unread=true` returns only unread.

```json
{
  "notifications": [ ...ApiNotification[] ],
  "unreadCount": 3
}
```

### `PATCH /notifications/:id/read`

Marks a single notification read. Returns the updated notification object.

### `PATCH /notifications/read-all`

Marks all unread notifications for the logged-in staff member as read.

```json
{ "updated": 3 }
```

---

## Other push message types

These are used by the job board and do not involve notifications.

### `job_updated`

A job was created, updated, or its status changed. Refresh the relevant job on the board.

```json
{ "type": "job_updated", "job": { ...Job } }
```

### `hoist_updated`

A hoist's assignment or active job count changed. Refresh the hoist column header.

```json
{ "type": "hoist_updated", "hoist": { ...Hoist } }
```

### `jobs_reordered`

The sort order of jobs on a hoist changed. Re-render the hoist column in the new order.

```json
{ "type": "jobs_reordered", "jobs": [ ...Job[] ] }
```

---

## Verification steps

To confirm messages are arriving before touching the UI layer, add a temporary log in `handleMessage`:

```ts
ws.onmessage = (event) => {
  console.log('[WS received]', event.data)
  handleMessage(event)
}
```

Submit a booking via the website while the browser console is open — you should see the raw JSON appear within 1–2 seconds.
