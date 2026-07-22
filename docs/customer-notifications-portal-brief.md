# Customer notification centre — portal frontend brief

Wire a bell-icon notification centre into the customer portal. Same events that fire native pushes (quote ready, booking confirmed, service due, …) now also land in a portal feed the customer can read, tap-through, or clear. Backend is deployed.

## Base URL & auth

```
https://fzzrkscwd7.execute-api.ap-southeast-2.amazonaws.com
```

```
Authorization: Bearer <customer_jwt>
```

Every endpoint below scopes to the authenticated customer — a customer can only see and mutate their own notifications.

## Endpoints

| Method + Path | Purpose |
|---|---|
| `GET /c/notifications?limit=20&cursor={lastId}` | Paginated feed, newest first. |
| `GET /c/notifications/unread-count` | Small polling endpoint for the badge. |
| `POST /c/notifications/{id}/read` | Mark one as read. |
| `POST /c/notifications/read-all` | Mark every unread as read. Returns `{ marked: N }`. |

### List — response

```jsonc
{
  "notifications": [
    {
      "id":        142,
      "type":      "quote_ready",
      "title":     "Rodz",
      "body":      "New quote ready for your 2026 Toyota Corolla — Q-2026-042.",
      "deeplink":  "/account/paperwork?filter=quotes",
      "eventId":   "quote:87",
      "vehicleId": 4,
      "sentAt":    "2026-07-22T09:00:00Z",
      "readAt":    null       // ISO string once marked read
    }
  ],
  "nextCursor": 121          // send back as ?cursor= for the next page. null = end.
}
```

- `limit` defaults to 20, capped at 100.
- Ordering: by `id DESC` (proxy for `sent_at DESC`, but stable across ties).
- All notifications are returned regardless of read state. Filter in the UI if you want an "unread only" view.

### Unread count — response

```json
{ "unreadCount": 3 }
```

Backed by an index — cheap. Fine to poll every ~30 s while the portal is open.

### Mark one read — response

```json
{ "ok": true }
```

Idempotent: re-reading a read notification is a no-op. Returns `404` for a notification that doesn't exist or isn't owned by the caller.

### Mark all read — response

```json
{ "marked": 3 }
```

`marked` is exactly the number that flipped from unread to read on this call. Use it to update the badge locally.

## Where notifications come from

Every server-side event that today fires a native push also writes to this feed. That means the portal will show:

- `quote_ready` — new quote sent
- `invoice_ready` — new invoice sent
- `payment_received` — payment confirmed (Zeller webhook)
- `booking_confirmed` / `booking_reminder` — booking flow
- `car_ready` — vehicle ready for pickup
- `maintenance_due` — AI reco milestone
- `rego_expiring`
- `urgent_reco` — high-priority AI recommendation
- `workshop_message` — direct message from the workshop
- `assistant_followup` — AI follow-up nudge

Same message the mobile app receives — no separate content pipeline. If a customer has never installed the app (no `customer_push_tokens` row), the feed still populates because the server writes the audit row unconditionally after the suppression checks (prefs, quiet hours, dedupe, rate limits).

## UI shape

**Bell icon in the top nav:**

- Show a red dot / count badge when `unreadCount > 0`.
- Click → opens a dropdown (mobile: full-screen sheet).

**Dropdown / sheet:**

- Header: "Notifications" + "Mark all read" text button.
- Body: infinite-scroll list. Each row:
  - Icon by `type` (map on the frontend — mail for `quote_ready`, wrench for `service_due`, etc.).
  - `title` (usually "Rodz") + `body` on two lines.
  - Relative time from `sentAt` ("2 min ago", "yesterday").
  - Unread rows: bold body + subtle left border in the accent colour. Read rows: muted.
- Tap a row → mark it read + navigate to `deeplink`.
- "Mark all read" → hit the endpoint, decrement badge locally, remove all bold styling.

**Empty state:** "No notifications yet. When something happens with your vehicles, you'll see it here."

## Polling strategy

Two loops:

1. **Badge poll** — call `GET /c/notifications/unread-count` every 30 s while the portal is foregrounded. Pause when `document.visibilityState === 'hidden'`, resume on `visibilitychange`.
2. **List refresh** — refetch the first page (`GET /c/notifications?limit=20`) on:
   - Dropdown open
   - Route change (light — the badge already tells us if there's anything new)
   - After a `mark-read` or `mark-all-read` (or update locally without a refetch)

Don't poll the list itself. It's heavier and the badge count is enough to know whether to refresh.

## Client sketch — Vue example

```ts
// composables/useNotifications.ts
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { request } from '@/api/client'

export function useNotifications() {
  const unreadCount = ref(0)
  const notifications = ref<Notification[]>([])
  const cursor = ref<number | null>(null)
  const loading = ref(false)
  let pollTimer: number | null = null

  async function refreshUnreadCount() {
    const { unreadCount: n } = await request('/c/notifications/unread-count')
    unreadCount.value = n
  }

  async function loadFirstPage() {
    loading.value = true
    const { notifications: list, nextCursor } = await request('/c/notifications?limit=20')
    notifications.value = list
    cursor.value = nextCursor
    loading.value = false
  }

  async function loadMore() {
    if (!cursor.value || loading.value) return
    loading.value = true
    const { notifications: list, nextCursor } = await request(`/c/notifications?limit=20&cursor=${cursor.value}`)
    notifications.value.push(...list)
    cursor.value = nextCursor
    loading.value = false
  }

  async function markRead(id: number) {
    await request(`/c/notifications/${id}/read`, { method: 'POST' })
    const n = notifications.value.find(x => x.id === id)
    if (n && !n.readAt) {
      n.readAt = new Date().toISOString()
      unreadCount.value = Math.max(0, unreadCount.value - 1)
    }
  }

  async function markAllRead() {
    const { marked } = await request('/c/notifications/read-all', { method: 'POST' })
    for (const n of notifications.value) if (!n.readAt) n.readAt = new Date().toISOString()
    unreadCount.value = Math.max(0, unreadCount.value - marked)
  }

  function startPolling() {
    stopPolling()
    pollTimer = window.setInterval(() => {
      if (document.visibilityState === 'visible') refreshUnreadCount()
    }, 30_000)
  }

  function stopPolling() {
    if (pollTimer) { window.clearInterval(pollTimer); pollTimer = null }
  }

  onMounted(() => {
    refreshUnreadCount()
    startPolling()
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') refreshUnreadCount()
    })
  })
  onBeforeUnmount(stopPolling)

  return { unreadCount, notifications, loading, loadFirstPage, loadMore, markRead, markAllRead }
}
```

## Types

```ts
export type NotificationType =
  | 'booking_confirmed' | 'booking_reminder' | 'car_ready'
  | 'quote_ready' | 'invoice_ready' | 'payment_received'
  | 'maintenance_due' | 'rego_expiring' | 'urgent_reco'
  | 'workshop_message' | 'assistant_followup'
  | 'test'

export interface Notification {
  id:        number
  type:      NotificationType
  title:     string
  body:      string
  deeplink:  string
  eventId:   string
  vehicleId: number | null
  sentAt:    string
  readAt:    string | null
}
```

## Testing checklist

- [ ] Fresh account with no notifications → badge hidden, dropdown shows empty state.
- [ ] Staff sends a quote to the customer → within a few seconds the unread-count poll returns `1`, bell shows the badge, opening the dropdown reveals the row unread.
- [ ] Tap the row → navigates to the deeplink, row flips to read, badge decrements to 0.
- [ ] Send 25 notifications, open the dropdown → first page shows 20 newest, scroll fires `loadMore` and paginates, no dupes.
- [ ] "Mark all read" → all rows go to read, badge drops to 0, response reports `marked: N`.
- [ ] Try `POST /c/notifications/{id}/read` for someone else's notification → 404.
- [ ] Backgrounded tab (`visibilityState === 'hidden'`) → polling pauses. Foreground again → poll fires immediately.
- [ ] Customer with no mobile app installed at all still sees quote_ready etc. land in the portal feed.

## What this isn't

- **No web push** yet — the portal only shows notifications while it's open. If the customer closes the tab they'll only see the badge when they come back. A separate follow-up would extend `customer_push_tokens.platform` with `web` and wire VAPID + service worker.
- **No real-time channel** — the portal polls; new notifications appear within one poll interval (~30 s). If instant is required, a future upgrade would extend `ws_connections` to accept customer sockets and fan out on `pushToCustomer`.
