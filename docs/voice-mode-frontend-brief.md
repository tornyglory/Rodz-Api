# Voice Mode — Frontend Implementation Brief

Real-time bidirectional voice with the AI assistant. The customer taps a **Voice Mode** button on the chat screen, talks, and hears the response spoken back with natural cadence and interrupt support.

**Tier**: Gold only. Silver customers can see the button but tapping it opens the existing `UpgradeModal`. Free customers don't see it at all.

**As of 2026-07-14**: backend is live and enabled in production.

---

## Architecture — the audio never touches Rodz

The browser talks **directly** to Gemini Live over a WebSocket. The Rodz backend only mints short-lived, session-scoped **ephemeral tokens** that lock the session config (system prompt, tools, voice, model) so a compromised client can't tamper with grounding.

```
   ┌─ Browser ──────────┐        ┌─ Rodz backend ─┐
   │ · Mic capture      │  REST  │ · Tier gate    │
   │ · Playback         │◀──────▶│ · Grounding    │
   │ · Tool router      │ token  │ · Tool exec    │
   │ · Transcript       │        │ · Usage/quota  │
   └──────┬─────────────┘        └────────────────┘
          │
          │ WSS (direct, ephemeral)
          ▼
   ┌────────────────────┐
   │ Gemini Live        │
   │ (Google)           │
   └────────────────────┘
```

Audio bytes stream browser ↔ Google directly. Only the token + tool calls + transcript + usage go through Rodz.

---

## Base URL

```
https://fzzrkscwd7.execute-api.ap-southeast-2.amazonaws.com
```

All 4 endpoints require the customer JWT:

```
Authorization: Bearer <customer_jwt>
```

---

## Endpoint summary

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/c/vehicles/:id/voice/token`      | Mint an ephemeral Gemini token + get the WS URL + audio config |
| `POST` | `/c/vehicles/:id/voice/tool`       | Execute a tool call Gemini emitted (dispatched to Rodz DB) |
| `POST` | `/c/vehicles/:id/voice/transcript` | Post user + assistant turns after each round so they land in chat history |
| `POST` | `/c/vehicles/:id/voice/usage`      | Report session duration on hangup — feeds the daily quota |

All four short-circuit with `503 { error: "DISABLED" }` if `VOICE_MODE_ENABLED=false` on the server (kill-switch).

---

## The full flow — one voice session, start to finish

```
1. User taps "Voice Mode"          → check tier locally, open UpgradeModal for non-Gold
2. Frontend                        → POST /voice/token  { sessionId? }
                                       ← { token, wsUrl, sessionId, audioConfig, expiresAt }
3. Frontend                        → open WSS to wsUrl?access_token={token}
4. Send BidiGenerateContent setup   (see WebSocket protocol below)
5. Loop:
     · Stream 16 kHz PCM16LE audio chunks from mic
     · Receive 24 kHz PCM16LE audio + partial text transcripts back
     · If Gemini emits a toolCall:
         → POST /voice/tool { sessionId, toolCallId, name, args }
             ← { toolCallId, result }
         → send result back to Gemini as toolResponse
     · After each completed turn:
         → POST /voice/transcript { sessionId, turns: [user, assistant] }
6. User hangs up (or WS closes):
     · POST /voice/usage { sessionId, seconds, endedReason }
     · Close WS if still open
```

Steps 2 and 6 are the only mandatory Rodz REST calls per session. Steps 5c (tool) and 5d (transcript) fire only when relevant.

---

## Endpoint 1 — Mint token

### `POST /c/vehicles/:id/voice/token`

**Request body**
```json
{
  "sessionId": 123   // optional — attach voice turns to an existing chat session
}
```

If `sessionId` is omitted, a fresh `customer_chat_sessions` row is created and its id is returned. Either way, voice turns will land in the same session history as text messages — one session can mix both.

**Response — 200**
```json
{
  "token":       "auth_tokens/4d5368b7eeaa55971b9e58819867e300...",
  "expiresAt":   "2026-07-14T13:15:00.000Z",
  "sessionId":   123,
  "wsUrl":       "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained",
  "audioConfig": {
    "inputSampleRate":  16000,
    "outputSampleRate": 24000,
    "encoding":         "pcm16le"
  }
}
```

Open the WebSocket with `token` as the `access_token` query param:

```
${wsUrl}?access_token=${token}
```

The token is **single-use** — once the WS opens, it's consumed. Get a fresh one for each session.

**Errors**

| Status | Body `error` | When |
|--------|--------------|------|
| 401 | `UNAUTHORIZED`      | Missing / invalid JWT |
| 403 | `FORBIDDEN_TIER`    | Customer isn't Gold |
| 403 | `FORBIDDEN_VEHICLE` | Customer doesn't own this vehicle |
| 404 | `NOT_FOUND`         | `sessionId` provided but doesn't exist or isn't theirs |
| 429 | `RATE_LIMITED`      | Daily voice quota exhausted (30 min/day default). Body includes `retryAfter` (ISO date next allowed) + `usedToday` + `dailyLimit` |
| 503 | `DISABLED`          | Master kill-switch off |
| 503 | `UPSTREAM`          | Google refused to mint the token |

---

## Endpoint 2 — Tool call passthrough

### `POST /c/vehicles/:id/voice/tool`

When Gemini emits a `toolCall` over the WebSocket, forward it here. The backend runs it against the real DB (booking flow, availability, service list, courtesy cars, vehicle value) and returns the result which you then send back to Gemini as `toolResponse`.

**Request body**
```json
{
  "sessionId":  123,
  "toolCallId": "<the id Gemini gave you — echo it back to Gemini in the response>",
  "name":       "checkAvailability",
  "args":       { "storeId": 1, "month": "2026-08" }
}
```

**Response — 200**
```json
{
  "toolCallId": "<same id>",
  "result":     { ...tool-specific payload... }
}
```

**Allowed tool names** (voice has a smaller set than text chat — memory / history / fuel-history tools are text-only):

| Name | Purpose |
|------|---------|
| `getServiceTypes`    | List services offered (call before naming any service) |
| `checkAvailability`  | Available slots across a whole month |
| `checkTimeSlots`     | Slots for a specific date |
| `checkCourtesyCars`  | Loan-car availability for a specific date |
| `getVehicleValue`    | Live market-value estimate |
| `bookAppointment`    | Confirm + book a slot (only after user confirmation) |

**Errors**

| Status | Body `error` | When |
|--------|--------------|------|
| 400 | `UNKNOWN_TOOL`       | `name` isn't in the allowlist above |
| 403 | `FORBIDDEN_SESSION`  | `sessionId` doesn't belong to this customer/vehicle |
| 422 | validation           | Missing `sessionId` / `toolCallId` / `name` |

The tool-call handshake with Gemini itself (how you receive the `toolCall` and how you send the `toolResponse` back over the WS) is documented in [Google's Live API tool-use docs](https://ai.google.dev/gemini-api/docs/live-tools).

---

## Endpoint 3 — Transcript upload (best-effort)

### `POST /c/vehicles/:id/voice/transcript`

After each completed turn, post the user + assistant transcripts so they land in the chat history alongside text messages. **Fire-and-forget** from the UI's perspective — you don't need to await it.

**Request body**
```json
{
  "sessionId": 123,
  "turns": [
    { "role": "user",      "text": "how much for a service",       "ts": "2026-07-14T13:04:22Z" },
    { "role": "assistant", "text": "A logbook service is $299.",   "ts": "2026-07-14T13:04:25Z" }
  ]
}
```

`role`: `"user"` or `"assistant"` (the backend maps `assistant` → `model` internally). `ts` is optional and unused by the backend — safe to include for future dedup.

**Response — 200**
```json
{ "ok": true, "written": 2 }
```

Each turn lands in the same S3 chat-history blob that text chat uses, stamped `mode: 'voice'`. That means:

- `GET /c/vehicles/:id/chats/:sessionId` returns voice + text messages in one array, in chronological order.
- Frontend can distinguish them via a new `mode` field on each message (`'text'` or `'voice'`). Missing = text (legacy).
- Session list (`GET /c/vehicles/:id/chats`) already surfaces sessions that contain voice messages — no separate list.

**Errors**: 403 if not Gold or not owner; 422 if `sessionId` or `turns[]` missing.

---

## Endpoint 4 — Usage report on hangup

### `POST /c/vehicles/:id/voice/usage`

Report how many seconds of active audio the session used. Feeds the daily 30-min/customer quota.

**Request body**
```json
{
  "sessionId":   123,
  "seconds":     412,
  "endedReason": "user_hangup"
}
```

`endedReason` must be one of: `user_hangup` | `timeout` | `error` | `interrupted`.

**Response — 200**
```json
{ "ok": true }
```

Best-effort — if the browser crashes without reporting, we lose accounting for that session. Google's own billing is the ultimate source of truth.

---

## WebSocket protocol (Gemini Live)

Reference: <https://ai.google.dev/gemini-api/docs/live>. Short version of what you need:

### Opening

Always use the exact `wsUrl` returned by `/voice/token` — don't hardcode. Currently:

```
wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained?access_token={token}
```

Note the `Constrained` suffix — ephemeral tokens only work against `BidiGenerateContentConstrained` on `v1alpha`. The plain `BidiGenerateContent` on `v1beta` closes with 1008 immediately.

The backend has **already locked** the model, system prompt, voice, response modality (audio), and function declarations into the token. **Do not** send a `setup` message overriding those — the token will reject it. Only send `clientContent` (audio + text) after the WS opens.

### Sending audio

Stream 16 kHz mono PCM16LE audio from `getUserMedia({ audio: true })` in ~100-500 ms chunks. Frame each chunk as:

```json
{
  "clientContent": {
    "turns": [{
      "role": "user",
      "parts": [{ "inlineData": { "mimeType": "audio/pcm;rate=16000", "data": "<base64>" } }]
    }],
    "turnComplete": false
  }
}
```

Set `turnComplete: true` on the final chunk when the user pauses / stops talking. Voice-activity detection is Google-side by default — the model figures out when a turn ends. You can also use server-side VAD.

### Receiving audio

Response frames arrive as:
```json
{
  "serverContent": {
    "modelTurn": {
      "parts": [{ "inlineData": { "mimeType": "audio/pcm;rate=24000", "data": "<base64>" } }]
    },
    "turnComplete": false
  }
}
```

Buffer + play at 24 kHz. When `turnComplete: true`, the assistant is done speaking.

Text transcripts also arrive on the same channel via `parts: [{ "text": "..." }]` — accumulate those into the current turn's transcript for uploading to Endpoint 3.

### Receiving tool calls

```json
{
  "toolCall": {
    "functionCalls": [{
      "id":   "abc123",
      "name": "checkAvailability",
      "args": { "storeId": 1, "month": "2026-08" }
    }]
  }
}
```

For each entry: POST it to `/voice/tool`, get `{ result }`, then respond:

```json
{
  "toolResponse": {
    "functionResponses": [{
      "id":       "abc123",
      "name":     "checkAvailability",
      "response": { ...the result from Rodz... }
    }]
  }
}
```

### Interruption

If the user starts talking while the assistant is speaking, Google's server-side VAD will emit:
```json
{ "serverContent": { "interrupted": true } }
```
Stop playback immediately and drop the buffered audio. The assistant will restart based on the new user input.

### Session end

The WS closes cleanly when:
- The token expires (default 15 min per session)
- The user hangs up (close the WS from the client)
- An error frame arrives with `close = true`

Always POST to `/voice/usage` in the close handler.

---

## Audio pipeline notes

**Input** (mic → WS):
- Sample rate: 16000 Hz mono
- Encoding: 16-bit little-endian PCM
- Recommended chunk size: 100–500 ms (base64-encoded)
- Use `AudioContext({ sampleRate: 16000 })` + `ScriptProcessorNode` or `AudioWorklet` to downsample from the default 48 kHz mic input

**Output** (WS → speaker):
- Sample rate: 24000 Hz mono
- Encoding: 16-bit little-endian PCM
- Buffer 2-3 chunks before playback to smooth jitter — voice quality is very sensitive to underruns
- Use a separate `AudioContext({ sampleRate: 24000 })` for playback (Chrome can't mix input + output rates on one context)

**Silences and echo**:
- Enable `echoCancellation: true` and `noiseSuppression: true` on `getUserMedia`
- Pause mic input while the assistant is speaking (or ship with echo cancellation strong enough to not need this)

---

## UX guidance

### Entry point

- Voice Mode button lives on the vehicle-detail chat screen, next to the chat input
- Gold: enabled + a subtle "New" or 🎙️ affordance
- Silver: visible but tapping opens `UpgradeModal` — do NOT call `/voice/token` (it'll 403)
- Free: hide entirely — voice isn't in their upgrade path (they upgrade to Silver first)

Check tier from the customer profile in local state; don't make a round-trip just to gate the button.

### The voice session UI

- Full-screen modal with a mic waveform / pulsing orb visualisation
- Show the live transcript as it comes in (both roles)
- Big "Hang up" button — the primary exit
- Small "Switch to text" fallback that closes voice + drops the user in the same chat session with text input (their voice turns are already there via `/voice/transcript`)
- Show remaining daily quota inline (`{{ remainingMinutes }} min left today`) — fetch on entry, decrement locally, refetch on quota-exhausted errors

### Voice messages in chat history

- When rendering the session history (`GET /c/vehicles/:id/chats/:sessionId`), messages with `mode: 'voice'` get a small speaker icon (🎙️) inline
- Otherwise they render identically to text — same content field, same markdown
- No separate "voice history" screen — one unified thread

### Rate-limit UX

- On 429 `RATE_LIMITED`: show "You've reached your daily voice limit. Try again after {{ retryAfter }}." — no upgrade path, this is a per-tier daily cap, not a tier issue
- On 503 `UPSTREAM`: show "Voice mode is temporarily unavailable — try again in a moment." and log the error for backend
- On WS disconnect mid-session: attempt to reconnect once with a fresh token if the user hasn't hung up; if that fails, drop back to text

### Voice-mode style Gemini follows

The system prompt already tells Rod to:

- Keep responses to 2–3 sentences unless the user asks for detail
- Speak numbers naturally ("two-fifty" not "$250")
- Spell registration plates character by character
- Stop and listen when interrupted
- Redirect politely if asked about fuel/expense history, memory, or past chat sessions — those tools are text-only

Frontend doesn't need to reinforce any of that — Google's model handles it based on the locked system prompt.

---

## What NOT to do in voice mode

- No image upload (voice sessions don't accept `imageId`)
- No specialist-agent routing (expense/fuel/logbook agents are text-only)
- No memory (`remember` / `forget`) or history recall tools
- Don't call `/voice/token` for Silver customers — it'll 403 and burn a Google mint attempt
- Don't send `setup` on the WebSocket — the token has the config baked in and will reject overrides
- Don't skip `/voice/usage` — quota accounting depends on it (even a failing session should report seconds so the daily counter is accurate)

---

## Smoke test checklist

- [ ] Silver customer taps Voice Mode → `UpgradeModal` opens (no `/voice/token` call)
- [ ] Gold customer taps Voice Mode → `/voice/token` returns 200 with token + wsUrl
- [ ] WebSocket opens with `?access_token=<token>` and receives a first frame within 1s
- [ ] Send 3s of PCM saying "what tyres does this car use" → hear a sensible spoken response
- [ ] Say "book me in for a service on Thursday morning" → observe toolCall for `checkAvailability`, POST to `/voice/tool`, forward result back to Gemini, then `bookAppointment` flow, then audio confirming the booking
- [ ] After each turn, `/voice/transcript` POST returns `{ ok: true, written: N }`
- [ ] Hang up → `/voice/usage` POST returns `{ ok: true }`
- [ ] Chat history (`GET /c/vehicles/:id/chats/:sessionId`) now includes the voice turns with `mode: 'voice'` and a speaker icon in the UI
- [ ] Exceed 30 min in one day → next `/voice/token` returns 429 with `retryAfter` set to next midnight UTC

---

## Backend-side status (2026-07-14)

All 4 endpoints live and enabled in production. Verified end-to-end:

- Google mints real ephemeral tokens
- Tier gate rejects Free / Silver
- Ownership gate rejects non-owners
- Transcript endpoint appends `mode: 'voice'` messages to the shared S3 session blob correctly

Model: `gemini-2.5-flash-native-audio-preview-09-2025` · Voice: `Aoede` · Session TTL: 15 min · Daily cap: 30 min/customer.

Google-side spend cap is set at $100 while we test — reach out to backend if you hit unexpected billing errors.
