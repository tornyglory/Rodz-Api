// One-off: fill tyre_size_front/rear/spare on every active vehicle
// where they're currently NULL. The recommendation engine already
// uses these when composing tyre-service specs; sourcing engine
// includes them in eBay queries when we search for tyres.
//
//   node scripts/backfill-tyre-sizes.mjs               (dry run — prints)
//   node scripts/backfill-tyre-sizes.mjs --write       (persist)
//
// Uses Gemini to look up the OEM/factory fitment per vehicle. LLM's
// automotive knowledge is strong on this — factory tyre sizes are
// well-documented per-model.

import 'dotenv/config'
import mysql from 'mysql2/promise'
import { GoogleGenerativeAI } from '@google/generative-ai'

const args  = process.argv.slice(2)
const write = args.includes('--write')

const db = await mysql.createConnection({
  host: process.env.DB_HOST, port: Number(process.env.DB_PORT),
  user: process.env.DB_USER, password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME, ssl: { rejectUnauthorized: false },
})

const [vehicles] = await db.query(
  `SELECT id, year, make, model, series, engine_code, engine_size_cc, body_type, fuel_type
   FROM vehicles
   WHERE is_active = 1
     AND (tyre_size_front IS NULL OR tyre_size_rear IS NULL)
   ORDER BY id`,
)

if (vehicles.length === 0) {
  console.log('nothing to backfill — every active vehicle has tyre sizes')
  await db.end()
  process.exit(0)
}
console.log(`${vehicles.length} vehicle${vehicles.length===1?'':'s'} need${vehicles.length===1?'s':''} tyre-size backfill (${write ? 'writing' : 'dry run'})\n`)

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY ?? '')
const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' })

let filled = 0, skipped = 0, failed = 0

for (const v of vehicles) {
  const parts = [
    `${v.year} ${v.make} ${v.model}`,
    v.series         ? v.series               : null,
    v.body_type      ? v.body_type            : null,
    v.engine_code    ? `engine ${v.engine_code}` : null,
    v.engine_size_cc ? `${v.engine_size_cc}cc` : null,
    v.fuel_type      ? v.fuel_type            : null,
  ].filter(Boolean).join(', ')

  const prompt = `You are an Australian motor-trade parts specialist. Give me the OEM/factory-fitment tyre sizes for this vehicle.

Vehicle: ${parts}

Return a JSON object only (no markdown fences, no commentary) with three fields:
{
  "front": "205/55R16 91V",     // full ISO tyre code — width/aspect/rim + load/speed if standard
  "rear":  "205/55R16 91V",     // usually same as front unless the model has staggered fitment (BMW/Porsche/etc.)
  "spare": "T125/70R16"         // full-size spare same as front OR space-saver code OR null if no spare
}

Rules:
- If the model had multiple trim options, return the most common base-trim fitment.
- "spare" is null when the vehicle uses a repair kit instead of a spare.
- Include the ISO load/speed suffix when it's standard (e.g. "91V"); omit for space-saver spares.
- If you genuinely don't know the vehicle (obscure or ambiguous), return { "front": null, "rear": null, "spare": null }.`

  try {
    const res  = await model.generateContent(prompt)
    const text = res.response.text().replace(/```(?:json)?/g, '').replace(/```/g, '').trim()
    const j    = JSON.parse(text)
    const front = j.front && typeof j.front === 'string' ? j.front.trim().slice(0, 30) : null
    const rear  = j.rear  && typeof j.rear  === 'string' ? j.rear.trim().slice(0, 30)  : null
    const spare = j.spare && typeof j.spare === 'string' ? j.spare.trim().slice(0, 30) : null

    if (!front && !rear) {
      console.log(`  ⚠ vehicle ${v.id} (${parts.slice(0, 60)}) → LLM had no answer`)
      skipped++
      continue
    }

    console.log(`  ✓ vehicle ${v.id} (${v.year} ${v.make} ${v.model}) → front:${front}  rear:${rear}  spare:${spare ?? '—'}`)

    if (write) {
      await db.query(
        `UPDATE vehicles
         SET tyre_size_front = COALESCE(tyre_size_front, ?),
             tyre_size_rear  = COALESCE(tyre_size_rear,  ?),
             spare_tyre_size = COALESCE(spare_tyre_size, ?),
             updated_at      = NOW()
         WHERE id = ?`,
        [front, rear, spare, v.id],
      )
    }
    filled++
  } catch (err) {
    console.error(`  ✗ vehicle ${v.id} — ${err.message}`)
    failed++
  }
}

console.log(`\ndone — filled: ${filled} · skipped: ${skipped} · failed: ${failed}${write ? '' : '  (dry run; add --write to persist)'}`)
await db.end()
