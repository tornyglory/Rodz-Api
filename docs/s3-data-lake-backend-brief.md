# S3 Data Lake — Backend Brief

Moves historical event detail off MySQL and into S3. MySQL keeps operational data, aggregate summaries, and a small pointer table (`s3_event_index`) that makes S3 objects queryable by vehicle + event type + date. Bounded, indexed lookups only — MySQL never scans millions of rows.

Can be shipped independently of the Redis cache brief (`redis-cache-backend-brief.md`). This brief is self-contained.

---

## Data model — where each thing lives

| Data | Store | Growth |
|------|-------|--------|
| Customers, vehicles, vehicle_owners, staff, stores, bookings, chat sessions | MySQL (unchanged) | Bounded per business |
| Full chat transcripts (post session-close), fuel-fill detail, expense detail with receipt, job records, assistant Q/A, warning-light scans, diagnostic outcomes | **S3 — one JSON object per event** | Unbounded |
| Per-vehicle aggregates (last fill, YTD spend, health score, next-service-due) | MySQL summary tables | 1 row per vehicle — bounded |
| Pointers to every S3 object (`vehicle_id`, `event_type`, `s3_key`, `event_date`, short summary) | MySQL `s3_event_index` | 1 row per event, indexed |

The `s3_event_index` table grows with events but MySQL is only doing indexed seeks (`vehicle_id + event_type + event_date DESC LIMIT N`) — B-tree lookups regardless of total size. At 100 M rows, still ~2 ms per query with the right indexes.

---

## S3 bucket

**Name:** `rodz-data-lake`
**Region:** `ap-southeast-2`
**Public access:** all blocked
**Versioning:** enabled (small extra cost, safety net for accidental writes)
**Encryption:** SSE-S3 (default)
**Lifecycle:**

```json
{
  "Rules": [{
    "Id": "tiered-storage",
    "Status": "Enabled",
    "Filter": { "Prefix": "" },
    "Transitions": [
      { "Days": 90,  "StorageClass": "STANDARD_IA" },
      { "Days": 365, "StorageClass": "GLACIER" }
    ]
  }]
}
```

**Folder layout (Hive-partitioned so Athena can query without extra config later):**

```
s3://rodz-data-lake/
├── diagnostic-sessions/year=2026/month=07/{id}.json
├── jobs-detail/year=2026/month=07/{id}.json
├── fuel-fills/year=2026/month=07/{id}.json
├── expenses/year=2026/month=07/{id}.json
├── assistant-questions/year=2026/month=07/{id}.json
├── warning-lights/year=2026/month=07/{id}.json
└── diagnostic-outcomes/year=2026/month=07/{id}.json
```

Object key: `{event_type}/year={YYYY}/month={MM}/{unix_ms}-{rand}.json`

---

## IAM

Add to the shared Lambda role in `cdk/lib/constructs/lambda-fn.ts` inline policies:

```ts
DataLake: new iam.PolicyDocument({
  statements: [new iam.PolicyStatement({
    actions: ['s3:PutObject', 's3:GetObject'],
    resources: [`arn:aws:s3:::rodz-data-lake/*`],
  })],
}),
```

No `s3:ListBucket` — every read is by known key from the index. No bucket-level permissions.

---

## Utility — `src/shared/dataLake.ts` (new)

```ts
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3'
import { randomBytes } from 'crypto'

const s3     = new S3Client({ region: process.env.REGION ?? 'ap-southeast-2' })
const BUCKET = 'rodz-data-lake'

export interface DataLakeEvent {
  vehicleId?:  number
  customerId?: number
  [k: string]: unknown
}

export async function writeToDataLake(
  eventType: string,
  data:      DataLakeEvent,
): Promise<{ key: string; summary: string } | null> {
  const now   = new Date()
  const year  = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const id    = `${now.getTime()}-${randomBytes(4).toString('hex')}`
  const key   = `${eventType}/year=${year}/month=${month}/${id}.json`

  try {
    await s3.send(new PutObjectCommand({
      Bucket:      BUCKET,
      Key:         key,
      Body:        JSON.stringify({ eventType, timestamp: now.toISOString(), ...data }),
      ContentType: 'application/json',
    }))
    return { key, summary: shortSummary(eventType, data) }
  } catch (err) {
    // Never fail the main operation because of a data lake write.
    console.error('[dataLake] write failed', eventType, (err as Error).message)
    return null
  }
}

export async function readFromDataLake<T = unknown>(key: string): Promise<T | null> {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }))
    const txt = await res.Body!.transformToString()
    return JSON.parse(txt) as T
  } catch (err) {
    console.error('[dataLake] read failed', key, (err as Error).message)
    return null
  }
}

function shortSummary(eventType: string, data: any): string {
  // Cheap per-event-type one-liner for the s3_event_index.summary column.
  switch (eventType) {
    case 'fuel-fills':          return `${data.litres}L @ ${data.pricePerLitre}c/L — ${data.station ?? 'unknown'}`
    case 'expenses':            return `$${data.amount} ${data.category ?? 'other'}`
    case 'diagnostic-sessions': return data.summary?.slice(0, 200) ?? 'chat session'
    case 'jobs-detail':         return `${data.serviceTypes?.join(', ') ?? 'service'} — $${data.total ?? '?'}`
    case 'warning-lights':      return `${data.symbol} — ${data.severity}`
    case 'assistant-questions': return data.question?.slice(0, 200) ?? 'ai query'
    default:                    return ''
  }
}
```

**Notes:**
- `await` the write, never fire-and-forget (Lambda would freeze the promise pre-send — same bug we hit with the AI engine invocations earlier this month).
- Failure logs and returns `null`. Caller checks the return before inserting the index row.
- Total added latency per write: ~40–80 ms. Runs in parallel with the MySQL summary update via `Promise.all`, so real hot-path cost is closer to the slower of the two.

---

## MySQL — `s3_event_index` table

```sql
CREATE TABLE s3_event_index (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  vehicle_id    BIGINT UNSIGNED NULL,
  customer_id   BIGINT UNSIGNED NULL,
  event_type    ENUM('diagnostic-sessions','jobs-detail','fuel-fills','expenses',
                     'assistant-questions','warning-lights','diagnostic-outcomes') NOT NULL,
  s3_key        VARCHAR(500) NOT NULL,
  event_date    DATETIME NOT NULL,
  summary       VARCHAR(500) NULL,
  key_topics    JSON NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  INDEX idx_vehicle_event_date (vehicle_id, event_type, event_date),
  INDEX idx_customer_event_date (customer_id, event_type, event_date),
  INDEX idx_event_date (event_type, event_date),

  FOREIGN KEY (vehicle_id)  REFERENCES vehicles(id)  ON DELETE SET NULL,
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

**Composite indexes matter** — a plain `INDEX (vehicle_id)` won't help queries that also filter by `event_type` and sort by `event_date`. Three composites cover the three main access patterns: per-vehicle history, per-customer history, cross-fleet analytics.

`ON DELETE SET NULL` (not CASCADE) — if a vehicle or customer is removed, the pointer rows survive so we don't orphan S3 objects.

---

## MySQL — summary tables

```sql
CREATE TABLE vehicle_fuel_summary (
  vehicle_id             BIGINT UNSIGNED PRIMARY KEY,
  last_fill_date         DATE,
  last_fill_litres       DECIMAL(6,2),
  last_fill_price        DECIMAL(5,1),
  avg_consumption_l100km DECIMAL(5,2),
  total_fuel_spend_ytd   DECIMAL(10,2) NOT NULL DEFAULT 0,
  total_litres_ytd       DECIMAL(10,2) NOT NULL DEFAULT 0,
  fill_count_ytd         INT UNSIGNED  NOT NULL DEFAULT 0,
  updated_at             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (vehicle_id) REFERENCES vehicles(id) ON DELETE CASCADE
);

CREATE TABLE vehicle_expense_summary (
  vehicle_id            BIGINT UNSIGNED PRIMARY KEY,
  total_spend_mtd       DECIMAL(10,2) NOT NULL DEFAULT 0,
  total_spend_ytd       DECIMAL(10,2) NOT NULL DEFAULT 0,
  fuel_spend_ytd        DECIMAL(10,2) NOT NULL DEFAULT 0,
  service_spend_ytd     DECIMAL(10,2) NOT NULL DEFAULT 0,
  other_spend_ytd       DECIMAL(10,2) NOT NULL DEFAULT 0,
  cost_per_km           DECIMAL(6,2),
  updated_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (vehicle_id) REFERENCES vehicles(id) ON DELETE CASCADE
);

CREATE TABLE vehicle_health_scores (
  vehicle_id          BIGINT UNSIGNED PRIMARY KEY,
  overall_score       TINYINT UNSIGNED,
  engine_score        TINYINT UNSIGNED,
  brakes_score        TINYINT UNSIGNED,
  tyres_score         TINYINT UNSIGNED,
  service_compliance  TINYINT UNSIGNED,
  last_service_date   DATE,
  next_service_due    DATE,
  overdue_items_count TINYINT UNSIGNED NOT NULL DEFAULT 0,
  calculated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (vehicle_id) REFERENCES vehicles(id) ON DELETE CASCADE
);

CREATE TABLE maintenance_schedule (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  vehicle_id     BIGINT UNSIGNED NOT NULL,
  item_name      VARCHAR(100) NOT NULL,
  last_done_date DATE,
  last_done_km   INT UNSIGNED,
  next_due_date  DATE,
  next_due_km    INT UNSIGNED,
  status         ENUM('ok','due_soon','overdue') NOT NULL DEFAULT 'ok',
  urgency        ENUM('low','medium','high')     NOT NULL DEFAULT 'low',
  estimated_cost DECIMAL(8,2),
  updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_vehicle_item (vehicle_id, item_name),
  FOREIGN KEY (vehicle_id) REFERENCES vehicles(id) ON DELETE CASCADE
);
```

Every summary row is upserted (`INSERT ... ON DUPLICATE KEY UPDATE`) on the corresponding event write. One row per vehicle max — bounded forever.

---

## Write pattern — example (fuel fill)

Every event write becomes a `Promise.all` of three writes: S3 detail, MySQL summary, MySQL index row.

```ts
async function logFuelFill(vehicleId: number, fillData: FuelFillInput) {
  const [s3Result] = await Promise.all([
    writeToDataLake('fuel-fills', { vehicleId, ...fillData }),

    db.query(`
      INSERT INTO vehicle_fuel_summary
        (vehicle_id, last_fill_date, last_fill_litres, last_fill_price,
         avg_consumption_l100km, total_fuel_spend_ytd, total_litres_ytd, fill_count_ytd)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)
      ON DUPLICATE KEY UPDATE
        last_fill_date          = VALUES(last_fill_date),
        last_fill_litres        = VALUES(last_fill_litres),
        last_fill_price         = VALUES(last_fill_price),
        avg_consumption_l100km  = VALUES(avg_consumption_l100km),
        total_fuel_spend_ytd    = total_fuel_spend_ytd    + VALUES(total_fuel_spend_ytd),
        total_litres_ytd        = total_litres_ytd        + VALUES(total_litres_ytd),
        fill_count_ytd          = fill_count_ytd + 1
    `, [vehicleId, fillData.date, fillData.litres, fillData.pricePerLitre,
        fillData.consumption, fillData.totalCost, fillData.litres]),
  ])

  if (s3Result) {
    await db.query(`
      INSERT INTO s3_event_index (vehicle_id, event_type, s3_key, event_date, summary)
      VALUES (?, 'fuel-fills', ?, ?, ?)
    `, [vehicleId, s3Result.key, fillData.date, s3Result.summary])
  }
}
```

Same shape for `logExpense`, `logJobCompletion`, `logDiagnosticSession` (called on chat session close), etc.

**Ordering matters:** S3 + summary go in parallel (both idempotent-ish). Index row goes after because it references the S3 key. If S3 write fails (`s3Result === null`), we skip the index row — summary is still updated, event is not queryable historically but aggregates remain correct.

---

## Read pattern — example (agent tool)

Agent tools that need historical detail hit MySQL first (find keys), then S3 in parallel (fetch objects):

```ts
async function getFuelHistory(vehicleId: number, limit = 20) {
  const [pointers] = await db.query<any[]>(`
    SELECT s3_key, event_date, summary
    FROM s3_event_index
    WHERE vehicle_id = ? AND event_type = 'fuel-fills'
    ORDER BY event_date DESC
    LIMIT ?
  `, [vehicleId, limit])

  if (!pointers.length) return []

  const details = await Promise.all(pointers.map(p => readFromDataLake(p.s3_key)))
  return details.filter(d => d != null)
}
```

Typical latency: 2 ms MySQL + parallel S3 fetches (each ~40 ms) = ~50–80 ms total for 20 records. Acceptable inside an agent tool (Gemini spends 500–2000 ms per turn anyway).

For summary-only queries ("how much fuel this year?"), skip S3 entirely — read from `vehicle_fuel_summary`. ~5 ms.

---

## Athena — background analytics only

Set up after the write path is live and there's meaningful data. Not required for shipping.

- Create Glue crawler pointed at `s3://rodz-data-lake/` — Hive partitioning is auto-detected
- Athena queries fleet-wide questions (network fuel benchmarks, diagnostic accuracy)
- **Never called from a customer-facing request path** — 2–10 second latency
- Runs from a nightly Lambda scheduled via EventBridge; results written into MySQL summary tables (e.g. `network_benchmarks_by_model`)

Athena scan cost at your volume: cents per query. Fine to run daily.

---

## Migration approach for existing data

The three growth-bound tables you already have:

| Existing MySQL table | New home | Migration |
|---------------------|----------|-----------|
| `customer_vehicle_chats` (chat messages) | **Stay in MySQL for active sessions**; write a `diagnostic-sessions/*.json` archive when session is deleted or after 90 days idle | Live cutover, backfill later if wanted |
| `vehicle_service_log` (job records) | S3 for detail via `writeToDataLake('jobs-detail', ...)` on job completion; existing rows keep serving reads | Dual-write new completions; leave existing rows in place |
| Expense / fuel-fill tables (once wired) | S3 primary from day 1 | New feature — no existing rows to migrate |

**Nothing gets deleted from MySQL during rollout.** Once S3 has been the source of truth for a category for 90+ days and read paths have been cut over, we can decide whether to drop the MySQL detail tables. Reversible until then.

---

## Failure modes

- **S3 write fails** — main operation succeeds, event not indexed. Logged with `event_type` and error message so we can spot systemic issues. No user impact.
- **S3 read fails on a specific key** — `readFromDataLake` returns `null`. Agent tool filters nulls and continues with fewer results. Logged.
- **Bucket-level outage** — all archival writes fail silently; all historical-detail reads return empty. Summary reads from MySQL still work, aggregates still update. Chat/agent responses become less rich but everything keeps working.
- **`s3_event_index` insert fails** — S3 object exists but is orphaned (not queryable). Rare (would need a MySQL failure after S3 succeeded). A nightly reconciliation job could list S3 objects and cross-check against the index — worth building only if we see it happen.

The pattern is optimistic — writes happen, index tracks what's there, degraded state is *fewer historical results*, not broken responses.

---

## Rollout order

Ship in this sequence — each step independently reviewable:

1. **Foundation (day 1)** — Create S3 bucket + lifecycle. Add IAM policy to shared Lambda role via CDK. `writeToDataLake` + `readFromDataLake` in `src/shared/dataLake.ts`.
2. **Migration (day 1)** — Apply `s3_event_index` + 4 summary tables. `docs/migrations/s3_data_lake.sql`.
3. **First write path — fuel fills (day 2)** — Wire `logFuelFill` into whichever handler creates fuel fills. Verify both S3 object + `s3_event_index` row + `vehicle_fuel_summary` row are produced by a single API call.
4. **Second write path — expenses (day 2–3)** — Same treatment for expense creation. Different summary computation.
5. **Third write path — chat archive (day 3–4)** — Add session-close event that dumps full transcript + Gemini-generated summary to S3 with type `diagnostic-sessions`.
6. **Agent read functions (day 4–5)** — `getFuelHistory`, `getExpenseHistory`, `getDiagnosticHistory` as tool declarations in `session-send.ts`. Test end-to-end: ask the assistant "how much have I spent on fuel this year?" and confirm it reads from summary, not S3.
7. **Job completion + warning lights (day 5–7)** — Same triple-write on job-complete + warning-light events.
8. **Athena — later.** Set up when you want fleet-wide analytics. Nightly benchmarks job. Not a blocker for anything customer-facing.

Realistic total for steps 1–7: **1 focused week** with feature work continuing in parallel.

---

## What we're explicitly NOT doing

- **SNS or EventBridge fan-out.** Only one downstream consumer (S3 archive). Direct dual-write is simpler and has the same durability. Add SNS only when a second consumer justifies it.
- **DynamoDB as the index.** MySQL `s3_event_index` handles the lookup patterns fine and keeps us on tooling we already own. Revisit only if MySQL becomes the bottleneck.
- **Kinesis Firehose or Athena on hot path.** Firehose is for high-volume streaming (thousands of events/sec), overkill. Athena is background analytics only.
- **Retrospective backfill of existing MySQL data into S3.** Deferred. Start capturing new events cleanly; backfill later if a specific need arises (e.g. we want the historical corpus for AI training).
- **Cross-region replication.** Single-region until we have a compliance or DR requirement.

---

## Migration checklist

- [ ] Create S3 bucket `rodz-data-lake` in `ap-southeast-2` with public access blocked, versioning on, SSE-S3
- [ ] Apply lifecycle rule (90d → IA, 365d → Glacier)
- [ ] Update `cdk/lib/constructs/lambda-fn.ts` shared role to include `s3:PutObject` + `s3:GetObject` on the bucket
- [ ] Add `@aws-sdk/client-s3` to `package.json` dependencies (already present as CDK dep; confirm runtime bundle picks it up correctly)
- [ ] Ship `src/shared/dataLake.ts` with `writeToDataLake` + `readFromDataLake`
- [ ] Migration `docs/migrations/s3_data_lake.sql`: `s3_event_index`, `vehicle_fuel_summary`, `vehicle_expense_summary`, `vehicle_health_scores`, `maintenance_schedule`
- [ ] Wire write paths (fuel → expenses → chat archive → jobs → warning lights) — one PR each so each is independently reviewable
- [ ] Wire agent read tools in `session-send.ts`
- [ ] Verify degraded-mode: set a bogus bucket name, ensure the API still works (main ops succeed, historical reads return empty)
- [ ] Athena Glue crawler + first nightly benchmark job (deferred; ship when there's data worth analysing)
