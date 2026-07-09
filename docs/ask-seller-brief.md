# Ask the Seller — Design Brief

Buyer-to-seller messaging on public vehicle profiles. Scoped to for-sale vehicles only. Both parties must have a Rodz account.

---

## User flow

**Buyer side**
1. Visits `/logbook/{token}` on a for-sale vehicle.
2. Sees "Ask the seller a question" button in the for-sale banner.
3. Clicking it:
   - If logged in as a customer → opens a compose panel with the message input.
   - If not logged in → prompts sign-in first, then returns to the profile with the compose panel open.
4. Sends the message → thread is created (or reused if one already exists for this buyer + vehicle) → confirmation shown.
5. Buyer can see all their outbound threads in a new **Messages** area of the customer portal.

**Seller side**
1. Receives an in-app notification and an email when a new question comes in.
2. Opens the **Messages** area (same tab as buyer view, filtered to threads where they're the seller).
3. Reads and replies.
4. Buyer gets a notification of the reply.

**Ownership transfer**
- Once a vehicle is transferred, the previous owner remains attached to their existing threads (they can still read/reply). The new owner does NOT inherit old conversations. The "Ask the seller" button on the public profile always targets the current owner — if a new thread is started after transfer, it's between the buyer and the new owner.

---

## Schema

### `vehicle_threads`

```sql
CREATE TABLE vehicle_threads (
  id                    BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
  vehicle_id            INT UNSIGNED NOT NULL,
  buyer_customer_id     INT UNSIGNED NOT NULL,
  seller_customer_id    INT UNSIGNED NOT NULL,   -- snapshot at thread creation
  created_at            DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_message_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  buyer_unread_count    INT          NOT NULL DEFAULT 0,
  seller_unread_count   INT          NOT NULL DEFAULT 0,
  buyer_last_read_at    DATETIME     NULL,
  seller_last_read_at   DATETIME     NULL,

  UNIQUE KEY uniq_vehicle_buyer_seller (vehicle_id, buyer_customer_id, seller_customer_id),
  INDEX idx_buyer  (buyer_customer_id, last_message_at DESC),
  INDEX idx_seller (seller_customer_id, last_message_at DESC),
  INDEX idx_vehicle (vehicle_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

- `seller_customer_id` is a snapshot at creation. If the vehicle is later transferred, we don't retroactively rewrite threads.
- `UNIQUE(vehicle_id, buyer_customer_id, seller_customer_id)` means one thread per (buyer, seller, vehicle) triple. If ownership changes and the buyer messages again, a new thread opens with the new seller.
- `last_message_at` drives inbox sort order.
- Unread counters + last-read timestamps power the badges.

### `vehicle_thread_messages`

```sql
CREATE TABLE vehicle_thread_messages (
  id                   BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
  thread_id            BIGINT       NOT NULL,
  sender_customer_id   INT UNSIGNED NOT NULL,
  content              TEXT         NOT NULL,
  created_at           DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,

  INDEX idx_thread (thread_id, id),
  FOREIGN KEY (thread_id) REFERENCES vehicle_threads(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

- No attachments in v1. No message editing / deleting. Content max 2000 chars.
- Sender must be either buyer OR seller of the thread — validated in the handler, not the DB.

### `ws_customer_connections`

Mirrors the existing `ws_connections` table (staff-side) but keyed to `customer_id`. Kept separate so staff and customer fanout logic don't collide.

```sql
CREATE TABLE ws_customer_connections (
  connection_id  VARCHAR(255) NOT NULL PRIMARY KEY,
  customer_id    INT UNSIGNED NOT NULL,
  connected_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at     DATETIME     NOT NULL,

  INDEX idx_customer (customer_id, expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

- Row inserted by the customer WS `$connect` handler after the customer JWT verifies.
- Row deleted by `$disconnect`, or by the push helper on a `410 GONE` from API Gateway (stale connection).
- `expires_at = NOW() + 2h` matches the staff table's convention.

### Rate limits

Reuse the `public_chat_rate_limits` table already in place — same shape works for messaging buckets.

---

## Endpoints

Base URL: `https://fzzrkscwd7.execute-api.ap-southeast-2.amazonaws.com`

All endpoints under `/c/` require a customer JWT (`Authorization: Bearer <token>`).

The buyer-side "start a thread" endpoint lives under `/logbook/{token}/` because the buyer is coming from the public profile and doesn't need to know the internal `vehicle_id`.

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `POST` | `/logbook/{token}/threads` | Customer JWT | Start (or reuse) a thread and post the first message |
| `GET`  | `/c/threads` | Customer JWT | Inbox — list all threads for this customer (as buyer OR seller) |
| `GET`  | `/c/threads/{id}` | Customer JWT | Thread detail with all messages |
| `POST` | `/c/threads/{id}/messages` | Customer JWT | Send a reply |
| `POST` | `/c/threads/{id}/read` | Customer JWT | Mark thread as read (clears unread count for this customer) |

### `POST /logbook/{token}/threads`

**Request**
```json
{ "message": "Hi — is the odometer 95k genuine? Any receipts?" }
```

| Field | Type | Notes |
|-------|------|-------|
| `message` | string | Required. Max 2000 chars. |

**Response — 201**
```json
{
  "threadId":  42,
  "messageId": 101,
  "createdAt": "2026-07-08T09:12:33Z"
}
```

**Errors**
| Status | Code | When |
|--------|------|------|
| 401 | `UNAUTHORIZED` | Missing/invalid customer JWT |
| 400 | `BAD_REQUEST` | Empty message or too long |
| 404 | `NOT_FOUND` | Token invalid |
| 409 | `NOT_FOR_SALE` | Vehicle isn't currently listed — messaging disabled |
| 409 | `OWN_VEHICLE` | Sender is the current owner |
| 410 | `GONE` | Vehicle deactivated |
| 429 | `RATE_LIMITED` | Buyer sending too fast |

Rate limits:
- 20 messages / hour per buyer_customer_id (total, across all threads)
- 5 messages / minute per buyer_customer_id (burst guard)

### `GET /c/threads`

Optional query params:
- `role` — `"buyer"` | `"seller"` | omit for all
- `limit` — default 25, max 100
- `before` — ISO timestamp cursor for pagination on `last_message_at`

**Response — 200**
```json
{
  "threads": [
    {
      "id":              42,
      "vehicleId":       7,
      "vehicleRego":     "LWF251",
      "vehicleLabel":    "2017 Suzuki Vitara",
      "vehicleAvatarUrl": "https://imagedelivery.net/.../thumbnail",
      "logbookToken":    "abc123...",
      "role":            "seller",
      "counterparty":    { "customerId": 17, "name": "John Smith" },
      "lastMessage":     {
        "content":   "Hi — is the odometer 95k genuine?",
        "createdAt": "2026-07-08T09:12:33Z",
        "senderCustomerId": 17
      },
      "unreadCount":     1,
      "createdAt":       "2026-07-08T09:12:33Z"
    }
  ],
  "hasMore":     false,
  "nextCursor":  null
}
```

**Notes**
- `role` is `"buyer"` if the current customer is the buyer of that thread, `"seller"` otherwise.
- `counterparty.name` is `first_name + last_name`. Never expose email/phone in the inbox — those live on the vehicle listing separately.
- `unreadCount` is `buyer_unread_count` or `seller_unread_count` depending on role.

### `GET /c/threads/{id}`

Guard: caller must be buyer OR seller of the thread. Otherwise `403`.

**Response — 200**
```json
{
  "id":            42,
  "vehicleId":     7,
  "vehicleRego":   "LWF251",
  "vehicleLabel":  "2017 Suzuki Vitara",
  "logbookToken":  "abc123...",
  "role":          "seller",
  "counterparty":  { "customerId": 17, "name": "John Smith" },
  "createdAt":     "2026-07-08T09:12:33Z",
  "messages": [
    {
      "id":               101,
      "content":          "Hi — is the odometer 95k genuine?",
      "senderCustomerId": 17,
      "mine":             false,
      "createdAt":        "2026-07-08T09:12:33Z"
    },
    {
      "id":               105,
      "content":          "Yep — I have all the service receipts.",
      "senderCustomerId": 4,
      "mine":             true,
      "createdAt":        "2026-07-08T09:20:11Z"
    }
  ]
}
```

- `mine` is a convenience flag so the frontend knows which bubble to align right.
- **Side effect**: this endpoint marks the thread as read for the caller (updates `*_last_read_at` and zeros `*_unread_count`). Simpler than requiring a separate call, and matches typical inbox UX.

### `POST /c/threads/{id}/messages`

Guard: caller must be buyer OR seller of the thread.

**Request**
```json
{ "message": "Yep — I have all the service receipts." }
```

**Response — 201**
```json
{
  "messageId":     105,
  "createdAt":     "2026-07-08T09:20:11Z"
}
```

Rate limits: same as the initial thread post (20/hour, 5/minute per customer).

### `POST /c/threads/{id}/read`

Marks read without loading messages (used by inbox badges, background sync, etc.). Response: `204`. Guard same as above.

---

## Realtime delivery (WebSockets)

All in-app delivery is via WebSocket. No polling from the client.

### Customer WS route

Add a new WebSocket route dedicated to customers. Do **not** merge into the existing staff `ws_connections` table.

| Route key | Handler | Purpose |
|-----------|---------|---------|
| `$connect` | `src/websocket/customer/connect.ts` | Verify customer JWT (`?token=<jwt>`), insert into `ws_customer_connections` |
| `$disconnect` | `src/websocket/customer/disconnect.ts` | Delete row from `ws_customer_connections` |
| `$default` | `src/websocket/customer/default.ts` | No-op (200) — clients don't send frames |

The customer JWT payload has `sub = customer_id`. Verify with the same `JWT_SECRET` used by the customer authorizer.

### Push helper

Add `pushToCustomer(db, customerId, message)` to `src/shared/wsPush.ts`, mirroring `pushToStore`:

```ts
export async function pushToCustomer(db: mysql.Pool, customerId: number, message: object): Promise<boolean>
```

- Queries `ws_customer_connections WHERE customer_id = ? AND expires_at > NOW()`.
- Sends the payload to every connection via `PostToConnectionCommand`.
- Deletes rows that come back `410 GONE`.
- **Returns `true` if at least one connection received the frame, `false` if the customer has no live connections.** Callers use this to decide whether to send the offline email.

### Payloads

Two message types are pushed:

```json
{
  "type": "message_created",
  "threadId": 42,
  "message": {
    "id": 105,
    "content": "Yep — I have all the service receipts.",
    "senderCustomerId": 17,
    "createdAt": "2026-07-08T09:20:11Z"
  }
}
```

```json
{
  "type": "thread_created",
  "thread": { /* ThreadSummary shape from GET /c/threads */ }
}
```

- `message_created` is sent to **the recipient only** (the non-sender party of the thread). Do not echo back to the sender — the sender already has the message locally from the POST response.
- `thread_created` is sent to the **seller only** when a brand-new thread is opened via `POST /logbook/{token}/threads`. It carries the full `ThreadSummary` so the seller's inbox can prepend the row without a refetch.

### Flow

When a message is sent (or a thread is created):
1. Insert `vehicle_thread_messages` row.
2. Update thread: `last_message_at = NOW()`, increment the recipient's `*_unread_count`.
3. Call `pushToCustomer(db, recipientCustomerId, payload)`.
4. **If the push returned `false` (recipient offline), fire the email.** SES, one-liner template, deep-link to `/messages/{threadId}` in the customer portal. If it returned `true`, skip the email — the in-app notification is enough.

No debounce is required: the online/offline gate is the debounce. A user actively reading their inbox will never receive an email for that thread; a user who never opens the app gets one email per new message.

---

## UI states (frontend)

### Public profile — for-sale banner (buyer entry point)
```
┌─────────────────────────────────────────┐
│  Listed for sale                        │
│  $18,500 · Melbourne, Australia         │
│                                         │
│  [Ask the seller a question]            │  ← button
│  or contact John: 0400 000 000          │
└─────────────────────────────────────────┘
```

- Button is only shown when `forSale = true`.
- If the visitor is not signed in, clicking prompts sign-in with a return path.
- If the visitor IS the current owner of the vehicle, hide the button entirely (backend also blocks with 409 as a defence-in-depth).

### Compose panel (over the profile)
```
┌─────────────────────────────────────────┐
│  Ask John about their 2017 Vitara      │
│                                         │
│  [ multi-line text input ]              │
│                                         │
│  [Cancel]              [Send message]   │
└─────────────────────────────────────────┘
```
- Show 2000-char counter.
- On success: swap to "Sent — John will get back to you. Track replies in Messages." with a link to `/messages/{threadId}`.

### Messages inbox (new route in customer portal — `/messages`)
- Two filter tabs at the top: **All** / **As buyer** / **As seller**.
- List of thread cards: vehicle avatar, counterparty name, snippet of last message, timestamp, unread badge.
- Empty state per filter.

### Thread detail (`/messages/{id}`)
- Header: vehicle avatar + label + rego + link back to the public profile (if listing is still active) or "Vehicle no longer listed" note (if `for_sale = 0` — still readable, just can't start a new thread).
- Chat bubble layout, right-aligned for `mine: true`.
- Reply input at the bottom, same 2000-char cap.
- Auto-scroll to newest on load.

### Notification surfaces
- Existing rail badge in the customer portal picks up unread count (sum across all threads).
- Email uses whatever transactional template pattern is already established.

---

## Guards summary

| Rule | Enforced where |
|------|----------------|
| Buyer must be authenticated | JWT verifier |
| Buyer must be a real customer (not workshop staff) | Customer authorizer |
| Buyer ≠ current owner of the vehicle | `POST /logbook/{token}/threads` handler |
| Vehicle must be `for_sale = 1` at thread creation | `POST /logbook/{token}/threads` handler |
| Only thread participants can read/write | `GET/POST /c/threads/{id}*` handlers |
| Message length ≤ 2000 chars | All send endpoints |
| Rate limits | `public_chat_rate_limits` table, per-customer buckets |

Once a thread exists, it stays readable even if the vehicle is later delisted or transferred (both parties can still see the history). Only *starting* a new thread requires `for_sale = 1`.

---

## Out of scope for v1

- Attachments (photos, files)
- Message editing / deleting
- Blocking / reporting users
- Read receipts (we track last-read internally but don't expose it)
- Native push notifications (in-app WS + email only — no APNs/FCM)
- Search across threads
- Multi-party threads / group chat
- Typing indicators / presence

---

## Implementation order

1. Migration for `vehicle_threads`, `vehicle_thread_messages`, `ws_customer_connections`.
2. Customer WS route + `$connect`/`$disconnect` handlers.
3. `pushToCustomer` helper in `src/shared/wsPush.ts`.
4. `POST /logbook/{token}/threads` handler + route (buyer entry point) → pushes `thread_created` to seller.
5. `GET /c/threads` (inbox list — single fetch, no polling).
6. `GET /c/threads/{id}` (thread detail + auto-mark-read).
7. `POST /c/threads/{id}/messages` (reply) → pushes `message_created` to counterparty; falls back to email if offline.
8. `POST /c/threads/{id}/read` (explicit mark-read for badges).
9. Frontend implementation (uses the frontend brief).
