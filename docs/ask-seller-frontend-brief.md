# Ask the Seller — Frontend Implementation Brief

Buyer-to-seller messaging on the public vehicle profile. Everything needed to build the entry point on the public profile, the compose flow, the inbox route, and the thread detail view in the customer portal.

Full API contract lives in `ask-seller-brief.md`. This document focuses on frontend structure and UX.

---

## Base URL

```
https://fzzrkscwd7.execute-api.ap-southeast-2.amazonaws.com
```

- `/logbook/{token}/threads` — **no auth for the profile page itself, but this POST requires a customer JWT**
- `/c/threads*` — requires a customer JWT

---

## Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `POST` | `/logbook/:token/threads` | Customer JWT | Buyer starts (or reuses) a thread and posts first message |
| `GET`  | `/c/threads` | Customer JWT | Inbox — all threads this customer is part of |
| `GET`  | `/c/threads/:id` | Customer JWT | Thread detail with messages (auto-marks read) |
| `POST` | `/c/threads/:id/messages` | Customer JWT | Reply |
| `POST` | `/c/threads/:id/read` | Customer JWT | Mark read without loading messages |

---

## Routes to add

| Path | Component | Auth |
|------|-----------|------|
| `/messages` | `MessagesInboxView` | Customer required |
| `/messages/:threadId` | `MessagesThreadView` | Customer required |

Add a rail item in `CustomerSidebar.vue` for **Messages** (icon: `IconMessages` or `IconMail` from `@tabler/icons-vue`). Show an unread badge derived from the inbox's total unread count.

---

## 1. Public profile entry point

Location: for-sale banner inside the public vehicle profile page (`/logbook/:token`), rendered from the `GET /logbook/:token/vehicle` response when `forSale === true`.

### When to show the button

- `vehicle.forSale === true` **AND**
- current viewer is either signed out **OR** is a customer who is NOT the current owner of this vehicle

If the viewer IS the current owner, hide the button (backend also blocks with `409 OWN_VEHICLE` as defence-in-depth). "Am I the owner?" — the frontend already loads `/c/vehicles` for signed-in customers; cross-reference `vehicle.id` (from the token profile) against the customer's owned vehicles.

### Visual

Sits inside the existing for-sale banner (see `vehicle-profile-new-features-brief.md` §4):

```
┌─────────────────────────────────────────┐
│  Listed for sale                        │
│  $18,500 · Melbourne, Australia         │
│                                         │
│  Contact: John Smith                    │
│  0400 000 000 · john@example.com        │
│                                         │
│  [ Ask John a question ]  ← button      │
└─────────────────────────────────────────┘
```

- Button label uses the seller's first name if available: **"Ask John a question"**. Falls back to **"Ask the seller a question"** if `contactName` is null.
- Solid pink button (`--ca-pink`), full width on mobile, inline on desktop.

### Click behaviour

Three branches based on auth state:

**Signed in as a customer (not the owner)** → open the compose panel inline (drawer on desktop, full-screen sheet on mobile).

**Not signed in** → redirect to sign-in with a return path:
```
/login?returnTo=/logbook/{token}?compose=1
```
After successful sign-in, the profile page opens with `?compose=1` in the URL — that query flag opens the compose panel automatically. Strip the query param from the URL after opening.

**Signed in as workshop staff** → hide the button. Staff have a different portal and no `customerId`.

---

## 2. Compose panel

Component: `ComposeSellerMessage.vue` (new).

### Layout

```
┌─────────────────────────────────────────┐
│  ← Back    Ask John about the Vitara    │
│                                         │
│  ┌─────────────────────────────────┐    │
│  │ Hi John, is the odometer 95k    │    │
│  │ genuine? Any receipts?          │    │
│  │                                 │    │
│  │                                 │    │
│  └─────────────────────────────────┘    │
│                              48 / 2000  │
│                                         │
│  Your name and Rodz-registered email    │
│  will be shared with the seller when    │
│  you send this.                         │
│                                         │
│  [Cancel]              [Send message]   │
└─────────────────────────────────────────┘
```

- Multi-line textarea, autofocus, 6 rows.
- Live character counter, max 2000. Disable Send when empty or over limit.
- Disclosure line under the input clarifies what's shared — buyer name (first + last) is shown to the seller, email is not exposed automatically but the message thread is linked to the buyer's account so replies come back through the app.
- Sending shows a spinner on the Send button.

### Submit

```ts
POST /logbook/{token}/threads
Authorization: Bearer <customer_jwt>
Content-Type: application/json

{ "message": "Hi John, is the odometer 95k genuine? Any receipts?" }
```

Response:
```json
{ "threadId": 42, "messageId": 101, "createdAt": "2026-07-08T09:12:33Z" }
```

### Success state

Swap the compose panel content for a confirmation:

```
┌─────────────────────────────────────────┐
│  ✓ Message sent                          │
│                                         │
│  John will get a notification. You'll   │
│  see their reply in your Messages inbox.│
│                                         │
│  [View in Messages]     [Close]         │
└─────────────────────────────────────────┘
```

**View in Messages** navigates to `/messages/{threadId}`.
**Close** returns to the profile view.

### Error handling

| Status | Code | UI |
|--------|------|----|
| 400 | `BAD_REQUEST` | Inline error under the textarea: "Message can't be empty" / "Message is too long" |
| 401 | `UNAUTHORIZED` | JWT expired — kick to `/login?returnTo=...` |
| 409 | `NOT_FOR_SALE` | Toast: "This vehicle is no longer listed for sale." + close the panel |
| 409 | `OWN_VEHICLE` | Toast: "You can't message yourself." (rare — button should be hidden already) |
| 410 | `GONE` | Toast: "This vehicle's profile is no longer available." + navigate back |
| 429 | `RATE_LIMITED` | Toast: "You've sent too many messages. Try again in {retryAfter}s." Read `Retry-After` header. |
| 5xx / network | — | Inline retry: "Couldn't send — please try again." |

---

## 3. Messages inbox — `/messages`

Component: `MessagesInboxView.vue` (new).

### Layout

```
┌─────────────────────────────────────────┐
│  Messages                                │
│                                         │
│  [ All ]  [ As buyer ]  [ As seller ]   │  ← filter tabs
│                                         │
│  ┌─────────────────────────────────┐    │
│  │ [avatar] John Smith         2h  │ ●  │  ← unread dot
│  │ 2017 Suzuki Vitara · LWF251     │    │
│  │ Hi John, is the odometer 95k…   │    │
│  └─────────────────────────────────┘    │
│  ┌─────────────────────────────────┐    │
│  │ [avatar] Priya Patel        1d  │    │
│  │ 2020 Toyota Camry · ABC123      │    │
│  │ Thanks — see you Saturday       │    │
│  └─────────────────────────────────┘    │
└─────────────────────────────────────────┘
```

### Fetch

```ts
GET /c/threads?role=<all|buyer|seller>&limit=25&before=<iso>
```

Response shape — see `ask-seller-brief.md` §Endpoints.

Cache the response and refetch:
- on mount
- on tab focus (`visibilitychange` → `document.visibilityState === 'visible'`)
- every 60s while the tab is active (interval, clear on unmount)

### Row rendering

- Vehicle avatar if present, otherwise the counterparty's initials in a coloured circle.
- Counterparty name in bold.
- Vehicle label (`year make model`) + rego underneath in muted text.
- Last message snippet (single line, ellipsis).
- Timestamp (relative: "2h", "1d", "3 May").
- Unread dot (right side) when `unreadCount > 0`. Bold row title if unread.

### Pagination

- Default page size 25.
- Infinite scroll: when the user reaches the bottom, request next page with `before = last thread's last_message_at`.

### Empty states

| Filter | Message |
|--------|---------|
| All | "No messages yet. When you ask a seller a question or someone messages you about your listing, it'll show up here." |
| As buyer | "You haven't asked any sellers questions yet." |
| As seller | "No one has messaged you about your listings yet." |

### Filter tab counts

Show unread badges next to each filter tab if unread threads exist in that role. Compute from the fetched list (backend doesn't split unread by role).

---

## 4. Thread detail — `/messages/:threadId`

Component: `MessagesThreadView.vue` (new).

### Layout

```
┌─────────────────────────────────────────┐
│  ← Back                                 │
│                                         │
│  ┌─┐  2017 Suzuki Vitara · LWF251       │
│  │ │  ↳ chatting with John Smith        │
│  └─┘  [ View public profile ]           │  ← link to /logbook/:token
│                                         │
│  ─────────────────────────────────      │
│                                         │
│  ┌─────────────────────────────┐        │
│  │ Hi John, is the odometer    │        │  ← counterparty bubble (left)
│  │ 95k genuine? Any receipts?  │        │
│  │                       9:12  │        │
│  └─────────────────────────────┘        │
│                                         │
│        ┌─────────────────────────────┐  │
│        │ Yep — I have all the        │  │  ← mine (right)
│        │ service receipts. Happy to  │  │
│        │ show them.                  │  │
│        │                       9:20  │  │
│        └─────────────────────────────┘  │
│                                         │
│  ─────────────────────────────────      │
│  [ type a reply... ]         [Send]     │
└─────────────────────────────────────────┘
```

### Fetch on mount

```ts
GET /c/threads/{id}
```

This auto-marks the thread as read (backend clears the caller's unread count as a side effect). Update local inbox state to zero the unread count for this thread and decrement the global unread badge.

Response — see `ask-seller-brief.md` §GET /c/threads/:id.

### Guard

If the response is `403`, navigate back to `/messages` with a toast: "You don't have access to this conversation."

### Message rendering

- Right-align messages where `mine === true`; left-align where `mine === false`.
- Show timestamp under each bubble (relative if within 24h, absolute if older).
- Group consecutive messages from the same sender: only show the sender name/avatar on the first bubble of a group. Break groups when the gap between messages exceeds 15 minutes.
- Auto-scroll to bottom on load and after sending.

### Vehicle no longer listed

If the thread's vehicle now has `for_sale = 0`, show a subtle banner above the messages:

> "This vehicle is no longer listed for sale. You can still read past messages."

Reply input stays enabled — replies to existing threads are allowed even after delisting (per the spec).

### Sending a reply

```ts
POST /c/threads/{id}/messages
Content-Type: application/json

{ "message": "Sounds good, I can come Saturday" }
```

Optimistic UI: push the message into the local list immediately with a "sending..." indicator. Replace with the server-returned `messageId` + `createdAt` on success. Roll back and show an inline error on failure.

Rate-limit handling identical to compose panel.

### Refresh strategy

- Refetch the thread on tab focus.
- Every 30 seconds while the tab is active, refetch (simple polling — real-time is v2).

---

## 5. Auth & data types

### Type additions (`src/api/customer.ts` or equivalent)

```ts
export interface ThreadSummary {
  id:               number
  vehicleId:        number
  vehicleRego:      string
  vehicleLabel:     string
  vehicleAvatarUrl: string | null
  logbookToken:     string
  role:             'buyer' | 'seller'
  counterparty:     { customerId: number; name: string }
  lastMessage: {
    content:          string
    createdAt:        string
    senderCustomerId: number
  }
  unreadCount: number
  createdAt:   string
}

export interface ThreadDetail extends Omit<ThreadSummary, 'lastMessage' | 'unreadCount'> {
  messages: {
    id:               number
    content:          string
    senderCustomerId: number
    mine:             boolean
    createdAt:        string
  }[]
}
```

### API helpers to add

```ts
customerApi.startThread(token: string, message: string): Promise<{ threadId, messageId, createdAt }>
customerApi.threads(params?: { role?: 'buyer'|'seller'; before?: string; limit?: number }): Promise<{ threads, hasMore, nextCursor }>
customerApi.thread(id: number): Promise<ThreadDetail>
customerApi.sendMessage(threadId: number, message: string): Promise<{ messageId, createdAt }>
customerApi.markRead(threadId: number): Promise<void>
```

---

## 6. Global unread badge

The customer sidebar already carries badge counts (see the existing chat feature pattern). For Messages:

- On app mount / after login → call `GET /c/threads` and sum `unreadCount` across all threads. Store in a Pinia store (e.g. `useMessagesStore`).
- On any inbox refetch → recompute.
- On thread open → subtract that thread's unread from the global count.
- Optional: poll `GET /c/threads?limit=100` every 60s while the app is focused.

Show the badge on the rail Messages icon when total > 0.

---

## 7. Behaviour matrix

| Situation | Behaviour |
|-----------|-----------|
| Signed-out viewer clicks "Ask a question" | Redirect to `/login?returnTo=/logbook/:token?compose=1` |
| Signed-in customer clicks their own listing's button | Button not shown (owner check) |
| Signed-in customer clicks another user's for-sale listing | Compose panel opens inline |
| Sending fails with 429 | Toast with retry countdown from `Retry-After` |
| Vehicle delisted after thread created | Thread stays readable + replyable; banner in thread view |
| Vehicle transferred | Existing thread remains between original parties; new buyers messaging after transfer start a fresh thread with the new owner |
| Two buyers messaging same seller | Two separate threads |
| Same buyer messages same seller twice on same vehicle | Existing thread reused; new message appended |

---

## 8. Out of scope for v1

- Attachments (photos, files)
- Message editing / deleting
- Blocking users
- Read receipts (last-read is tracked server-side but not surfaced)
- Real-time push / websocket updates — polling only
- Search across threads
- Group chats

---

## 9. Testing checklist

- [ ] Anonymous viewer sees the "Ask" button on for-sale listings, gets sent to login → returns and lands in the compose panel
- [ ] Signed-in customer messages a listing → thread appears in their inbox as `role: 'buyer'`
- [ ] Seller sees the same thread in their inbox as `role: 'seller'` with unread badge
- [ ] Opening the thread clears the unread badge for the viewer only
- [ ] Both parties can reply and see each other's messages after refresh
- [ ] Rate limit (send 21 messages in an hour) → 429 handled with countdown
- [ ] Delist the vehicle → both parties can still read/reply; button hidden on public profile
- [ ] Transfer the vehicle → new buyer starts a fresh thread with the new owner; old thread untouched
- [ ] Owner viewing their own listing does NOT see the button
