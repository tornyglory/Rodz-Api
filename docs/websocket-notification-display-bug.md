# WebSocket Notification Display — Bug Brief

## What's confirmed working

The backend push pipeline is fully operational. A message was pushed directly to the active browser connection via the AWS management API and was accepted with no error. The frontend **is receiving the message** — it's just not displaying it.

---

## What the server sends

When a booking is created, the server pushes this JSON string over the WebSocket:

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

The outer `type` is always `"notification"`. The inner `notification` object is the payload.

---

## How to confirm receipt in the browser

Before touching any display code, add a temporary log to `ws.onmessage`:

```ts
ws.onmessage = (event) => {
  console.log('[WS]', event.data)
}
```

Submit a test booking via the website. The raw JSON above should appear in the console within 1–2 seconds. If it does, the issue is purely in the display layer. If it doesn't, the WebSocket connection has silently dropped — see the reconnection note below.

---

## What needs to happen on receipt

```ts
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data)

  if (msg.type === 'notification') {
    const n = msg.notification

    // 1. Show a toast
    showToast({ title: n.title, body: n.body })

    // 2. Prepend to notification list
    setNotifications(prev => [n, ...prev])

    // 3. Increment unread badge
    setUnreadCount(prev => prev + 1)
  }
}
```

---

## Reconnection (likely root cause if the console log doesn't appear)

API Gateway silently drops WebSocket connections that are idle for **10 minutes**. If the portal has been open for more than 10 minutes without a page refresh, the connection is dead but the frontend doesn't know — `onmessage` never fires.

Fix with auto-reconnect:

```ts
function connect() {
  const ws = new WebSocket(`wss://9x6wj1gzf6.execute-api.ap-southeast-2.amazonaws.com/prod?token=${getJwt()}`)
  ws.onmessage = handleMessage
  ws.onclose = () => setTimeout(connect, 3000)
  ws.onerror = () => ws.close()
}
```
