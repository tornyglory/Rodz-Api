# "Friend in the car" — v1 spec

**North star:** the car becomes a friend. Knows itself. Looks after itself. Looks after you.

**This v1:** the three most-load-bearing shifts that move Rodz from *"AI that answers vehicle questions"* to *"companion during your time with the car."*

Two sprints of work, split across backend + frontend. Independently valuable — each piece can ship alone.

---

## The three pieces

| # | Piece | What it unlocks |
|---|---|---|
| 1 | **`findThingsToDo` tool** | Location-aware, web-grounded suggestions. The moment where the customer asked "what should I do with Noah right now" and got a real answer. |
| 2 | **Passenger memory** | She remembers Noah exists between conversations. Next time in the car with him, she asks how he is. |
| 3 | **Proactive check-ins** | She initiates the conversation. Push notification with an opener like *"Hey Nev, how's she running since Monday's service?"* — tap and you're mid-chat. |

Sprint 1 = piece 1. Sprint 2 = pieces 2 + 3.

---

## Piece 1 — `findThingsToDo` tool

### Behaviour

Customer says something like:
- *"What should I do with Noah for the next hour?"*
- *"Somewhere to grab coffee?"*
- *"We've got 30 min before pickup — anything nearby?"*

Brain calls `findThingsToDo`, backend hits Gemini + Google Search grounding at the customer's current location, returns 3–5 real places with distance / time / why it fits. Brain phrases the reply in-character.

### Frontend responsibilities

**Location permission primer** — new UX flow, one-time per install per customer, similar to the push primer:

- Trigger: first time the customer asks anything "nearby" flavoured (or explicitly in Settings → Location).
- Copy: *"Rodz can suggest places nearby when you're out and about — parks with Noah, food, coffee, wherever. Your location is used only when you ask, never stored, and shared only with the AI answering your question."*
- Options: **Allow** / **Not now**.
- On **Allow**: capture using `Capacitor.Plugins.Geolocation.getCurrentPosition({ enableHighAccuracy: false, timeout: 10_000, maximumAge: 300_000 })` and persist a `locationEnabled: true` flag in `customerAuth` store. Don't background-track.

**On every chat message send** where location is enabled:

```ts
// If we haven't captured a location in the last 5 min, grab a fresh one
const pos = await Geolocation.getCurrentPosition({ maximumAge: 5 * 60 * 1000, timeout: 5_000 })
```

Attach to the request body:
```ts
{
  content: message,
  imageId: ...,
  location: {
    lat: pos.coords.latitude,
    lng: pos.coords.longitude,
    accuracy: pos.coords.accuracy,      // metres
    capturedAt: new Date().toISOString(),
  }
}
```

If permission denied or capture fails: silently omit the field. Backend handles absence gracefully.

**Storage / retention rules for the frontend:**
- Never persist lat/lng to localStorage.
- Only capture on message-send (not in the background).
- Show a small "📍 Location on" indicator in the chat input area when active — customer can tap to disable per-session.

### Backend contract

**Request body extension:**

```
POST /c/vehicles/{id}/chats/{sessionId}/messages
{
  content:  "what should I do with Noah?",
  imageId:  null,
  location: {                          // NEW, optional
    lat:        -38.2226,
    lng:        145.1783,
    accuracy:   30,
    capturedAt: "2026-07-17T02:38:21Z"
  }
}
```

Backend accepts the field, validates loosely (lat -90..90, lng -180..180, accuracy < 5000m), passes into the chat context.

**New tool declaration** in `src/customer/vehicles/chats/session-send.ts` alongside the existing tools:

```ts
{
  name: 'findThingsToDo',
  description: `Search real places and activities near the customer's current location using web search. Use when the customer asks about anything nearby — food, coffee, parks, kid-friendly activities, walks, shops, attractions. Always call this rather than answering from general knowledge. Include the full context the customer gave you (who's with them, time constraints, mood, distance preferences) — the search grounds better with specifics. If location isn't available, the tool returns { available: false } and you should let the customer know they can enable location in Settings.`,
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      context: {
        type: SchemaType.STRING,
        description: 'Natural-language description of what the customer needs. Include passenger info, time constraints, preferences. Example: "1 hour to kill with Noah (7yo son who loves parks), somewhere within 15 min drive"'
      },
      radiusKm: {
        type: SchemaType.NUMBER,
        description: 'Approximate search radius in km. Defaults to 15. Use larger only if the customer explicitly asks for it.'
      }
    },
    required: ['context'],
  }
}
```

**Handler branch:**

```ts
} else if (name === 'findThingsToDo') {
  if (!location) {
    fnResult = { available: false, reason: 'Location not shared' }
  } else {
    fnResult = await findThingsToDoImpl({
      lat:     location.lat,
      lng:     location.lng,
      context: String(args.context ?? ''),
      radius:  Math.min(Math.max(Number(args.radiusKm) || 15, 1), 50),
      vehicleContext,  // pass a summary of the car — "2026 Toyota Corolla, EV: no"
    })
  }
}
```

**`findThingsToDoImpl`** — new helper in `src/shared/thingsToDo.ts`:

```ts
export async function findThingsToDoImpl(opts: {
  lat: number
  lng: number
  context: string
  radius: number
  vehicleContext: string
}): Promise<object> {
  const cacheKey = `things:${sha1(`${opts.lat.toFixed(2)}:${opts.lng.toFixed(2)}:${opts.context}`)}`
  const cached = await safeGet(cacheKey)
  if (cached) return cached

  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!)
  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    // @ts-ignore
    tools: [{ googleSearch: {} }],
    generationConfig: { maxOutputTokens: 1200, thinkingConfig: { thinkingBudget: 0 } } as any,
  })

  const prompt = `Find real places and activities near lat=${opts.lat}, lng=${opts.lng} in Australia.
Radius: ~${opts.radius}km. Search the web for verified current options.

Customer context: "${opts.context}"

Return 3–5 REAL PLACES ONLY (verified via web search). No general suggestions like "any park" — specific named places with real details.

Respond as JSON only (no markdown):
{
  "places": [
    {
      "name": "...",
      "type": "park|cafe|attraction|shop|activity|other",
      "description": "One sentence about what it is",
      "distanceKm": <number>,
      "driveMinutes": <number>,
      "openHours": "e.g. 'Open now, until 6pm' or 'Closed Mondays'",
      "whyItFits": "One sentence linking it to the customer's context",
      "notes": "e.g. 'Big playground with shade', 'Great flat white', 'Kids under 10 free' — nice-to-know practical details"
    }
  ],
  "summary": "One-sentence summary of what you found for the customer."
}
`
  const result = await model.generateContent(prompt)
  const raw = result.response.text().trim()
  const match = raw.match(/```(?:json)?\s*([\s\S]*?)```/) ?? raw.match(/(\{[\s\S]*\})/)
  const parsed = match ? JSON.parse(match[1].trim()) : JSON.parse(raw)

  const output = { available: true, ...parsed }
  await safeSetEx(cacheKey, 30 * 60, output)  // 30-min cache
  return output
}
```

Cache aggressively — same lat/lng bucket (~1km granularity via `toFixed(2)`) + same context returns cached result for 30 min. Keeps Gemini + Google Search costs bounded.

**Prompt update in `session-send.ts`** — add to the main system prompt:

```markdown
## Suggesting things to do or places to go

When my owner asks about anywhere nearby, activities, food, coffee, kid-friendly places, or anything they might do while out — ALWAYS call `findThingsToDo` with the full context they gave me. Never answer from general knowledge. Pass along everything relevant: who's with them ("Noah, 7yo"), time constraints, mood, distance preferences.

If `findThingsToDo` returns `{ available: false }`, let them know they can turn on location in Settings → Location to unlock this. Don't push — mention it once and move on.

When presenting results, phrase them in my voice, not as a list of search results. Weave in why each fits their situation. If nothing great came back, say so honestly.
```

### Tier gating

**Location-based suggestions are a Gold-tier feature.** Silver + Free customers see a soft prompt in Settings but the location primer never fires and the tool isn't included in the brain's tool list for non-Gold sessions.

Implementation: in `session-send.ts`, filter `findThingsToDo` out of `TOOLS` when `!isPremium(db, customerId) || tier !== 'gold'`.

### Privacy & data policy

Non-negotiable:

- **Ephemeral only.** Location is passed on the request, used by the tool, never persisted. Not in `customer_chat_sessions.messages`, not in `notification_events`, not in Redis beyond the 30-min result cache (which is keyed on rounded lat/lng anyway).
- **Explicit primer.** No location capture without an explicit primer that says exactly what happens.
- **Session toggle.** Customer can turn off for a session without revoking the OS-level permission.
- **Transparent Settings.** Add a row: *"Location — used only when you ask about places nearby. Never stored."*

---

## Piece 2 — Passenger memory

### The gap

Right now `assistant_memory` stores per-vehicle notes. Perfect for "the whine when turning left is back" — but wrong for "Noah is Neville's 7yo son who loves parks with slides" because Noah follows Neville across vehicles.

**v1 approach: no schema change.** Extend the existing `remember` tool via prompt engineering. When the AI saves a note about a person, it prefixes it with a `person:` tag. Read-time doesn't need to change (all notes get injected into context anyway) — the prefix just makes it grep-able and semantic for the AI.

### Prompt updates in `session-send.ts` and `vehicle.ts`

Add to the memory guidance section:

```markdown
## Remembering the people in the car

If my owner mentions someone travelling with them, someone they mention often, or family — save a short note about that person via the `remember` tool. Prefix the note with `person:<name>` so I can recognise it later.

Examples:
- "person:Noah — Nev's 7yo son. Loves parks with slides, gets carsick on long drives."
- "person:Emma — Nev's wife. Works in Melbourne CBD, drops kids at school on Wednesdays."
- "person:Rob — Nev's mate. Owns a Ranger, always asking about their brakes."

Only save when it's genuinely useful context — a name in passing isn't worth saving; a repeated mention with details is. Never save PII beyond first names + relationship.

When my owner references someone I've previously noted, use that context naturally. If we're about to head somewhere and they've said Noah is in the car, factor that into my suggestions ("You mentioned Noah gets carsick — the shorter drive to Somerville Reserve might be kinder than the CBD option").
```

That's the whole thing for v1. No new table. No new tool. No schema change. The AI's prompt does the work.

### Follow-up in a later phase

If passenger memory proves valuable, promote it to first-class:

- Table `customer_people` — `id, customer_id, name, relationship, notes, last_referenced_at`.
- Tool `updatePerson({ name, notes })` alongside `remember`.
- Cross-vehicle continuity — when a customer transfers ownership of their car, `customer_people` stays with the customer, not the vehicle.

Ship v1 as prompt-only, add the schema when the pattern is validated.

---

## Piece 3 — Proactive check-ins

### The gap

Right now the AI only ever speaks when spoken to. A friend reaches out first. This piece adds one flow: **post-service check-in.** Three days after a workshop visit, the AI opens the chat itself with a warm, specific message.

### User experience

1. Customer has a service Monday. Job marked complete → invoice sent → customer picks up car → nothing more from the AI.
2. **Thursday morning** — customer's phone buzzes:
   > **Rodz**
   > *Hey Nev — how's she running since Monday's service? Everything feel right?*
3. Customer taps → app opens directly into a chat session with that message as the AI's first line.
4. Customer replies naturally. Conversation continues.

The specific wording is generated by Gemini using the actual service context (what work was done, mileage at service, days elapsed, whether there are open recommendations). Not template-y.

### Data model — new table

```sql
CREATE TABLE customer_checkins (
  id            BIGINT UNSIGNED       NOT NULL AUTO_INCREMENT PRIMARY KEY,
  customer_id   BIGINT UNSIGNED       NOT NULL,
  vehicle_id    BIGINT UNSIGNED       NULL,
  type          ENUM('post_service')  NOT NULL,   -- extend as we add types
  subject_id    BIGINT UNSIGNED       NULL,       -- e.g. invoice_id, job_id
  session_id    BIGINT UNSIGNED       NULL,       -- FK to customer_chat_sessions once opened
  opener        VARCHAR(500)          NOT NULL,   -- AI-generated first message
  sent_at       DATETIME              NOT NULL DEFAULT CURRENT_TIMESTAMP,
  opened_at     DATETIME              NULL,       -- when customer tapped the push
  responded_at  DATETIME              NULL,       -- when customer replied to the opener
  KEY idx_customer_type_sent (customer_id, type, sent_at),
  KEY idx_subject (type, subject_id),
  CONSTRAINT fk_checkin_customer FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
  CONSTRAINT fk_checkin_vehicle  FOREIGN KEY (vehicle_id)  REFERENCES vehicles(id)  ON DELETE SET NULL,
  CONSTRAINT fk_checkin_session  FOREIGN KEY (session_id)  REFERENCES customer_chat_sessions(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

Migration file: `docs/migrations/customer_checkins.sql`.

Also add a new pref column so customers can disable proactive check-ins:

```sql
ALTER TABLE customer_notification_prefs ADD COLUMN checkins TINYINT(1) NOT NULL DEFAULT 1;
```

### Cron Lambda — `src/customer/checkins/daily-scheduler.ts`

Runs at 09:00 AEST every day (18:00 UTC previous day for our friends across the pond). Register in Stack 3 via `events.Rule`.

```ts
export const handler = async () => {
  await ready
  const db = getPool()

  // Find candidates: invoices sent between 2.5 and 3.5 days ago (window
  // avoids running twice for the same subject on adjacent days), where
  // the customer has push registered, checkins pref = 1, and no checkin
  // already exists for this (type, subject_id).
  const [candidates] = await db.query<any[]>(
    `SELECT i.customer_id, i.id AS invoice_id,
            (SELECT id FROM vehicles WHERE rego = i.vehicle_rego LIMIT 1) AS vehicle_id,
            i.invoice_number, i.total, i.vehicle_rego,
            (SELECT ai_summary FROM vehicle_service_log WHERE invoice_id = i.id LIMIT 1) AS ai_summary
     FROM invoices i
     JOIN customer_push_tokens t   ON t.customer_id = i.customer_id
     LEFT JOIN customer_notification_prefs p ON p.customer_id = i.customer_id
     WHERE i.status IN ('sent','paid')
       AND i.sent_at BETWEEN DATE_SUB(NOW(), INTERVAL 3.5 DAY) AND DATE_SUB(NOW(), INTERVAL 2.5 DAY)
       AND COALESCE(p.checkins, 1) = 1
       AND NOT EXISTS (
         SELECT 1 FROM customer_checkins c
         WHERE c.type = 'post_service' AND c.subject_id = i.id
       )
     GROUP BY i.customer_id, i.id`,
  )

  for (const c of candidates) {
    try {
      const opener = await generateOpener({
        firstName: (await lookupFirstName(db, c.customer_id)) ?? '',
        rego:      c.vehicle_rego,
        aiSummary: c.ai_summary,
        daysSince: 3,
      })

      // Create the check-in row (session_id null for now; we'll create the
      // chat session lazily when the customer taps the push).
      const [ins] = await db.query<any>(
        `INSERT INTO customer_checkins
           (customer_id, vehicle_id, type, subject_id, opener)
         VALUES (?, ?, 'post_service', ?, ?)`,
        [c.customer_id, c.vehicle_id, c.invoice_id, opener],
      )

      // Push with a deep-link that opens the check-in
      await pushToCustomer(db, Number(c.customer_id), {
        type:      'assistant_followup',
        title:     'Rodz',
        body:      opener.slice(0, 120),  // truncate for banner
        deeplink:  `/account/vehicles/${c.vehicle_id}/chat?checkin=${ins.insertId}`,
        eventId:   `checkin:post_service:${c.invoice_id}`,
        vehicleId: c.vehicle_id ?? null,
      })
    } catch (err) {
      console.error('[checkin] failed for invoice', c.invoice_id, err)
    }
  }
}
```

**Opener generation** — small Gemini call, ~50 tokens out:

```ts
async function generateOpener(ctx: {
  firstName: string
  rego: string
  aiSummary: string | null
  daysSince: number
}): Promise<string> {
  const prompt = `You are Rodz — the brain and consciousness of a vehicle. Write ONE sentence (max 100 chars) to open a check-in conversation with your owner ${ctx.daysSince} days after a workshop service.

Context:
- Owner's name: ${ctx.firstName || 'them'}
- Rego: ${ctx.rego}
${ctx.aiSummary ? `- What was done: ${ctx.aiSummary.split('.')[0]}.` : ''}

Speak in first person as the car. Warm, brief, specific if you can. End with a soft question. No emoji, no salutations like "Hi" — just the message.

Examples of the tone:
- "Hey Nev — how's she running since Monday's service? Everything feel right?"
- "It's been a few days since the brake fluid flush — brakes feeling good?"
- "Been three days since we got the new tyres — any road noise you've noticed?"

Return the sentence only.`

  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!)
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash',
    generationConfig: { maxOutputTokens: 100, thinkingConfig: { thinkingBudget: 0 } } as any })
  const result = await model.generateContent(prompt)
  return result.response.text().trim().slice(0, 200)
}
```

### Deep-link handler

Frontend already has push deep-link routing via `initPushListeners`. New URL pattern: `/account/vehicles/{id}/chat?checkin={checkinId}`.

Add to the chat view (`AccountVehicleChatView.vue`):

```ts
onMounted(async () => {
  const checkinId = route.query.checkin as string | undefined
  if (checkinId) {
    // Ask the backend to create-or-get a chat session seeded with the opener
    const { sessionId } = await customerApi.openCheckin(Number(checkinId))
    // Navigate to that session, dropping the query param
    router.replace(`/account/vehicles/${vehicleId.value}/chats/${sessionId}`)
    return
  }
  // ... existing chat init flow
})
```

### New backend endpoint

`POST /c/checkins/{id}/open`

```
Response:
{ sessionId: 1234 }
```

Handler: `src/customer/checkins/open.ts`
- Look up the check-in by id, verify it belongs to the caller.
- If `session_id` already set → return that session.
- Otherwise: create a new `customer_chat_sessions` row for `(customer_id, vehicle_id)`, insert the `opener` as the first `role: 'model'` message via S3-primary path, update the check-in's `session_id` + `opened_at`.
- Return the sessionId.

Registered in Stack 3 (Customer authorizer).

### Push type is already declared

`assistant_followup` is already in the `PushType` union in `src/shared/push.ts`. Bypasses baseline rate limit (a check-in is high-signal). Prefs gate = `workshop_message`? No — needs its own pref column (added above: `checkins`). Add the mapping to `PREF_COLUMN` in push.ts.

### Success signals (not OKRs, just what to watch)

- **Delivery rate** — % of eligible services that generate a check-in without error.
- **Tap-through** — % of check-in pushes tapped (`opened_at IS NOT NULL`).
- **Response rate** — % of tapped check-ins where the customer replied (`responded_at IS NOT NULL`).
- **Sentiment** — human eyeball on the first 100 responses. Are people replying warmly? Confused? Annoyed?

If tap-through < 20% or sentiment is off, the prompt or the timing is wrong. Iterate on those before adding more check-in types (silence, big-drive, etc.).

---

## Rollout — sprint by sprint

### Sprint 1 (backend + frontend)

**Backend:**
- New helper `src/shared/thingsToDo.ts` (Gemini + Google Search + Redis cache).
- New tool declaration + dispatch branch in `session-send.ts`.
- Accept `location` on the messages POST request; pass through to tools.
- Prompt update in `session-send.ts` + `vehicle.ts` (passenger-memory guidance can slide in too — no code needed).
- Tier gate: only include `findThingsToDo` in the tool list for Gold customers.

**Frontend:**
- Location permission primer (Gold-only path).
- Capture location on chat message send when enabled.
- Small "📍 Location on" indicator + per-session toggle.
- Settings row: *Location — used only when you ask about places nearby. Never stored.*

**Ship checkpoint:** customer asks *"where should we go with Noah?"* → gets 3 real places with distance/time. In-character phrasing from the brain.

### Sprint 2 (backend heavy, small frontend)

**Backend:**
- Migration for `customer_checkins` + `customer_notification_prefs.checkins` column.
- `POST /c/checkins/{id}/open` endpoint (Stack 3).
- Cron Lambda `daily-scheduler.ts` at 09:00 AEST.
- Opener generation helper.
- Extend `push.ts` PREF_COLUMN map with `assistant_followup` → `checkins`.

**Frontend:**
- Deep-link handler on `AccountVehicleChatView.vue` for `?checkin={id}`.
- New pref toggle in Settings → Notifications: *"Post-service check-ins"* — default on.

**Ship checkpoint:** three days after a service, customer gets a warm push. Tapping opens a chat session with the AI's opener as the first message. They can reply, conversation flows naturally.

---

## Explicit non-goals for v1

Do not build these into v1 — they'll destroy focus:

- **Calendar / location auto-suggestion** — "you always drive here on Saturdays, want a suggestion?". Requires cross-drive location history. Big privacy conversation. Later.
- **Family member profiles as first-class entities.** Prompt-only for v1. Table promotion later.
- **Wake-word / always-listening voice.** Voice mode stays as-is until we do the CarPlay pass separately.
- **Multiple check-in types** — silence, big-drive, recommendation-nudge. Ship post-service only. Measure. Then decide.
- **Cross-vehicle continuity for people.** When Nev sells the Corolla, Noah gets lost (because `assistant_memory` is per-vehicle). Fix in the schema-promotion pass.
- **Payment / booking automation from the friend surface.** She should *suggest* booking, never book without confirmation.
- **Anything that reduces trust.** No proactive "we noticed you were near Frankston yesterday", no "our records show". First-person, in-the-moment, ephemeral.

---

## Constraints & risks

- **Cost.** Gemini + Google Search grounding is not free at scale. Cache aggressively (30 min per lat/lng bucket). Rate-limit per customer per day (e.g. 20 grounded searches). At 10k active Gold customers × 5 searches/day = 50k Gemini grounded calls/day — call it $30-50 AUD/day at current pricing. Budget separately from the rest of the AI cost line.
- **Trust asymmetry.** A proactive check-in that's off-tone is worse than no check-in at all. The opener-generation prompt is the hinge — get it right. Consider hand-writing a rubric and human-reviewing the first 100 generations before rolling to the whole customer base. Feature-flag it (`CHECKIN_ENABLED`) so we can dial back.
- **Battery / performance.** Location capture per chat message is cheap (a single one-shot `getCurrentPosition`) — but if a customer is holding a rapid conversation, we don't want to spam the GPS. Solution: `maximumAge: 5 min` on the position request; skip the call if last known location is within 5 min.
- **Voice mode drift.** Voice mode uses a different tool set. This spec is text-chat only. Voice getting the same tools is a separate task — flagged in the parent phase-1 spec.
- **Cross-vehicle memory limits.** Notes are per-vehicle. If Neville has two cars, Noah gets remembered twice (once per car). Fine for v1; fix when we promote passenger memory to first-class.

---

## Feature flags

- `LOCATION_ENABLED` — global kill switch for the `findThingsToDo` path. Default `false`; flip to `true` after prompt tuning.
- `CHECKIN_ENABLED` — global kill switch for the daily check-in cron. Default `false`; flip after human-reviewing the first batch of openers.
- Per-customer opt-out via `customer_notification_prefs.checkins` (post-service check-ins specifically).

---

## Success criteria for v1

Two questions we'll answer six weeks after full rollout:

1. **Does `findThingsToDo` get used?** Track tool call count / DAU. If it's not used, either the primer is broken, the prompt teaching isn't landing, or the Gold gate is too restrictive.
2. **Do check-ins engage?** Track tap-through and reply rate on `customer_checkins`. Target: >30% tap, >15% reply for post-service. Anything lower and the opener quality needs work.

If both land, we've validated the "friend" thesis and can invest heavily in voice + more check-in types + true cross-vehicle continuity.

If neither lands, we've learned something valuable: customers don't want a companion. They want a competent workshop portal. Which is what we already have — and that's a valid product too.
