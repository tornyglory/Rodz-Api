# AI Vehicle Assistant — Frontend Brief

The new customer-facing AI portal. When a customer scans the QR sticker on their car, or logs into the app, this is what they see first: a Gemini-style chat interface that knows everything about their vehicle and can book appointments at Rodz.

---

## Architecture at a glance

```
Customer portal layout (per vehicle):
┌──────────────────────────────────────┐
│  [Chat] [Logbook] [Value] [Bookings] │  ← tabs
├──────────────────────────────────────┤
│                                      │
│   Hi, I'm your vehicle assistant     │
│   2026 Toyota Corolla                │
│                                      │
│   [Ask a follow-up...]               │
└──────────────────────────────────────┘
```

- **Chat is the default tab** — it greets the customer by vehicle name
- The AI knows the full service history, vehicle specs, and upcoming maintenance
- The AI can check availability and book appointments inline — no screen change needed
- Logbook, Value, and Bookings are tabs on the same screen

---

## Base URL

All endpoints use the same API Gateway URL:

```
https://fzzrkscwd7.execute-api.ap-southeast-2.amazonaws.com
```

All endpoints require `Authorization: Bearer <customer_jwt>` except auth endpoints.

---

## 1. AI Chat

The chat is the core of the product. The AI responds in ~2–4 seconds. Show a "Rodz is thinking…" indicator while waiting, then do a typewriter animation on the response text — this gives the feel of streaming.

### Sending a message

```
POST /c/vehicles/{id}/chat
Authorization: Bearer <customer_jwt>
Content-Type: application/json
```

**Body**
```json
{
  "content": "What oil does my car need?",
  "imageId": "abc123"
}
```

- `content` — the customer's message (text). Optional if `imageId` is provided.
- `imageId` — Cloudflare image ID for image messages (optional).

**Response — 200**
```json
{
  "userMessageId": 12,
  "messageId":     13,
  "content":       "Your Toyota Corolla takes 0W-16 full synthetic oil (4.2L with filter).",
  "functionCalls": null
}
```

| Field | Description |
|-------|-------------|
| `userMessageId` | DB id of the saved user message |
| `messageId` | DB id of the saved AI response |
| `content` | The AI's full response (markdown) |
| `functionCalls` | Array of tool calls the AI made, or `null` — see below |

**When the AI books or checks availability**, `functionCalls` is an array:

```json
{
  "userMessageId": 14,
  "messageId":     15,
  "content":       "I've checked Somerville for July — there are spots on Thu 10th and Fri 11th. Morning or afternoon?",
  "functionCalls": [
    {
      "name":   "checkAvailability",
      "result": { "storeName": "Somerville", "storeId": 1, "month": "2026-07", "days": { ... } }
    }
  ]
}
```

When the AI creates a booking, `functionCalls` will include a `bookAppointment` entry with a `bookingRef` — use this to render a booking confirmation card (see section 5).

**What the AI can do:**

| Function | What it does |
|----------|-------------|
| `checkAvailability` | Looks up real hoist capacity for any store and month |
| `getServiceTypes` | Gets the list of services to present options to the customer |
| `bookAppointment` | Creates a real booking in the system — always confirms with the customer first |

---

### Frontend implementation

```typescript
async function sendChatMessage(vehicleId: number, content: string, token: string, imageId?: string) {
  // Show "thinking" indicator immediately
  showThinkingIndicator()

  const res = await fetch(
    `https://fzzrkscwd7.execute-api.ap-southeast-2.amazonaws.com/c/vehicles/${vehicleId}/chat`,
    {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ content, imageId }),
    }
  )

  hideThinkingIndicator()

  if (!res.ok) throw new Error(`Chat error: ${res.status}`)

  const data = await res.json()
  // data.content — the AI's full response
  // data.messageId — DB id of AI message
  // data.functionCalls — array of tool calls, or null

  // Typewriter animation
  typewriterEffect(data.content)

  // Check if a booking was confirmed
  const booking = data.functionCalls?.find((f: any) => f.name === 'bookAppointment' && f.result?.confirmed)
  if (booking) {
    showBookingConfirmationCard(booking.result)
  }

  return data
}
```

**Tips:**
- After the response arrives, the full conversation is already saved in the DB — no need to refetch history
- If the response includes `functionCalls` with `bookAppointment`, render a booking card (section 5) below the AI message
- On error, fall back to `GET /c/vehicles/:id/chat` to reload history

---

### Loading chat history

```
GET /c/vehicles/:id/chat
Authorization: Bearer <token>
```

Returns the full conversation for this vehicle. Call this on mount to prepopulate the chat.

**Response — 200**
```json
{
  "messages": [
    {
      "id": 1,
      "role": "user",
      "content": "What oil does my car need?",
      "imageUrl": null,
      "createdAt": "2026-07-02T10:00:00.000Z"
    },
    {
      "id": 2,
      "role": "model",
      "content": "Your Toyota Corolla takes 0W-20 full synthetic...",
      "imageUrl": null,
      "createdAt": "2026-07-02T10:00:02.000Z"
    }
  ]
}
```

- `role` — `"user"` or `"model"` (the AI)
- `imageUrl` — full-size Cloudflare URL if the message had an image, otherwise `null`
- History is limited to the last 100 messages per vehicle

**Empty state:** If `messages` is `[]`, show the welcome screen with conversation starters:
- "Service history & past work"
- "Upcoming maintenance & intervals"
- "Vehicle specs & AI profile"
- "Market value & comparable sales"
- "Book an appointment at Rodz"
- "Vehicle diagnosis — describe what you're experiencing"

---

## 2. Vehicle value estimate

```
GET /c/vehicles/:id/value
Authorization: Bearer <token>
```

AI-generated market value estimate for the Australian used car market. Takes ~5 seconds. Show a loading skeleton.

**Response — 200**
```json
{
  "vehicle": {
    "year": 2021,
    "make": "Toyota",
    "model": "Camry",
    "series": "ASV70R",
    "odometerKm": 42300,
    "serviceCount": 3
  },
  "valuation": {
    "estimatedValueAud": {
      "low":  28000,
      "mid":  32000,
      "high": 35000
    },
    "condition": "good",
    "conditionRationale": "Well-maintained with 3 documented Rodz services.",
    "keyFactors": [
      {
        "factor": "Service record",
        "impact": "positive",
        "detail": "Documented history adds buyer confidence and supports asking price."
      },
      {
        "factor": "Odometer",
        "impact": "neutral",
        "detail": "42,300 km is below average for a 5-year-old vehicle."
      }
    ],
    "marketInsight": "The Toyota Camry hybrid holds its value well in Australia due to strong fuel economy and reliability reputation...",
    "sellTips": [
      "Get a full detail before listing",
      "Highlight the Rodz service record",
      "Price at mid-range and negotiate down"
    ],
    "disclaimer": "This is an estimate only. Actual sale price will vary based on vehicle condition, location, negotiation, and market timing."
  },
  "generatedAt": "2026-07-03"
}
```

**`condition` values:** `"excellent"` | `"good"` | `"fair"` | `"poor"`

**`impact` values:** `"positive"` | `"negative"` | `"neutral"`

**Suggested UI layout:**

```
┌─────────────────────────────────┐
│  Estimated Market Value         │
│  $28,000 – $35,000              │  ← range bar
│  Mid-point: $32,000             │
├─────────────────────────────────┤
│  Condition: Good ●              │
│  "Well-maintained with 3 docs…" │
├─────────────────────────────────┤
│  Key Factors                    │
│  ✅ Service record              │
│  ⚪ Odometer                    │
├─────────────────────────────────┤
│  Market insight                 │
│  "Toyota Camry holds its…"      │
├─────────────────────────────────┤
│  Tips to maximise your sale     │
│  • Get a full detail            │
│  • Highlight service record     │
├─────────────────────────────────┤
│  ⚠️  Estimate only disclaimer   │
└─────────────────────────────────┘
```

---

## 3. Booking system

Bookings can happen two ways: (a) the AI books inline in chat, or (b) the customer uses the dedicated booking flow. Both create the same `bookings` record.

### Step 1 — Get stores

```
GET /c/stores
Authorization: Bearer <token>
```

**Response — 200**
```json
{
  "stores": [
    {
      "id":      1,
      "name":    "Somerville",
      "address": "7/50 Guelph Street, Somerville, VIC 3912",
      "suburb":  "Somerville",
      "state":   "VIC",
      "postcode":"3912",
      "phone":   "021334554",
      "mapsUrl": null
    }
  ]
}
```

### Step 2 — Check availability

```
GET /c/availability?storeId=1&month=2026-07
Authorization: Bearer <token>
```

**Response — 200**
```json
{
  "storeId":   1,
  "storeName": "Somerville",
  "month":     "2026-07",
  "days": {
    "2026-07-01": { "open": false, "morning": 0, "afternoon": 0 },
    "2026-07-03": { "open": true,  "morning": 3, "afternoon": 4 },
    "2026-07-04": { "open": true,  "morning": 4, "afternoon": 4 },
    "2026-07-05": { "open": true,  "morning": 4, "afternoon": 0 }
  }
}
```

- `open: false` — closed day or past date, don't show as selectable
- `morning` / `afternoon` — **remaining capacity** (0 = fully booked, ≥1 = available)
- Fetch one month at a time; request `month=2026-08` when the customer swipes to August

### Step 3 — Get service types

```
GET /c/service-types
Authorization: Bearer <token>
```

**Response — 200**
```json
{
  "services": [
    {
      "id":             1,
      "name":           "Small Service (oil + filter + safety check)",
      "category":       "service",
      "description":    null,
      "fixedPrice":     null,
      "estimatedHours": 1.2
    },
    {
      "id":             14,
      "name":           "Brake Pad Replace (per axle)",
      "category":       "brakes",
      "description":    null,
      "fixedPrice":     null,
      "estimatedHours": 1.5
    }
  ]
}
```

**`category` values:** `service` | `tyres` | `brakes` | `suspension` | `electrical` | `air_con` | `exhaust` | `inspection` | `repairs` | `other`

Group by category in the UI. `fixedPrice` is `null` for quote-required jobs.

### Step 4 — Create booking

```
POST /c/bookings
Authorization: Bearer <token>
Content-Type: application/json
```

**Body**
```json
{
  "vehicleId":      7,
  "storeId":        1,
  "date":           "2026-07-10",
  "slot":           "morning",
  "type":           "drop_off",
  "serviceTypeIds": [1, 14],
  "notes":          "Squeaking sound when braking"
}
```

| Field | Required | Notes |
|-------|----------|-------|
| `vehicleId` | Yes | Must belong to the customer |
| `storeId` | Yes | From `GET /c/stores` |
| `date` | Yes | `YYYY-MM-DD`, must be future |
| `slot` | Yes | `"morning"` or `"afternoon"` |
| `type` | Yes | `"drop_off"` \| `"wait"` \| `"pickup"` |
| `serviceTypeIds` | Yes | Array of IDs from `GET /c/service-types`, at least 1 |
| `notes` | No | Customer notes, max 1000 chars |

**Response — 201**
```json
{
  "booking": {
    "id":         39,
    "bookingRef": "WN9ABBTC",
    "date":       "2026-07-10",
    "slot":       "morning",
    "type":       "drop_off",
    "status":     "pending",
    "store":      { "name": "Somerville", "suburb": "Somerville" },
    "services":   "Small Service (oil + filter + safety check), Brake Pad Replace (per axle)"
  }
}
```

After a successful booking, show the `bookingRef` prominently. The workshop staff will see it in the Rodz app.

**Errors**
| Code | HTTP | Meaning |
|------|------|---------|
| `VALIDATION_ERROR` | 422 | Missing field, bad date format, date in past |
| `NOT_FOUND` | 404 | Store or vehicle doesn't exist |

### Viewing bookings

```
GET /c/bookings
Authorization: Bearer <token>
```

Returns all active bookings (most recent first, cancelled bookings excluded).

**Response — 200**
```json
{
  "bookings": [
    {
      "id":         39,
      "bookingRef": "WN9ABBTC",
      "date":       "2026-07-10",
      "slot":       "morning",
      "type":       "drop_off",
      "status":     "pending",
      "notes":      "Squeaking sound when braking",
      "store": {
        "name":   "Somerville",
        "suburb": "Somerville",
        "phone":  "021334554"
      },
      "vehicle": {
        "id":    4,
        "make":  "Toyota",
        "model": "Corolla",
        "year":  2026,
        "rego":  "HUT665"
      },
      "services": "Small Service (oil + filter + safety check)"
    }
  ]
}
```

**`status` values:**

| Status | Meaning |
|--------|---------|
| `pending` | Awaiting workshop confirmation |
| `confirmed` | Workshop has confirmed the booking |
| `in_progress` | Vehicle is in the workshop |
| `completed` | Work done |
| `rejected` | Workshop couldn't take this booking — contact to rebook |

---

## 4. Conversation starters / quick actions

These are preset prompts shown on the empty chat screen. When tapped, send the text directly as a user message:

| Label | Message to send |
|-------|----------------|
| Service history & past work | `"Show me the service history for my vehicle"` |
| Upcoming maintenance & intervals | `"What maintenance is coming up for my vehicle and when?"` |
| Vehicle specs & AI profile | `"Tell me everything about my vehicle's specs"` |
| Market value & comparable sales | `"What's my vehicle worth in the current Australian market?"` |
| Book an appointment at Rodz | `"I'd like to book a service at Rodz"` |
| Vehicle diagnosis | `"I'm hearing a noise / seeing a warning light — can you help me work out what it is?"` |

---

## 5. Booking confirmation card (in-chat)

When the AI creates a booking via function calling, display it as a card inside the chat (not just text):

```
┌──────────────────────────────┐
│  ✅ Booking Confirmed        │
│                              │
│  Ref: WN9ABBTC              │
│  Somerville — Thu 10 July    │
│  Morning drop-off            │
│  Small Service               │
│                              │
│  [View all bookings →]       │
└──────────────────────────────┘
```

Parse the `done` event's AI message text to detect booking references (8-char uppercase alphanumeric), or watch for `function_result` where `name === "bookAppointment"` — the result will include a `bookingRef` field.

---

## 6. Image upload in chat

Customers can attach a photo to a chat message (e.g., a warning light, oil leak, tyre damage). Use the same 3-step Cloudflare upload flow, then pass the `imageId` in the chat message.

**Step 1 — Get upload URL**

There's no dedicated vehicle chat image upload endpoint yet — use the vehicle avatar upload URL as a temporary slot, or upload directly to Cloudflare using the customer's existing upload URL endpoints. In practice, for chat images, you can reuse `GET /c/vehicles/:id/avatar-upload-url` to get a fresh upload URL and imageId per image.

**Step 2 — Upload to Cloudflare**
```
PUT <uploadUrl>
Content-Type: multipart/form-data
field name: file
```

**Step 3 — Send in chat**
```json
{
  "content": "What is this warning light?",
  "imageId": "abc123"
}
```

The AI will receive the image and respond to it in context.

---

## Known issues / gotchas

**Chat takes ~2–4s:** The chat endpoint calls Gemini synchronously and typically responds in 2–4 seconds. Show a "Rodz is thinking…" indicator and use a typewriter animation when the response arrives.

**Value endpoint takes ~5s:** The vehicle value endpoint also calls Gemini and typically takes 3–7 seconds. Show a skeleton loading state.

**No conversation sessions:** There's one conversation per vehicle per customer. All messages for a vehicle are in a single thread. Sessions (multiple separate chat histories) can be added in a future phase.

**Mechanic chat is private:** The workshop staff have their own separate chat system for each vehicle. That chat history is never visible to customers, and customer chat is never visible to staff.

---

## Quick reference — all new endpoints

All on `https://fzzrkscwd7.execute-api.ap-southeast-2.amazonaws.com`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/c/vehicles/:id/chat` | Bearer | Send chat message, get AI response (~2–4s) |
| `GET` | `/c/vehicles/:id/chat` | Bearer | Load chat history |
| `GET` | `/c/vehicles/:id/value` | Bearer | AI vehicle value estimate (~5s) |
| `GET` | `/c/stores` | Bearer | List Rodz locations |
| `GET` | `/c/service-types` | Bearer | List bookable services |
| `GET` | `/c/availability?storeId&month` | Bearer | Available slots per month |
| `POST` | `/c/bookings` | Bearer | Create a booking |
| `GET` | `/c/bookings` | Bearer | List customer's bookings |
