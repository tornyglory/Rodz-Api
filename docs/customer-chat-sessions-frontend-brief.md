# Customer AI Chat (Sessions) — Frontend Implementation Brief

Multi-session AI chat for the customer vehicle detail screen. Customers can start multiple separate conversations per vehicle — each gets an auto-generated title and persists independently. The AI assistant is named **Rod** and knows everything about the vehicle and the customer's service history before the first message.

This brief supersedes the single-conversation brief (`customer-chat-frontend-brief.md`). The legacy `/c/vehicles/:id/chat` endpoint still exists but should no longer be used for new builds.

---

## Base URL

```
https://fzzrkscwd7.execute-api.ap-southeast-2.amazonaws.com
```

All endpoints require a customer JWT:

```
Authorization: Bearer <customer_jwt>
```

---

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST`   | `/c/vehicles/:id/chats` | Create a new chat session |
| `GET`    | `/c/vehicles/:id/chats` | List all sessions for this vehicle |
| `GET`    | `/c/vehicles/:id/chats/:sessionId` | Load a session's message history |
| `POST`   | `/c/vehicles/:id/chats/:sessionId/messages` | Send a message in a session |
| `DELETE` | `/c/vehicles/:id/chats/:sessionId` | Delete a session and all its messages |
| `POST`   | `/c/vehicles/:id/chats/:sessionId/upload-url` | Get a Cloudflare direct upload URL for an image |

---

## Session management

### Create a session

`POST /c/vehicles/:id/chats`

No request body. Creates a new empty session and returns its ID.

**Response — 201**
```json
{
  "sessionId": 7
}
```

Call this when the customer taps "New Chat". Then navigate immediately to the session view using the returned `sessionId`.

**Errors**
- `403 FORBIDDEN` — vehicle doesn't belong to this customer

---

### List sessions

`GET /c/vehicles/:id/chats`

Returns all sessions for this vehicle, most recent first. Use this to build the session list screen.

**Response — 200**
```json
{
  "sessions": [
    {
      "id":            7,
      "title":         "Brake Grinding Diagnosis",
      "preview":       "That doesn't sound good! A grinding noise when braking usually means your brake pads are very worn — the metal backing is now...",
      "lastMessageAt": "2026-07-05T02:10:00.000Z",
      "createdAt":     "2026-07-05T02:09:00.000Z"
    },
    {
      "id":            1,
      "title":         null,
      "preview":       null,
      "lastMessageAt": null,
      "createdAt":     "2026-07-04T14:30:00.000Z"
    }
  ]
}
```

| Field | Notes |
|-------|-------|
| `id` | Session ID — pass as `:sessionId` in subsequent requests |
| `title` | Auto-generated 3–5 word title from the first message. `null` if no messages sent yet |
| `preview` | First 120 characters of the last AI response. `null` for empty sessions |
| `lastMessageAt` | ISO 8601 timestamp of the last message. `null` for empty sessions |
| `createdAt` | ISO 8601 timestamp of when the session was created |

Returns up to 50 sessions. Display `title` if set; fall back to "New Chat" for untitled sessions.

**Errors**
- `403 FORBIDDEN` — vehicle doesn't belong to this customer

---

### Delete a session

`DELETE /c/vehicles/:id/chats/:sessionId`

Permanently deletes the session and all its messages. Also deletes any images from Cloudflare that were uploaded in that session. This cannot be undone.

No request body required.

**Response — 200**
```json
{
  "deleted": true
}
```

**Errors**
- `403 FORBIDDEN` — vehicle doesn't belong to this customer
- `404 NOT_FOUND` — session doesn't exist or belongs to a different vehicle/customer

**UX:** Show a confirmation prompt ("Delete this chat?") before calling — deletion is immediate and permanent.

---

## Messages

### Load session history

`GET /c/vehicles/:id/chats/:sessionId`

Loads messages for a session. Paginated — returns the 50 most recent messages by default. Call on mount when navigating into a session.

**Query parameters**

| Param | Type | Description |
|-------|------|-------------|
| `before` | number | Message ID — fetch the 50 messages before this ID (for infinite scroll upward) |

**Response — 200**
```json
{
  "sessionId":       7,
  "title":           "Brake Grinding Diagnosis",
  "messages": [
    {
      "id":        101,
      "role":      "user",
      "content":   "My car is making a grinding noise when I brake",
      "imageUrl":  null,
      "createdAt": "2026-07-05T02:09:30.000Z"
    },
    {
      "id":        102,
      "role":      "model",
      "content":   "That doesn't sound good, Neville! A grinding noise when braking usually means your brake pads are very worn — the metal backing is now scraping against the rotor. This is a safety issue and should be checked as soon as possible.\n\nWould you like me to book you in at Rodz Somerville for a brake inspection?",
      "imageUrl":  null,
      "createdAt": "2026-07-05T02:09:34.000Z"
    }
  ],
  "hasMore":          false,
  "oldestMessageId":  101
}
```

| Field | Notes |
|-------|-------|
| `sessionId` | Echo of the session ID |
| `title` | Current session title. `null` for sessions with no messages yet |
| `messages` | Chronological array, oldest first |
| `messages[].role` | `"user"` = customer, `"model"` = AI |
| `messages[].content` | Message text — render as markdown. `null` for image-only messages |
| `messages[].imageUrl` | Full Cloudflare image URL if the message contained an image, else `null` |
| `messages[].createdAt` | ISO 8601 timestamp |
| `hasMore` | `true` if older messages exist — use `before` param to paginate |
| `oldestMessageId` | ID of the oldest message in this page — pass as `?before=<id>` on the next page |

**Pagination (infinite scroll upward)**

When the customer scrolls to the top and `hasMore` is `true`, fetch:
```
GET /c/vehicles/:id/chats/:sessionId?before=<oldestMessageId>
```
Prepend the returned messages to the top of the list. Update `oldestMessageId` and `hasMore` from the new response.

**Errors**
- `403 FORBIDDEN` — vehicle doesn't belong to this customer
- `404 NOT_FOUND` — session doesn't exist or belongs to a different vehicle/customer

---

### Send a message

`POST /c/vehicles/:id/chats/:sessionId/messages`

Sends the customer's message and returns the AI's full response in one shot. All tool calls (availability checks, bookings) are executed server-side before the response is returned.

**Request — text only**
```json
{
  "content": "I'm hearing a knocking noise when I accelerate. What could it be?"
}
```

**Request — image only**
```json
{
  "imageId": "cf-image-uuid-from-upload"
}
```

**Request — image with caption**
```json
{
  "content": "Here's a photo of my brake pad — is this worn out?",
  "imageId": "cf-image-uuid-from-upload"
}
```

- At least one of `content` or `imageId` is required

**Response — 200**
```json
{
  "userMessageId": 101,
  "messageId":     102,
  "content":       "That doesn't sound good, Neville! A grinding noise when braking usually means your brake pads are very worn — the metal backing is now scraping against the rotor...",
  "functionCalls": null
}
```

**Response — 200, after booking**
```json
{
  "userMessageId": 103,
  "messageId":     104,
  "content":       "Done! You're booked in on **Tuesday 15 July at 10:00 AM** with Mechanic Guy at Rodz Somerville. Your reference is **KE9AS2FB**.",
  "functionCalls": [
    { "name": "getServiceTypes",  "result": { "services": [...] } },
    { "name": "checkTimeSlots",   "result": { "slots": [...] } },
    { "name": "bookAppointment",  "result": { "bookingRef": "KE9AS2FB", "date": "2026-07-15", "time": "10:00 AM", "slot": "morning", "store": "Rodz Somerville", "technician": "Mechanic Guy", "confirmed": true } }
  ]
}
```

| Field | Notes |
|-------|-------|
| `userMessageId` | DB ID of the saved customer message |
| `messageId` | DB ID of the saved AI response |
| `content` | Full AI response — render as markdown |
| `functionCalls` | Array of tool calls made during this turn, or `null` |

**Timing:** Expect 2–6 seconds for general questions, up to 10 seconds for booking turns or vehicle value lookups. Show a typing indicator immediately on send.

**Session title:** The title is generated automatically from the first message in the session. It won't appear in the send response — re-fetch the session list to reflect the new title after the first message is sent.

**Errors**
- `403 FORBIDDEN` — vehicle doesn't belong to this customer
- `404 NOT_FOUND` — session doesn't exist
- `422 VALIDATION_ERROR` — neither `content` nor `imageId` provided

---

## Sending images

Images require a two-step upload before sending the message.

### Step 1 — Get an upload URL

`POST /c/vehicles/:id/chats/:sessionId/upload-url`

No request body required.

**Response — 200**
```json
{
  "uploadUrl": "https://upload.imagedelivery.net/...",
  "imageId":   "cf-image-uuid"
}
```

**Errors**
- `403 FORBIDDEN` — vehicle doesn't belong to this customer
- `404 NOT_FOUND` — session doesn't exist

### Step 2 — Upload to Cloudflare

`POST <uploadUrl>` with `multipart/form-data`, field name `file`.

This call goes directly to Cloudflare — not through the Rodz API. No auth header needed.

```js
const formData = new FormData()
formData.append('file', imageFile)
await fetch(uploadUrl, { method: 'POST', body: formData })
```

### Step 3 — Include in the send request

```json
{
  "content": "Here's a photo of the noise from my engine bay",
  "imageId": "cf-image-uuid"
}
```

**UX tip:** Kick off Steps 1–2 as soon as the customer picks an image, before they tap Send. The upload usually completes before they finish writing a caption.

---

## Rendering AI responses

The `content` field is markdown — render it properly. The AI uses:

- `**bold**` for part names, prices, and booking references
- Bullet lists for steps or options
- Inline code for specs (e.g. `5W-30`)

---

## Booking confirmation card

When `functionCalls` contains a `bookAppointment` entry with `confirmed: true`, render a confirmation card below the AI's text:

```
┌─────────────────────────────────────────┐
│ ✅  Booking Confirmed                    │
│                                         │
│  Ref        KE9AS2FB                    │
│  Date       Tuesday 15 July 2026        │
│  Time       10:00 AM                    │
│  Store      Rodz Somerville             │
│  Technician Mechanic Guy                │
└─────────────────────────────────────────┘
```

Pull values from the `bookAppointment` result:

| Field | Value |
|-------|-------|
| `bookingRef` | 8-character booking reference |
| `date` | `YYYY-MM-DD` — format as "Tuesday 15 July 2026" |
| `time` | Time label e.g. `"10:00 AM"` |
| `store` | Store name |
| `technician` | Assigned technician's name, or `null` |
| `confirmed` | Always `true` on success |

---

## Image URL variants

| Suffix | Use |
|--------|-----|
| `/public` | Full size — inline chat and lightbox |
| `/thumbnail` | Square crop ~150px — input bar previews |

`imageUrl` in history responses uses `/public`. Replace the suffix for thumbnails.

---

## UX recommendations

### Session list screen

Shown when the customer opens the chat feature on a vehicle. Think of it like an iMessage thread list.

- Each row shows: **title** (or "New Chat" if null), **preview** text (truncated to one line), **lastMessageAt** timestamp
- Sort by `lastMessageAt` descending (most recent at top) — the API already returns them in this order
- "New Chat" button in the top-right corner — calls `POST /c/vehicles/:id/chats` and navigates immediately to the empty session view
- Swipe-to-delete or long-press → "Delete" on each row — show a confirmation prompt, then call `DELETE /c/vehicles/:id/chats/:sessionId`. Remove the row from the list on success.
- If `sessions` is empty, show a full-screen empty state: assistant avatar, "Hi, I'm Rod", and a "Start a conversation" button that creates the first session

### Per-session chat screen

Standard chat layout. On mount, call `GET /c/vehicles/:id/chats/:sessionId` to load history.

**Header:** Display the session `title` in the navigation bar. If `title` is null (empty session), show "New Chat". After the first message is sent, refetch the session list in the background — the title will have been generated by then and you can update the header.

**Empty session state:** When `messages` is empty, show starter prompts (see below) instead of an empty message list.

**Scrolling:** New messages anchor to the bottom. When `hasMore` is `true`, show a "Load earlier messages" indicator at the top — trigger the paginated fetch when the customer scrolls to it. Prepend results without losing scroll position.

**Back navigation:** Goes to the session list. The session remains — customers can return to any conversation at any time.

### Typing indicator

Show immediately on send, before the response arrives:

```
Rod is thinking...
```

Use a pulsing dot animation. Hide once `content` arrives. Expect 2–4s for general questions, 4–8s for booking turns, up to 10s for vehicle value lookups (which run a live Google Search).

### Typewriter animation

Apply a character-by-character reveal to `content` when it first arrives. Standard AI chat feel. Markdown should render progressively as the text streams in — don't wait until the full string is revealed.

### Image preview

- Show a thumbnail in the input bar as soon as the customer picks an image
- Display the image inline in the message bubble — tappable to open full-size
- If a message has both image and text, show the image above the text

### Starter prompts

When `messages` is empty, replace the empty list with a prompt grid:

| Label | Message sent on tap |
|-------|---------------------|
| My service history | `"Show me my service history"` |
| Upcoming maintenance | `"What maintenance is coming up for my car?"` |
| What's it worth? | `"What's my car worth right now?"` |
| Book a service | `"I'd like to book a service at Rodz"` |
| Diagnose an issue | `"I have a noise / warning light — can you help diagnose it?"` |
| Inspect a photo | `"I'll send you a photo — can you tell me what you're seeing?"` |

Tapping a prompt sends it immediately — no need to tap Send.

### Error handling

If the send POST fails or returns 500:
- Show an inline error below the message: "Something went wrong — tap to retry"
- Keep the customer's message visible in the input bar so they don't retype it
- Do not add the failed attempt to the local message list (the server only saves on success)

---

## What the AI knows

Injected server-side before every message — not visible in history:

- Vehicle make, model, year, engine, oil spec, tyre sizes, transmission
- Complete Rodz service history (dates, odometer, costs, job summaries)
- Known issues for this vehicle model
- Next service due (km and/or date)
- The customer's first name (used naturally in responses, not in every message)
- Today's date (for accurate availability reasoning)

---

## Notes

**Sessions are per-vehicle:** A customer with two vehicles has separate session lists for each.

**Auto-title generation:** The title is generated by Gemini from the customer's first message. It doesn't appear in the send response — it's written to the DB during the handler. Refetch the session list after the first message to pick it up.

**One AI, many conversations:** Each session replays up to the last 40 messages to Gemini on every turn — the AI has full memory within a session but no memory across sessions. If a customer says "remember we talked about my brakes last time" in a new session, the AI won't know — this is by design.

**Assistant name:** The AI assistant is named **Rod** — set server-side, consistent for all customers. There is no field in any API response indicating the name — Rod will introduce himself naturally in the first response of a new session.

**Staff chats are separate:** The mechanic/technician diagnostic chat used inside the workshop portal is a completely separate system and is never surfaced to customers.

**Image diagnosis:** When a customer sends a photo, the AI receives the actual image data (not just a URL) and can give visual diagnosis. Works well for: dashboard warning lights, tyre wear, brake pad condition, leaks, engine bay components.

**Vehicle value:** If the customer asks what their car is worth, the AI calls an internal tool that runs a live Google Search of Australian listings (carsales, Autotrader, Gumtree). Expect 8–10s — the extended typing indicator should reassure the customer it's working.

---

## Booking flow reference

The AI handles the entire booking flow conversationally — no special frontend handling required beyond the confirmation card above.

1. AI calls `getServiceTypes` → presents real service names to the customer
2. Customer picks a date → AI calls `checkTimeSlots` → presents slots with technician names
3. Customer picks a time → AI asks about drop-off type (drop off / wait / loan car)
4. If loan car → AI calls `checkCourtesyCars` → confirms availability
5. AI shows a full summary and asks to confirm
6. Customer confirms → AI calls `bookAppointment` → booking created, staff notified
7. Response arrives with `content` + `functionCalls` containing the `bookAppointment` result
