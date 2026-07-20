// One-shot: seed the initial active prompt version (v1) from the
// currently-hard-coded static persona blocks. Idempotent — bails if a v1
// row already exists.

import 'dotenv/config'
import mysql from 'mysql2/promise'
import {
  ASSISTANT_VALUES,
  ASSISTANT_WORKSHOP_FRAMING,
  ASSISTANT_DIAGNOSIS_FLOW,
  ASSISTANT_SAFETY_RAILS,
  ASSISTANT_IDENTITY,
  ASSISTANT_SELLING_HINT,
  ASSISTANT_EXPENSE_HINT,
  ASSISTANT_COVERAGE_GUIDANCE,
} from '../src/shared/assistantPersona'

// Same block order used by src/customer/vehicles/chats/session-send.ts.
// The dynamic parts (preamble with today/name/vehicleContext, memory
// block, booking flow, hints) stay in code — this seed is the STATIC
// persona body that a human might want to edit.
const BASE_V1 = [
  ASSISTANT_IDENTITY,
  ASSISTANT_VALUES,
  ASSISTANT_WORKSHOP_FRAMING,
  ASSISTANT_COVERAGE_GUIDANCE,
  ASSISTANT_DIAGNOSIS_FLOW,
  ASSISTANT_SAFETY_RAILS,
  ASSISTANT_SELLING_HINT,
  ASSISTANT_EXPENSE_HINT,
].join('\n')

async function main() {
  const conn = await mysql.createConnection({
    host:     process.env.DB_HOST,
    user:     process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: process.env.DB_SSL_REJECT_UNAUTHORIZED === 'false' ? { rejectUnauthorized: false } : undefined,
  } as any)

  try {
    const [existing]: any = await conn.query('SELECT id, version_label FROM prompt_versions LIMIT 1')
    if (existing.length > 0) {
      console.log(`Row already exists (id=${existing[0].id}, label=${existing[0].version_label}). No seed inserted.`)
      return
    }

    // Attribute the seed to the first staff row (Nev, the owner).
    const [staffRows]: any = await conn.query(`SELECT id FROM staff ORDER BY id ASC LIMIT 1`)
    if (staffRows.length === 0) throw new Error('No staff rows exist — cannot attribute the seed.')
    const staffId = staffRows[0].id

    const versionLabel = 'v1-seed'
    await conn.query(
      `INSERT INTO prompt_versions
         (version_label, base_prompt, learned_guidance, notes, source, saved_by, is_active)
       VALUES (?, ?, JSON_ARRAY(), ?, 'manual', ?, 1)`,
      [
        versionLabel,
        BASE_V1,
        'Initial seed from src/shared/assistantPersona.ts static blocks.',
        staffId,
      ],
    )
    console.log(`Seeded ${versionLabel} (${BASE_V1.length} chars) attributed to staff ${staffId}.`)
  } finally {
    await conn.end()
  }
}

main().catch(err => { console.error(err); process.exit(1) })
