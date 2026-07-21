# Voice Memos — PATCH & Send responses now include them

Small addendum to `docs/quote-voice-notes-workshop-brief.md` and `docs/quote-voice-notes-frontend-brief.md`. Backend is deployed.

## What changed

The following endpoints now return the same `voiceNotes[]` shape that `GET /quotes/{id}` already returns:

| Method + Path | Was | Is |
|---|---|---|
| `PATCH /quotes/{id}` (save) | Quote body, no `voiceNotes` | Quote body **with** `voiceNotes` on the quote and each item |
| `POST /quotes/{id}/send` | Quote body, no `voiceNotes` | Quote body **with** `voiceNotes` on the quote and each item |
| `GET /quotes/{id}` (unchanged) | With `voiceNotes` | With `voiceNotes` |
| `GET /quotes/public/{token}` (unchanged) | With `voiceNotes` | With `voiceNotes` |

Same shape, same order (`ORDER BY created_at ASC`), same `playbackUrl` freshness (15 min). Every `Quote` and `QuoteItem` returned by these four endpoints is now guaranteed to carry `voiceNotes: QuoteVoiceNote[]` — `[]` when there are none.

`POST /quotes` (create) does not include `voiceNotes` — no notes can exist at creation time (they're POSTed against the quote id after it exists). Treat missing `voiceNotes` on create-response as `[]`.

## Why this matters

Reported flow: user records a memo, then saves or sends the quote. The save/send response was replacing the local quote state and stripping `voiceNotes` off, so the memo vanished from the UI (and from what the customer would see) until a manual refetch.

With this change, the save/send response is a drop-in replacement — merging it into the store keeps memos visible with no follow-up `GET`.

## What the frontend needs to do

**Nothing new to call.** Just make sure the reducer/store that handles the response of `PATCH /quotes/{id}` and `POST /quotes/{id}/send` does **not** discard `voiceNotes`.

### If your store replaces the quote wholesale
Nothing to change — the new shape is authoritative and complete.

```ts
async function saveQuote(id: number, patch: QuotePatch) {
  const { quote } = await quotesApi.update(id, patch)
  quotesStore.setQuote(quote)   // just works — voiceNotes are on quote + items
}

async function sendQuote(id: number) {
  const { quote } = await quotesApi.send(id)
  quotesStore.setQuote(quote)
}
```

### If your store merges field-by-field
Add `voiceNotes` to the list of fields to copy at the quote level, and to the per-item merge:

```ts
function mergeQuote(local: Quote, incoming: Quote): Quote {
  return {
    ...local,
    ...incoming,
    voiceNotes: incoming.voiceNotes ?? local.voiceNotes ?? [],
    items: incoming.items.map(inc => {
      const cur = local.items.find(it => it.id === inc.id)
      return {
        ...(cur ?? {}),
        ...inc,
        voiceNotes: inc.voiceNotes ?? cur?.voiceNotes ?? [],
      }
    }),
  }
}
```

### If you had a "refetch after save" workaround
You can rip it out. The save/send response is now sufficient.

```ts
// BEFORE
await quotesApi.update(id, patch)
const fresh = await quotesApi.get(id)   // ← remove this
quotesStore.setQuote(fresh)

// AFTER
const { quote } = await quotesApi.update(id, patch)
quotesStore.setQuote(quote)
```

## TypeScript types

Already defined in `docs/quote-voice-notes-workshop-brief.md` § "API bindings" — no changes:

```ts
interface Quote {
  // …
  items:      QuoteItem[]
  voiceNotes: QuoteVoiceNote[]   // always present on GET / PATCH / send response
}

interface QuoteItem {
  // …
  voiceNotes: QuoteVoiceNote[]
}
```

## Transcript status after save/send

The `voiceNotes[]` returned by PATCH/send reflects the current DB state at that moment. If a memo was uploaded 2 seconds before save, its `transcriptStatus` may still be `pending` in the response — same as `GET`. Existing polling behaviour (`pollUntilTranscriptsResolve` in the workshop brief) doesn't need to change; if you're merging the save/send response into the store, the poller will pick up the `pending` note on its next tick.

## Testing checklist

- [ ] Record a memo on an item. Save the quote (PATCH). Memo stays visible in the UI without a manual refresh.
- [ ] Record a memo. Send the quote. Memo stays visible in the sender's UI; open the customer approval link (`/q/{token}`) and confirm the memo is there for the customer too.
- [ ] Save a quote with no memos. `quote.voiceNotes` is `[]`; every `item.voiceNotes` is `[]`. No `undefined`.
- [ ] Save a quote with a memo whose transcript is still `pending`. The save response shows `transcriptStatus: 'pending'`; the poller flips it to `ready` within ~10 sec.
- [ ] If you had a follow-up `GET /quotes/{id}` after PATCH — remove it, verify nothing regresses.
