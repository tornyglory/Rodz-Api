// One-off migration: read every row in vehicle_expenses, write to S3 as
// either fuel-fills or expenses, insert an s3_event_index pointer for each.
// Does NOT delete the MySQL rows — that happens later after reads are cutover.
import mysql from 'mysql2/promise'
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { randomBytes } from 'crypto'

const s3     = new S3Client({ region: 'ap-southeast-2' })
const BUCKET = 'rodz-data-lake'

const conn = await mysql.createConnection({
  host:     process.env.DB_HOST,
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port:     Number(process.env.DB_PORT ?? 3306),
  ssl:      { rejectUnauthorized: true },
})

// Which MySQL expense.id has already been migrated? Skip if the payload's
// expenseId matches a row we've indexed before.
const [existing] = await conn.query('SELECT s3_key FROM s3_event_index WHERE event_type IN ("fuel-fills","expenses")')
const alreadyKeys = new Set(existing.map(r => r.s3_key))
console.log(`s3_event_index already tracks ${alreadyKeys.size} expense-shaped rows`)

const [rows] = await conn.query(`
  SELECT id, vehicle_id, customer_id, category, merchant_name, merchant_suburb, merchant_state,
         amount_aud, expense_date, odometer_km, fuel_type, fuel_litres, price_per_litre,
         ev_kwh, price_per_kwh, image_id, notes, created_at, is_business_expense
  FROM vehicle_expenses
  ORDER BY id ASC
`)
console.log(`found ${rows.length} MySQL expense rows to migrate`)

let migrated = 0, skipped = 0

for (const r of rows) {
  // Idempotency: check if there's already an index row for this expense id
  // (embedded in the S3 payload as "legacyExpenseId").
  const [dup] = await conn.query(
    `SELECT id FROM s3_event_index WHERE vehicle_id = ? AND event_type IN ('fuel-fills','expenses')
     AND JSON_EXTRACT(key_topics, '$.legacyExpenseId') = ? LIMIT 1`,
    [r.vehicle_id, r.id],
  ).catch(() => [[]])
  if (dup.length) { skipped++; continue }

  const isFuel     = r.category === 'fuel' || r.category === 'ev_charging'
  const eventType  = isFuel ? 'fuel-fills' : 'expenses'
  const now        = new Date()
  const year       = now.getFullYear()
  const month      = String(now.getMonth() + 1).padStart(2, '0')
  const id         = `${now.getTime()}-${randomBytes(4).toString('hex')}`
  const key        = `${eventType}/year=${year}/month=${month}/${id}.json`

  const payload = {
    eventType,
    timestamp:       now.toISOString(),
    vehicleId:       r.vehicle_id,
    customerId:      r.customer_id,
    legacyExpenseId: r.id,   // trace back to the original MySQL row
    category:        r.category,
    merchantName:    r.merchant_name ?? null,
    merchantSuburb:  r.merchant_suburb ?? null,
    merchantState:   r.merchant_state ?? null,
    amount:          r.amount_aud != null ? Number(r.amount_aud) : null,
    expenseDate:     r.expense_date instanceof Date ? r.expense_date.toISOString().slice(0, 10) : String(r.expense_date).slice(0, 10),
    odometerKm:      r.odometer_km != null ? Number(r.odometer_km) : null,
    fuelType:        r.fuel_type ?? null,
    litres:          r.fuel_litres != null ? Number(r.fuel_litres) : null,
    pricePerLitre:   r.price_per_litre != null ? Number(r.price_per_litre) : null,
    evKwh:           r.ev_kwh != null ? Number(r.ev_kwh) : null,
    pricePerKwh:     r.price_per_kwh != null ? Number(r.price_per_kwh) : null,
    imageId:         r.image_id ?? null,
    notes:           r.notes ?? null,
    isBusinessExpense: !!r.is_business_expense,
    createdAt:       r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    migratedFrom:    'vehicle_expenses',
    migratedAt:      now.toISOString(),
  }

  await s3.send(new PutObjectCommand({
    Bucket:      BUCKET,
    Key:         key,
    Body:        JSON.stringify(payload),
    ContentType: 'application/json',
  }))

  const summary = isFuel
    ? `${payload.litres ?? '?'}L @ ${payload.pricePerLitre ?? '?'}c/L ${payload.merchantName ?? ''}`.trim()
    : `$${payload.amount ?? '?'} ${payload.category}${payload.merchantName ? ` @ ${payload.merchantName}` : ''}`

  await conn.query(
    `INSERT INTO s3_event_index (vehicle_id, customer_id, event_type, s3_key, event_date, summary, key_topics)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [r.vehicle_id, r.customer_id, eventType, key, payload.expenseDate, summary, JSON.stringify({ legacyExpenseId: r.id })],
  )

  migrated++
  console.log(`  → migrated expense ${r.id} → ${key}`)
}

console.log(`\nDone. migrated=${migrated} skipped=${skipped}`)
await conn.end()
