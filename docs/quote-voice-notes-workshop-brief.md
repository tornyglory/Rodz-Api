# Voice Memos on Quotes — Workshop Portal Frontend Brief

Wire the workshop portal's `QuoteDrawer` (and `JobQuoteTab`) so a mechanic can record a 30-sec voice memo against a quote or one of its line items while they're building it. Backend is live and end-to-end verified — this brief covers the workshop UI side only.

**Full backend + customer-side brief:** `docs/quote-voice-notes-frontend-brief.md` (both surfaces). This document is a focused subset for the workshop portal integration.

**Where in the codebase:** `src/components/drawers/QuoteDrawer.vue`, `src/components/drawers/JobQuoteTab.vue`, `src/stores/quotes.ts`, `src/api/quotes.ts`.

---

## Base URL

```
https://fzzrkscwd7.execute-api.ap-southeast-2.amazonaws.com
```

All endpoints below require:
```
Authorization: Bearer <staff_jwt>
```

---

## Endpoints you'll hit

| Step | Method + Path | When |
|---|---|---|
| 1 | `GET /quotes/{id}/voice-notes/upload-url?contentType=audio/webm` | User releases the mic button |
| 2 | (PUT to the returned `uploadUrl`) | Immediately after step 1 |
| 3 | `POST /quotes/{id}/voice-notes` | After the S3 PUT returns 200 |
| 4 | `DELETE /quotes/{id}/voice-notes/{noteId}` | User taps the delete icon on a note |
| 5 | `GET /quotes/{id}/voice-notes/{noteId}/playback-url` | Existing playback URL 403s (rare) |
| 6 | `POST /quotes/{id}/voice-notes/{noteId}/retry-transcribe` | User taps "Try again" on a failed transcript |

Voice notes appear inline on the existing `GET /quotes/{id}` response — the store already fetches this, so no separate list call is needed after creation. Just re-fetch the quote after creating a note (or optimistically update the local state).

Contracts, error codes, and validation rules are in `docs/quote-voice-notes-frontend-brief.md` § "Endpoint contracts."

---

## API bindings — `src/api/quotes.ts`

Add these methods:

```ts
export interface VoiceNoteUploadUrl {
  uploadUrl:       string
  s3Key:           string
  contentType:     string
  expiresIn:       number
  maxSizeBytes:    number
  maxDurationSec:  number
}

export interface QuoteVoiceNote {
  id:                    number
  quoteId:               number
  quoteItemId:           number | null   // null = attached to the whole quote
  durationSeconds:       number
  contentType:           string
  sizeBytes:             number | null
  transcript:            string | null
  transcriptStatus:      'pending' | 'ready' | 'failed'
  recordedBy:            string | null
  createdAt:             string
  playbackUrl:           string
  playbackUrlExpiresAt:  string
}

// Add to quotesApi:

getVoiceNoteUploadUrl(quoteId: number, contentType = 'audio/webm'): Promise<VoiceNoteUploadUrl> {
  return request(`/quotes/${quoteId}/voice-notes/upload-url?contentType=${encodeURIComponent(contentType)}`)
},

createVoiceNote(quoteId: number, body: {
  s3Key:           string
  contentType:     string
  durationSeconds: number
  sizeBytes?:      number
  quoteItemId?:    number | null
}): Promise<QuoteVoiceNote> {
  return request(`/quotes/${quoteId}/voice-notes`, { method: 'POST', body: JSON.stringify(body) })
},

deleteVoiceNote(quoteId: number, noteId: number): Promise<{ ok: boolean }> {
  return request(`/quotes/${quoteId}/voice-notes/${noteId}`, { method: 'DELETE' })
},

refreshVoiceNotePlayback(quoteId: number, noteId: number): Promise<{ playbackUrl: string; expiresAt: string }> {
  return request(`/quotes/${quoteId}/voice-notes/${noteId}/playback-url`)
},

retryVoiceNoteTranscribe(quoteId: number, noteId: number): Promise<{ ok: boolean; transcriptStatus: 'pending' }> {
  return request(`/quotes/${quoteId}/voice-notes/${noteId}/retry-transcribe`, { method: 'POST' })
},
```

**Note the shape of `voiceNotes` in the existing quote response** — extend your `Quote` and `QuoteItem` types:

```ts
export interface QuoteItem {
  id:          number
  description: string
  // …existing fields…
  photos:      Photo[]
  voiceNotes:  QuoteVoiceNote[]   // NEW — always an array, [] when none
}

export interface Quote {
  id:          number
  quoteNumber: string
  // …existing fields…
  items:       QuoteItem[]
  voiceNotes:  QuoteVoiceNote[]   // NEW — for notes attached to the whole quote, not a line item
}
```

---

## UI placement

Two touchpoints in the quote editor:

### 1. Per line item

Small mic-icon button on each line item row, near the existing photo-add affordance. Same visual weight as the camera icon.

```
┌────────────────────────────────────────────────────────────┐
│ Rear brake pads and rotors                                 │
│ [Hours 1.5] [Unit $180]              📷 photos  🎤 voice   │
│                                                            │
│ ┌───────────────────────────────────────────────────┐      │
│ │ 🎤 0:32   ▶ Play                          🗑     │  ← existing note
│ │ "Rear pads down to 3mm — hearing metal on hard   │
│ │  stops. Worth doing before winter."              │
│ │  – N. Rodda                                       │
│ └───────────────────────────────────────────────────┘      │
└────────────────────────────────────────────────────────────┘
```

### 2. Quote-level (top or bottom of the quote body)

One mic button for a "note about the whole quote" — rare but useful for context that doesn't tie to a specific item ("the customer said they're planning a road trip in 3 weeks, quote reflects that").

---

## Recording gesture

Standard voice-memo pattern: **hold to record, release to send.**

- **Press** the mic button → start recording, show a red pulsing indicator + countup timer (0:00 → 0:60).
- **Release** in place → stop recording, kick off upload.
- **Drag off** and release → cancel, discard the recording, nothing uploaded.
- **Hard cap at 60 sec** — auto-stop and warn "Max 60 seconds."

Small visual touches:
- Waveform or pulsing dot while recording.
- Timer counting up in mono font.
- Subtle haptic on start/stop (`window.navigator.vibrate?.(10)` — no-op on desktop).

---

## Recording implementation — copy-pasteable

```ts
export interface Recording {
  blob:         Blob
  contentType:  string     // 'audio/webm' or 'audio/mp4' — no codec suffix
  durationSec:  number
}

export async function startRecording(): Promise<{
  recorder:  MediaRecorder
  stream:    MediaStream
  chunks:    Blob[]
  startedAt: number
}> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  })

  // Opus in webm — small + high quality. Safari 14+ fine; older Safari falls back to mp4.
  const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? 'audio/webm;codecs=opus'
    : 'audio/mp4'

  const recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 128_000 })
  const chunks: Blob[] = []
  recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data) }

  const startedAt = Date.now()
  recorder.start()
  return { recorder, stream, chunks, startedAt }
}

export async function stopRecording(session: {
  recorder: MediaRecorder; stream: MediaStream; chunks: Blob[]; startedAt: number
}): Promise<Recording> {
  return new Promise((resolve) => {
    session.recorder.onstop = () => {
      session.stream.getTracks().forEach(t => t.stop())
      // Strip ';codecs=…' — S3 presigned URL is signed against the bare MIME type
      const bare = (session.recorder.mimeType.split(';')[0] || 'audio/webm')
      const blob = new Blob(session.chunks, { type: bare })
      const durationSec = Math.max(0.1, (Date.now() - session.startedAt) / 1000)
      resolve({ blob, contentType: bare, durationSec })
    }
    session.recorder.stop()
  })
}

// Full flow: press → record → release → upload → save
export async function recordAndSave(opts: {
  quoteId:      number
  quoteItemId?: number | null
  onRecording:  (elapsedSec: number) => void
  onSaving:     () => void
}): Promise<QuoteVoiceNote> {
  const session = await startRecording()

  // Hard cap at 60s
  const capTimer = window.setTimeout(() => session.recorder.state === 'recording' && session.recorder.stop(), 60_000)

  // Wire up the caller's countup UI
  const tickTimer = window.setInterval(() => {
    opts.onRecording((Date.now() - session.startedAt) / 1000)
  }, 100)

  // The caller triggers stop when the user releases the mic button:
  //   → call session.recorder.stop() from outside
  // Here we just wait for `onstop` via stopRecording.
  const recording = await stopRecording(session)
  window.clearTimeout(capTimer)
  window.clearInterval(tickTimer)

  opts.onSaving()

  // 1. Presigned URL
  const upl = await quotesApi.getVoiceNoteUploadUrl(opts.quoteId, recording.contentType)

  // 2. Direct S3 PUT (no auth header — signature is baked in)
  const putRes = await fetch(upl.uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': recording.contentType },
    body:    recording.blob,
  })
  if (!putRes.ok) throw new Error(`S3 upload failed (${putRes.status})`)

  // 3. Record it server-side
  return quotesApi.createVoiceNote(opts.quoteId, {
    s3Key:           upl.s3Key,
    contentType:     recording.contentType,
    durationSeconds: recording.durationSec,
    sizeBytes:       recording.blob.size,
    quoteItemId:     opts.quoteItemId ?? null,
  })
}
```

**Critical detail:** the `Content-Type` header on the PUT to S3 **must exactly match** the `contentType` returned from `getVoiceNoteUploadUrl`. The presigned URL is signature-bound to that content type. Don't include the `;codecs=…` suffix — S3 doesn't see it in the signature.

---

## Rendering an existing note

```vue
<template>
  <div class="voice-note">
    <audio :src="note.playbackUrl" preload="metadata" controls @error="onPlaybackError" />

    <div v-if="note.transcriptStatus === 'ready' && note.transcript" class="voice-note__transcript">
      <blockquote>{{ note.transcript }}</blockquote>
      <cite v-if="note.recordedBy">— {{ note.recordedBy }}</cite>
    </div>

    <div v-else-if="note.transcriptStatus === 'pending'" class="voice-note__transcript voice-note__transcript--pending">
      <UiSpinner size="12" /> Transcribing…
    </div>

    <div v-else-if="note.transcriptStatus === 'failed'" class="voice-note__transcript voice-note__transcript--failed">
      Transcript failed to generate.
      <button class="voice-note__retry" @click="onRetryTranscript">Try again</button>
    </div>

    <button class="voice-note__delete" @click="onDelete">
      <IconTrash :size="16" />
    </button>
  </div>
</template>
```

### Polling for pending transcripts

When the drawer loads (or after a new note is created), if any note has `transcriptStatus === 'pending'`, poll the quote endpoint every 5 seconds — for up to 6 attempts (30 seconds total). Stop polling as soon as everything is `ready` or `failed`.

```ts
async function pollUntilTranscriptsResolve(quoteId: number, maxAttempts = 6, intervalMs = 5000) {
  for (let i = 0; i < maxAttempts; i++) {
    const quote = await quotesApi.get(quoteId)
    quotesStore.setQuote(quote)   // merge into the store — reactive UI updates
    const hasPending = [
      ...quote.voiceNotes,
      ...quote.items.flatMap(it => it.voiceNotes),
    ].some(n => n.transcriptStatus === 'pending')
    if (!hasPending) return
    await new Promise(r => setTimeout(r, intervalMs))
  }
}
```

Kick this off in the background from `QuoteDrawer.vue`'s mount (or after any `createVoiceNote` returns). Don't block the UI on it.

### Playback URL expiry

Every voice-note object carries `playbackUrlExpiresAt`. It's a short-lived S3 signature — 15 minutes. If the user leaves the drawer open past that and hits play, the `<audio>` element will emit an `error` event.

**Handler:**
```ts
async function onPlaybackError(quoteId: number, note: QuoteVoiceNote) {
  const { playbackUrl, expiresAt } = await quotesApi.refreshVoiceNotePlayback(quoteId, note.id)
  note.playbackUrl = playbackUrl
  note.playbackUrlExpiresAt = expiresAt
  // Re-trigger play — audio element needs a fresh load()
  ($refs.audioEl as HTMLAudioElement).load()
  ($refs.audioEl as HTMLAudioElement).play()
}
```

Alternatively, if the drawer is open long-form, refetch the quote every 10 min to keep all playback URLs warm. Either pattern works.

---

## Store integration — `src/stores/quotes.ts`

Extend the existing quote actions:

```ts
async function addVoiceNote(quoteId: number, quoteItemId: number | null, recording: Recording) {
  const note = await recordAndSave({ quoteId, quoteItemId, onRecording: () => {}, onSaving: () => {} })
  // Merge into local state
  const q = state.quotes.find(x => x.id === quoteId)
  if (!q) return
  if (quoteItemId == null) {
    q.voiceNotes = [...(q.voiceNotes ?? []), note]
  } else {
    const item = q.items.find(it => it.id === quoteItemId)
    if (item) item.voiceNotes = [...(item.voiceNotes ?? []), note]
  }
  // Kick off polling — transcript will land in a few seconds
  pollUntilTranscriptsResolve(quoteId)
}

async function removeVoiceNote(quoteId: number, noteId: number) {
  await quotesApi.deleteVoiceNote(quoteId, noteId)
  const q = state.quotes.find(x => x.id === quoteId)
  if (!q) return
  q.voiceNotes = (q.voiceNotes ?? []).filter(n => n.id !== noteId)
  for (const item of q.items) {
    item.voiceNotes = (item.voiceNotes ?? []).filter(n => n.id !== noteId)
  }
}
```

---

## Empty states / error handling

| State | UI |
|---|---|
| Draft quote, no notes | Just the mic button. No card underneath. |
| Recording in progress | Red pulse + countup + drag-off-to-cancel affordance. |
| Uploading | Small "Saving…" pill in the note card. Disable the mic button. |
| Note created, transcript pending | Full audio player + "Transcribing…" placeholder underneath. |
| Note created, transcript ready | Full audio player + transcript block + recordedBy attribution. |
| Note created, transcript failed | Audio player + "Transcript failed — Try again" button. |
| Quote is `paid` or `invoiced` | Hide the mic button. Existing notes still render (view-only). |
| Permission denied (mic) | Toast "Microphone access required to record voice notes." |
| Quote is `paid` and staff tries to record anyway | Backend returns 409 `QUOTE_LOCKED` — show toast and refresh the quote. |

---

## Feature flag

Gate the whole voice-note UI behind `customer.chat` isn't quite right. Add a new flag:

Add `workshop.quoteVoiceNotes` to the feature-flags backend brief's initial registry, defaulting to `true`. Then in the workshop portal, gate the mic button behind `useFeatureFlags().flags['workshop.quoteVoiceNotes']` (with `?? true` fallback for the fail-open policy documented in the feature-flags brief).

If you want to ship without the flag first, that's fine — hard-code it as always-on for the initial rollout and add the flag later.

---

## Testing checklist

- [ ] Open a draft or sent quote in the drawer.
- [ ] Press-and-hold the mic button on a line item, record ~10 sec, release. Note appears under the item with a working play button.
- [ ] Refresh the drawer after ~10 sec — `transcriptStatus` flips from `pending` to `ready`, transcript text shows.
- [ ] Delete the note via the trash icon. Row disappears from the UI; refetching the quote confirms it's gone.
- [ ] Record a quote-level note (not tied to a line item). Appears under the quote's summary section.
- [ ] Try to record on a `paid` quote → mic button hidden. If somehow reached (e.g. state changed underneath), the backend returns 409 → toast + refetch.
- [ ] Drag off the mic button and release → nothing uploads, no request fires.
- [ ] Cap the recording at 60s — auto-stop, show a small "max 60s" hint.
- [ ] Deny microphone permission the first time → toast surfaces the required-permission message.
- [ ] Force a transcript failure (leave the tab open, record silent audio) → status shows `failed` → tap "Try again" → status flips back to `pending` → resolves.
- [ ] Leave the drawer open for 16 min then tap play on a note → `<audio>` errors → playback URL refreshes → plays fine.

---

## What we're deliberately NOT building here

- **Editing / trimming** existing recordings. If it's wrong, delete and re-record.
- **Voice notes on invoices.** Voice belongs on the conversational side (quotes). Invoices are settled.
- **Customer-side voice memos in chat.** That's a Sprint 3 conversation, separate spec.
- **Live transcription.** Batch after upload; live is 10× the complexity.

---

## Ship checkpoint

Mechanic opens a quote drawer, presses the mic button on a line item, records 20 sec explaining a wear issue, releases. The note appears under the item with a working play button. Within 10 sec the transcript populates. They tap play → the audio plays. They tap the trash icon → the note disappears.

That's the whole workshop-side story. The customer approval-page UX is documented in `docs/quote-voice-notes-frontend-brief.md` § "Approval page — playback UX."
