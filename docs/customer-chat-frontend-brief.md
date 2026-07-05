# Customer AI Chat — Frontend Implementation Brief

Everything needed to build the customer-facing AI chat on the vehicle detail screen. The AI can answer questions about the vehicle, diagnose issues from photos, and book workshop appointments end-to-end.

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
| `GET`  | `/c/vehicles/:id/chat` | Load conversation history |
| `POST` | `/c/vehicles/:id/chat` | Send a message (text and/or image) |
| `GET`  | `/c/vehicles/:id/chat/upload-url` | Get a Cloudflare direct upload URL for an image |

---

## Loading conversation history

### `GET /c/vehicles/:id/chat`

Call on mount to pre-populate the chat with the existing conversation. The history is persistent — one continuous conversation per vehicle per customer (no sessions).

**Response — 200**
```json
{
  "messages": [
    {
      "id":        1,
      "role":      "user",
      "content":   "What oil does my car need?",
      "imageUrl":  null,
      "createdAt": "2026-07-02T10:00:00.000Z"
    },
    {
      "id":        2,
      "role":      "model",
      "content":   "Your 2021 Toyota Camry takes **5W-30 full synthetic** oil (4.5L with filter). Use a quality brand like Penrite or Castrol.",
      "imageUrl":  null,
      "createdAt": "2026-07-02T10:00:02.000Z"
    },
    {
      "id":        5,
      "role":      "user",
      "content":   null,
      "imageUrl":  "https://imagedelivery.net/_T7yYgco6vMbVyuhQfz9eg/abc123/public",
      "createdAt": "2026-07-02T10:05:00.000Z"
    }
  ]
}
```

| Field | Notes |
|-------|-------|
| `role` | `"user"` = customer, `"model"` = AI |
| `content` | Message text — render as markdown. `null` for image-only messages |
| `imageUrl` | Full-size Cloudflare URL if the message contained an image, else `null` |
| `createdAt` | ISO 8601 timestamp |

Returns up to the last 100 messages.

**Empty state:** `messages: []` — no conversation yet. Show starter prompts (see UX section below).

---

## Sending a message

### `POST /c/vehicles/:id/chat`

Sends the customer's message (text, image, or both) and returns the AI's response. The AI executes any tool calls (availability checks, bookings) server-side before responding — the full response arrives in one shot.

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

- `content` — the customer's text message (optional if `imageId` is provided)
- `imageId` — Cloudflare image ID obtained from the upload flow below (optional)
- At least one of `content` or `imageId` is required

**Response — 200, text reply**
```json
{
  "userMessageId": 42,
  "messageId":     43,
  "content":       "That knocking on acceleration in a Vitara often points to worn CV joints or engine mounts. I'd recommend bringing it in — we can diagnose it quickly.",
  "functionCalls": null
}
```

**Response — 200, after tool use (booking flow)**
```json
{
  "userMessageId": 44,
  "messageId":     45,
  "content":       "Done! You're booked in on **Tuesday 15 July at 10:00 AM** with Mechanic Guy at Rodz Somerville. Your reference is **KE9AS2FB**.",
  "functionCalls": [
    { "name": "getServiceTypes",   "result": { "services": [...] } },
    { "name": "checkTimeSlots",    "result": { "slots": [...] } },
    { "name": "bookAppointment",   "result": { "bookingRef": "KE9AS2FB", "date": "2026-07-15", "time": "10:00 AM", "slot": "morning", "store": "Rodz Somerville", "technician": "Mechanic Guy", "confirmed": true } }
  ]
}
```

| Field | Notes |
|-------|-------|
| `userMessageId` | DB id of the saved customer message |
| `messageId` | DB id of the saved AI response |
| `content` | Full AI response — render as markdown |
| `functionCalls` | Array of tool calls made during this turn, or `null` |

**Timing:** Expect 2–8 seconds. Show a typing indicator immediately on send. Booking turns (which involve multiple tool calls) take longer — up to 8s.

**Errors**
- `403 FORBIDDEN` — vehicle doesn't belong to this customer
- `422 VALIDATION_ERROR` — neither `content` nor `imageId` provided

---

## Sending images

Images require a two-step upload before the chat POST.

### Step 1 — Get a direct upload URL

`GET /c/vehicles/:id/chat/upload-url`

**Response — 200**
```json
{
  "uploadUrl": "https://upload.imagedelivery.net/...",
  "imageId":   "cf-image-uuid"
}
```

### Step 2 — Upload to Cloudflare

`PUT <uploadUrl>` with `multipart/form-data`, field name `file`, containing the image binary.

This call goes directly to Cloudflare — not through the Rodz API.

```js
const formData = new FormData()
formData.append('file', imageFile)
await fetch(uploadUrl, { method: 'PUT', body: formData })
```

### Step 3 — Send the chat message

Include the `imageId` from Step 1 in the `POST /c/vehicles/:id/chat` body.

```json
{
  "content": "Here's a photo of the noise from my engine bay",
  "imageId": "cf-image-uuid"
}
```

**UX tip:** Start the upload (Steps 1–2) as soon as the customer selects the image, before they tap Send. By the time they add a caption and hit send, the upload is likely already done.

---

## Rendering the AI response

The `content` field is markdown — render it properly. The AI uses:

- `**bold**` for emphasis (part names, prices, references)
- Bullet lists for steps or options
- Appointment time slots as a list so they can be styled as selectable items (see Booking Flow below)

---

## Booking confirmation card

When `functionCalls` contains a `bookAppointment` entry with `confirmed: true`, show a confirmation card below the AI's text response (in addition to the markdown content):

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

Pull these values from the `bookAppointment` result object:

| Field | Value |
|-------|-------|
| `bookingRef` | Booking reference (always 8 chars) |
| `date` | `YYYY-MM-DD` — format as "Tuesday 15 July 2026" |
| `time` | Time label e.g. `"10:00 AM"` |
| `store` | Store name |
| `technician` | Assigned technician's name, or `null` if not yet assigned |
| `confirmed` | Always `true` when the booking succeeded |

---

## Booking flow — what the AI does

The AI handles the full booking flow conversationally. There's nothing special the frontend needs to do beyond rendering markdown and the confirmation card. For context on what's happening behind the scenes:

1. AI calls `getServiceTypes` → presents actual service options to the customer by name
2. Customer picks a date → AI calls `checkTimeSlots` for that specific date → presents available slots (8:00 AM, 10:00 AM, 1:00 PM, 3:00 PM) with technician names
3. Customer picks a time → AI asks about drop-off type (drop off / wait / loan car)
4. If loan car requested → AI calls `checkCourtesyCars` → tells customer what's available
5. AI shows a summary and asks to confirm
6. Customer confirms → AI calls `bookAppointment` → booking created
7. Response arrives with `content` + `functionCalls` including the `bookAppointment` result

The customer never needs to leave the chat to complete a booking.

---

## UX recommendations

### Layout

- Full-screen chat view, scoped to a single vehicle
- Sticky input bar at the bottom with a text field and an attach-image button (paperclip or camera icon)
- Messages scroll upward; new messages anchor to the bottom
- AI messages left-aligned, customer messages right-aligned (standard chat layout)

### Typing indicator

Show immediately on send — before the response arrives:

```
● Rodz is thinking...
```

Use a pulsing animation. Hide it once `content` arrives. Expect 2–4s for simple questions, 4–8s for booking turns.

### Typewriter animation

Apply a character-by-character reveal to `content` when it arrives. This gives a natural AI chat feel without needing streaming.

### Image preview

When the customer selects an image:
- Show a thumbnail in the input bar before sending
- Display the image inline in the chat message bubble (tappable to view full size)
- If the message has both image and text, show the image above the text

### Starter prompts

When `messages` is empty, replace the empty chat with a grid of prompt buttons:

| Label | Message sent on tap |
|-------|---------------------|
| 📋 My service history | `"Show me my service history"` |
| 🔧 Upcoming maintenance | `"What maintenance is coming up for my car?"` |
| 💰 What's it worth? | `"What's my car worth right now?"` |
| 📅 Book a service | `"I'd like to book a service at Rodz"` |
| 🔍 Diagnose an issue | `"I'm hearing a noise / have a warning light — can you help diagnose it?"` |
| 📸 Inspect a photo | `"I'll send you a photo — can you tell me what you're seeing?"` |

Tapping a prompt populates the input and immediately sends it (no need to tap send again).

### Error handling

If the POST fails or returns 500:
- Show an inline error below the message: "Something went wrong — tap to retry"
- Keep the customer's message visible so they don't have to retype it
- Do not add the failed message to the persistent history (it won't be — the server saves both messages only on success)

---

## Image URL variants

Cloudflare serves each image at two sizes:

| Suffix | Use |
|--------|-----|
| `/public` | Full size — use for inline chat display and lightbox |
| `/thumbnail` | Square crop, ~150px — use for thumbnails in the input bar or compact views |

`imageUrl` in the history response already uses `/public`. If you need a thumbnail, replace the suffix.

---

## What the AI knows

The AI has full context about the vehicle and customer before every message — this is injected server-side and is not visible in the chat history:

- Vehicle make, model, year, engine, oil type, tyre sizes, transmission
- Complete Rodz service history (dates, odometer, costs, job summaries)
- Known issues specific to this vehicle model
- Upcoming service intervals and due dates
- Today's date (for accurate availability reasoning)

---

## Notes

**One conversation per vehicle:** The history is a single continuous thread — there are no sessions or threads. The AI has memory of the full conversation (last 40 turns replayed to Gemini on each request).

**Staff chats are separate:** The mechanic/technician diagnostic chat (used inside the workshop portal) is completely separate and is never surfaced to customers.

**Image diagnosis:** When a customer sends a photo (engine bay, tyre wear, dashboard warning light, brake pad, etc.) the AI receives the actual image data and can give specific, visual diagnosis. Encourage customers to use this for anything they're unsure about.

**Vehicle value in chat:** If the customer asks what their car is worth in the chat, the AI will call an internal tool that performs a live Google Search of Australian car listings (carsales, Autotrader, Gumtree) and returns a real estimate. This takes ~8–10s — the extended typing indicator should reassure the customer it's working. There is also a dedicated `GET /c/vehicles/:id/value` endpoint if you want to build a standalone value tab.
