# Chat TTS — Frontend Implementation Brief

Replaces the Gemini Live voice pipeline with a lighter, chained architecture: **browser Web Speech API for STT → existing text chat endpoint → Amazon Polly for TTS**. Faster time-to-first-response, better Australian voice, ~4× cheaper.

**Tier**: Gold only. Silver customers still see the mic button but get the `UpgradeModal` on tap. Free customers don't see it.

**Backend status (2026-07-15)**: `POST /c/chat/tts` live and enabled in production. Gemini Live endpoints still up but on the way out — frontend should stop calling them.

---

## Architecture

```
   ┌─ Browser ──────────┐        ┌─ Rodz backend ─┐        ┌─ AWS ─────┐
   │ Web Speech STT     │───────▶│ POST /chats/   │───────▶│  Gemini   │
   │ (browser-native)   │  text  │ {sid}/messages │        │           │
   │                    │◀───────│ ← text reply   │◀───────│           │
   │                    │        │                │        │           │
   │ HTMLAudioElement   │───────▶│ POST /chat/tts │───────▶│  Polly    │
   │ MP3 playback       │  text  │                │        │  Nicole   │
   │                    │◀───────│ ← MP3 bytes    │◀───────│  standard │
   └────────────────────┘        └────────────────┘        └───────────┘
```

Two round trips per voice turn:
1. **STT → text chat**: browser transcribes speech, sends the text to `POST /c/vehicles/:id/chats/:sessionId/messages` (unchanged endpoint), receives the assistant's text reply.
2. **Text → speech**: browser sends the reply text to `POST /c/chat/tts`, receives an MP3, plays it.

The text chat endpoint is completely untouched — same grounding, same tools, same session history. TTS is a separate concern layered on top.

---

## Base URL

```
https://fzzrkscwd7.execute-api.ap-southeast-2.amazonaws.com
```

Bearer JWT required:

```
Authorization: Bearer <customer_jwt>
```

---

## The new endpoint — `POST /c/chat/tts`

Not vehicle-scoped. It's just text-to-speech.

### Request body

```json
{
  "text":       "Hey Neville, your logbook service is due next month. Want me to book it in?",
  "voice":      "Nicole",   // optional; default "Nicole" (standard, 0.3c per reply)
  "sessionId":  123         // optional; if provided, usage row links to the session
}
```

| Field | Type | Notes |
|-------|------|-------|
| `text` | string, 1–3000 chars | Plain text OR SSML wrapped in `<speak>…</speak>` (see below). Required. |
| `voice` | `"Nicole"` \| `"Olivia"` | Optional. Nicole (standard) is default and cheap. Olivia (neural) is more natural but ~4× the cost. |
| `sessionId` | number | Optional. Purely for usage-log correlation. Omit if TTSing something not tied to a chat session (e.g. a proactive greeting read aloud). |

### Response — 200

Binary MP3, base64-encoded by API Gateway. Handled transparently by `fetch()` — you get raw MP3 bytes back:

```
HTTP/1.1 200 OK
Content-Type: audio/mpeg
Content-Length: 25820
Cache-Control: no-store

<binary MP3 data — starts with the ID3v2 header 0x49 44 33 04>
```

24 kHz mono MP3, ~64 kbps.

### Consuming the audio — three options

**Simplest — blob URL on an `<audio>` tag:**

```ts
const res  = await fetch(`${API}/c/chat/tts`, {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${jwt}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ text, sessionId }),
})
if (!res.ok) throw new Error(`TTS ${res.status}: ${await res.text()}`)
const blob = await res.blob()
const url  = URL.createObjectURL(blob)
audioEl.src = url
await audioEl.play()
audioEl.addEventListener('ended', () => URL.revokeObjectURL(url), { once: true })
```

Simple, works everywhere. Downside: has to buffer the whole MP3 before playback starts (~200–500 ms extra latency for a 4-sec reply).

**Streamed via MediaSource (lower TTFB):**

Feed the fetch stream into a `SourceBuffer` for near-instant playback start. More code, but noticeably snappier. Only worth it if the UX feels sluggish with the blob approach.

**Web Audio API:**

Decode with `audioContext.decodeAudioData()` and connect to `AudioBufferSourceNode`. Use this if you want to visualise the waveform during playback (drives an existing analyser).

### Errors

| Status | Body `error` | When |
|--------|--------------|------|
| 401 | `UNAUTHORIZED`   | Missing / invalid JWT |
| 403 | `FORBIDDEN_TIER` | Customer isn't Gold |
| 400 | `INVALID_TEXT`   | Missing text OR > 3000 chars (body includes actual length) |
| 429 | `RATE_LIMITED`   | Daily quota exhausted. Body includes `retryAfter` (ISO), `usedToday`, `dailyLimit` |
| 503 | `DISABLED`       | Kill-switch off (backend feature flag) |
| 503 | `UPSTREAM`       | Polly failed |

Standard JSON error bodies with `Content-Type: application/json` on the error path — only the 200 response is binary MP3.

---

## STT — browser Web Speech API

Native to Chrome, Safari, and Chromium-based browsers. No dependencies, no backend calls, ~0 latency.

```ts
const Recognition = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition
if (!Recognition) throw new Error('SpeechRecognition not supported in this browser')

const rec = new Recognition()
rec.lang            = 'en-AU'          // Australian English
rec.continuous      = false            // stop after one utterance
rec.interimResults  = true             // stream partial transcripts
rec.maxAlternatives = 1

rec.onresult = (event: SpeechRecognitionEvent) => {
  let transcript = ''
  for (const r of event.results) transcript += r[0].transcript
  const isFinal = event.results[event.results.length - 1].isFinal
  if (isFinal) sendToChat(transcript)
  else showLiveCaption(transcript)
}
rec.onend = () => { /* release mic UI */ }
rec.onerror = (e: any) => { /* fall back to text input */ }

rec.start()
```

Firefox does NOT support Web Speech API. Detect + degrade gracefully — hide the mic button, show a tooltip, keep the text input.

Safari on iOS requires the mic permission to be triggered by a user gesture (button tap). Don't call `rec.start()` on mount.

---

## The full voice-turn flow

```
1. User taps 🎙️ (mic button)              → tier gate: Gold pass / Silver → UpgradeModal / Free hidden
2. Browser requests mic + starts Recognition
3. As user speaks:
     · Show live caption from interim results
     · Show morphing pill / waveform visualisation
4. User pauses → Recognition emits final result
5. Frontend POSTs the transcript to /c/vehicles/{id}/chats/{sid}/messages
                                     ← { content: "text reply from Rodz", ... }
6. Render assistant bubble with the text (as it arrives if streamed)
7. In parallel: POST /c/chat/tts { text: reply, sessionId } → get MP3 → play it
8. When audio ends → back to step 1 (or auto-restart Recognition for continuous mode)
```

Steps 5 and 7 can run in parallel to shave ~200 ms — kick off the TTS call the moment step 5 resolves, don't wait for the audio bubble to render.

---

## Voice choice — when to use Olivia

Default to **Nicole** for every reply. It's ~0.3c per 800-char reply and the customer can still understand it clearly.

Consider bumping to **Olivia** (neural, ~1.3c per reply) for:
- The onboarding welcome message (higher production value on first impression)
- A "premium voice" user toggle if you want to expose the choice
- Specific moments you want to feel warmer — e.g. successful booking confirmation

Both come out of the same 30-min/day quota, so switching doesn't require any new plumbing.

---

## Handling `<speak>` SSML

For rego plates, phone numbers, prices, or acronyms you want spelled out or emphasised, wrap in SSML:

```ts
const text = `<speak>Your rego <say-as interpret-as="characters">LWF251</say-as> expires next month. That's <say-as interpret-as="cardinal">299</say-as> dollars for the service.</speak>`
```

The backend detects the leading `<speak` and switches Polly to SSML mode. Plain text works exactly the same — just don't include stray angle brackets.

Common SSML tags Polly supports (all optional):
- `<say-as interpret-as="characters">HUT665</say-as>` — H-U-T-six-six-five
- `<say-as interpret-as="cardinal">299</say-as>` — two hundred and ninety-nine
- `<break time="500ms"/>` — pause
- `<prosody rate="slow" pitch="+5%">…</prosody>` — speed / pitch

Frontend can construct SSML on the fly when it recognises a rego/price pattern in the reply, or skip SSML entirely — plain text is fine for 99% of replies.

---

## Tier gating UX

- **Gold**: mic button enabled, no gate.
- **Silver**: mic button visible, tapping opens the existing `UpgradeModal`. Do NOT call `/chat/tts` — it'll 403 (open question: owner is deciding whether to extend voice to Silver now that Polly is cheap).
- **Free**: mic button hidden.

Tier available in local state from the customer profile — don't round-trip just to gate the button.

---

## Daily quota

30 minutes of speech per Gold customer per day (env-configurable server-side). Both STT-driven replies and any other TTS calls (e.g. reading the greeting aloud) count against the same daily budget.

On 429 `RATE_LIMITED`, show: `"You've reached your daily voice limit. Try again after {{ retryAfter }}."` The response body gives you `retryAfter` (ISO — usually next midnight UTC), `usedToday` (seconds), and `dailyLimit` (seconds).

Optional: fetch the remaining quota on entry and show a `{{ mins }} min left today` badge. There's no dedicated GET endpoint yet — for now, the frontend can track locally (increment on each successful TTS call) and refetch on quota errors. If you want a proper endpoint I can build one.

---

## What to delete (Gemini Live cleanup)

Remove the entire Gemini Live pipeline from the frontend:

- WebSocket setup / handshake code
- AudioContext(16000) mic capture + downsampling
- AudioContext(24000) playback pipeline
- AudioWorklet or ScriptProcessorNode for PCM chunking
- toolCall routing to `/voice/tool`
- `/voice/token`, `/voice/transcript`, `/voice/usage` calls
- The `[voice] recv setupComplete` diagnostic logs

Backend will delete the four `/voice/*` endpoints once the frontend swap-over is stable (~2 weeks of clean operation). The `customer_voice_usage` table stays — it's now reused by `/chat/tts`.

---

## Smoke test checklist

- [ ] Free customer: mic button hidden
- [ ] Silver customer: tapping mic opens `UpgradeModal`, no `/chat/tts` call fires
- [ ] Gold customer: tapping mic starts SpeechRecognition, live caption appears
- [ ] Silence for ~1s → SpeechRecognition emits final result
- [ ] Transcript POSTs to `/c/vehicles/{id}/chats/{sid}/messages` → assistant text bubble renders
- [ ] In parallel `/chat/tts` returns MP3 → audio plays cleanly at 24 kHz
- [ ] Reply with a rego plate (SSML injected by frontend) → each letter spoken individually
- [ ] Reply > 3000 chars → 400 `INVALID_TEXT` handled (fall back to no audio, keep the text bubble)
- [ ] Firefox / unsupported browser → mic button hidden, tooltip explains
- [ ] Exceed 30 min in one day → next `/chat/tts` returns 429, UI shows quota message

---

## Backend-side notes for context

- Voice: default `Nicole` standard ($4/1M chars ≈ 0.3c per 800-char reply); `Olivia` neural available via `voice: "Olivia"` (4× cost, more natural)
- Output: 24 kHz mono MP3, ~64 kbps
- Per-call limit: 3000 chars (Polly's neural synchronous limit; enforced for standard too for consistency)
- Session grounding, tools, memory, greetings — all handled by the unchanged text chat endpoint. Nothing about the AI pipeline changes with this swap.
