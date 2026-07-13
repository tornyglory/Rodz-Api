# Voice Sessions — Backend Brief

Tracks Gemini Live voice-mode sessions so we can see who's using voice, how long they use it for, and what it's costing. Also gives us a place to enforce per-customer daily/monthly caps if Gemini Live turns out to be expensive.

Every Gemini Live session starts with a `POST /c/vehicles/{id}/voice/session` call that mints an ephemeral token — that endpoint is where the row gets written. The frontend does the actual audio streaming with Google directly; we never see the audio.

## Data model

```sql
CREATE TABLE voice_sessions (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  customer_id    BIGINT UNSIGNED NOT NULL,
  vehicle_id     BIGINT UNSIGNED NOT NULL,
  chat_session_id BIGINT UNSIGNED NULL,      -- optional link to a text chat session if voice was launched from one
  model          VARCHAR(60)  NOT NULL,      -- e.g. 'gemini-2.0-flash-exp' — capture what we minted for
  started_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ended_at       DATETIME     NULL,          -- filled in when the frontend reports session-end (best-effort)
  duration_sec   INT UNSIGNED NULL,          -- (ended_at - started_at) — denormalised for fast aggregation
  input_audio_sec  INT UNSIGNED NULL,        -- optional, reported by frontend from Gemini usage metadata
  output_audio_sec INT UNSIGNED NULL,        -- optional, reported by frontend from Gemini usage metadata
  ended_reason   ENUM('client','error','timeout','quota','unknown') NOT NULL DEFAULT 'unknown',
  error_message  VARCHAR(500) NULL,          -- if ended_reason='error', short reason from the client
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,

  INDEX idx_customer_started (customer_id, started_at),
  INDEX idx_vehicle          (vehicle_id, started_at),
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
  FOREIGN KEY (vehicle_id)  REFERENCES vehicles(id)  ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

## Row lifecycle

1. **Session start** — `POST /c/vehicles/{id}/voice/session` inserts a row after verifying `customer.tier === 'gold'` and vehicle ownership. Returns the `sessionId` to the frontend alongside the ephemeral Gemini token.
2. **Session end** — frontend calls `PATCH /c/voice/sessions/{sessionId}` when the WebSocket to Gemini closes (best-effort — not guaranteed to arrive). Body: `{ endedReason, inputAudioSec, outputAudioSec, errorMessage? }`. Backend fills `ended_at = NOW()`, computes `duration_sec`.
3. **Stale rows** — a nightly job (or a lazy check on the next voice-session request) closes any row older than 30 min with `ended_at IS NULL` — sets `ended_reason = 'timeout'`, `ended_at = started_at + 30 min` so aggregates aren't skewed by orphaned rows.

## Per-customer quota

Gold gets voice, but not unlimited. Suggested default (adjust once we see real usage):

- **60 minutes of session `duration_sec` per calendar day, per customer**
- **10 hours per calendar month, per customer**

Enforced on session start:

```sql
SELECT COALESCE(SUM(duration_sec), 0) AS today_sec
FROM voice_sessions
WHERE customer_id = ?
  AND DATE(started_at) = CURDATE()
  AND duration_sec IS NOT NULL
```

If exceeded → `429 QUOTA_EXCEEDED` with a `resetsAt` timestamp. Enforce daily first; monthly can wait.

## Related endpoints that touch this table

| Endpoint | What it does |
|----------|--------------|
| `POST /c/vehicles/{id}/voice/session` | Verifies Gold + ownership + quota, mints ephemeral Gemini token, INSERTs a row, returns `{ sessionId, ephemeralToken, expiresAt, systemPrompt, model }` |
| `PATCH /c/voice/sessions/{sessionId}` | Marks session ended, records duration + audio-second counters + reason |
| `GET  /c/voice/sessions/usage` (optional, later) | Returns the customer's current-day and current-month totals — for a "you have X minutes left today" UI hint |

Staff-side aggregates (dashboards, per-customer usage) can be added later — the indexes support them without extra work.

## Fields worth being pedantic about

- **`duration_sec`** vs. **`input_audio_sec` + `output_audio_sec`.** Duration is wall-clock, audio-sec is what Gemini charges. They're not the same — voice sessions include silence and pauses. Store both; bill/quota off `duration_sec` (simpler), monitor cost off audio-sec.
- **`chat_session_id`** — nullable because voice can be launched from the dashboard directly, not always from an existing chat. When populated, it means the customer went voice → text or text → voice mid-conversation; useful signal.
- **`ended_reason`** — helps triage. If a lot of rows land in `'error'` or `'timeout'`, that's a signal the ephemeral token flow or the client SDK is misbehaving.

## Migration file

`docs/migrations/voice_sessions.sql` — SQL from the Data model block above. Idempotent-ish (fails cleanly if table exists; not worth wrapping in `IF NOT EXISTS` since we deploy migrations once).

## Not doing (call out)

- **Not** storing audio, transcripts, or Gemini message content. Direct-to-Gemini architecture means we don't see it. If we ever need transcripts we'll flip to a backend WebSocket proxy — separate project.
- **Not** billing per-second in real-time. Post-hoc aggregation is fine for a Gold tier feature.
- **Not** enforcing concurrent-session limits. A customer could have voice + text going in different tabs; that's fine.
