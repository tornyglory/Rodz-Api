// One-off: ask Gemini to draft steps + parts for the given service_type
// ids. Prints JSON to stdout for review, and (with --write) persists to
// service_type_steps + service_type_step_parts. Idempotent per service
// via a wipe-and-rewrite when --write is set.
//
// Usage:
//   node scripts/draft-service-steps.mjs 1 2 11              (dry-run)
//   node scripts/draft-service-steps.mjs 1 2 11 --write      (persist)

import 'dotenv/config'
import mysql from 'mysql2/promise'
import { GoogleGenerativeAI } from '@google/generative-ai'

const args = process.argv.slice(2)
const write = args.includes('--write')
const ids   = args.filter(a => /^\d+$/.test(a)).map(Number)
if (ids.length === 0) { console.error('pass one or more service_type ids'); process.exit(1) }

const db = await mysql.createConnection({
  host: process.env.DB_HOST, port: Number(process.env.DB_PORT),
  user: process.env.DB_USER, password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME, ssl: { rejectUnauthorized: false },
})

const [services] = await db.query(
  `SELECT id, name, category, description, labour_hours_estimate
   FROM service_types
   WHERE id IN (${ids.map(() => '?').join(',')}) AND is_active = 1`,
  ids,
)
if (services.length === 0) { console.error('no active services matched'); process.exit(1) }

const [partNames] = await db.query(
  'SELECT id, name, category FROM part_names WHERE is_active = 1 ORDER BY category, name',
)

const partsByCat = new Map()
for (const p of partNames) {
  if (!partsByCat.has(p.category)) partsByCat.set(p.category, [])
  partsByCat.get(p.category).push(p)
}
const partsList = [...partsByCat.entries()]
  .map(([cat, arr]) => `[${cat}]\n${arr.map(p => `  ${p.id}: ${p.name}`).join('\n')}`)
  .join('\n\n')
const validPartIds = new Set(partNames.map(p => p.id))

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY ?? '')
const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' })

for (const svc of services) {
  const totalMins = Math.round(Number(svc.labour_hours_estimate) * 60)
  const prompt = `You are an Australian mechanic authoring a mechanic's checklist for a workshop management system.

Service: ${svc.name} (category: ${svc.category})
Description: ${svc.description || '(none)'}
Total labour estimate: ${totalMins} minutes

Break this service down into a step-by-step checklist a mechanic ticks off in order while performing the work. Rules:

1. Order matters — steps run in sequence.
2. Include a pre-service safety/inspection step (is_safety_check: true) and a post-service final check step (is_safety_check: true).
3. Each step's title is short (max ~60 chars) and imperative ("Drain engine oil", not "Draining the oil").
4. Each step's description is 1-2 sentences of practical detail — what to check, what tool, common gotchas. Max 200 chars.
5. estimated_mins should sum to about ${totalMins}. Distribute realistically — safety checks are 3-5min, main work steps 5-15min.
6. is_optional: true only for conditional steps ("top up brake fluid IF low", "replace sump washer IF damaged").
7. parts: for each step, list ONLY the parts the mechanic physically installs/consumes AT THAT STEP — IDs from the catalogue below. Empty array for inspection/labour-only steps.
8. Do NOT invent part_name ids not in the catalogue.

STANDARDISED PART CATALOGUE (grouped by category):
${partsList}

Return a JSON array only, no markdown fences. Schema:
[
  {
    "step_number": 1,
    "title": "Pre-service safety check",
    "description": "Confirm rego, vehicle spec, tyre pressures, lights, wipers, fluid levels. Note any concerns.",
    "estimated_mins": 5,
    "is_optional": false,
    "is_safety_check": true,
    "parts": []
  },
  {
    "step_number": 2,
    "title": "Drain engine oil",
    "description": "Warm engine briefly, position drain pan, remove sump plug. Inspect plug for metal.",
    "estimated_mins": 5,
    "is_optional": false,
    "is_safety_check": false,
    "parts": [{ "part_name_id": 355, "is_optional": true }]
  }
]

Focus on: what a competent AU mechanic actually does in order, not textbook completeness.`

  process.stderr.write(`\n== ${svc.id} ${svc.name} ==\n`)
  const result = await model.generateContent(prompt)
  const text = result.response.text()
  const clean = text.replace(/```(?:json)?/g, '').replace(/```/g, '').trim()
  let steps
  try { steps = JSON.parse(clean) } catch (err) {
    console.error(`  parse failed for service ${svc.id}: ${err.message}`)
    console.error(clean.slice(0, 400))
    continue
  }
  if (!Array.isArray(steps)) { console.error(`  not an array for service ${svc.id}`); continue }

  // Validate + normalise
  const normalised = []
  for (const s of steps) {
    if (!s.title || !s.step_number) continue
    const partsRaw = Array.isArray(s.parts) ? s.parts : []
    const parts = []
    const seenIds = new Set()
    for (const p of partsRaw) {
      const pid = Number(p?.part_name_id)
      if (!Number.isFinite(pid) || !validPartIds.has(pid) || seenIds.has(pid)) continue
      seenIds.add(pid)
      parts.push({ part_name_id: pid, is_optional: !!p.is_optional })
    }
    normalised.push({
      step_number:     Number(s.step_number),
      title:           String(s.title).slice(0, 120),
      description:     s.description ? String(s.description).slice(0, 500) : null,
      estimated_mins:  s.estimated_mins != null ? Math.max(1, Math.min(240, Number(s.estimated_mins))) : null,
      is_optional:     !!s.is_optional,
      is_safety_check: !!s.is_safety_check,
      parts,
    })
  }
  normalised.sort((a, b) => a.step_number - b.step_number)

  // Report to stdout
  console.log(JSON.stringify({ service_type_id: svc.id, service_name: svc.name, steps: normalised }, null, 2))

  if (write) {
    await db.query('DELETE FROM service_type_steps WHERE service_type_id = ?', [svc.id])
    for (const step of normalised) {
      const [ins] = await db.query(
        `INSERT INTO service_type_steps
           (service_type_id, step_number, title, description, estimated_mins, is_optional, is_safety_check)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [svc.id, step.step_number, step.title, step.description, step.estimated_mins, step.is_optional ? 1 : 0, step.is_safety_check ? 1 : 0],
      )
      const stepId = ins.insertId
      for (let i = 0; i < step.parts.length; i++) {
        const p = step.parts[i]
        await db.query(
          `INSERT INTO service_type_step_parts (step_id, part_name_id, is_optional, sort_order)
           VALUES (?, ?, ?, ?)`,
          [stepId, p.part_name_id, p.is_optional ? 1 : 0, i],
        )
      }
    }
    process.stderr.write(`  wrote ${normalised.length} steps for service ${svc.id}\n`)
  }
}

await db.end()
