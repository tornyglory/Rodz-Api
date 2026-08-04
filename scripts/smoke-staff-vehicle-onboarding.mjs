// Smoke test — staff vehicle onboarding end-to-end against prod.
// Hits POST /customers/3/vehicles + GET recommendations, then cleans up.

import jwt from 'jsonwebtoken'
import mysql from 'mysql2/promise'
import 'dotenv/config'

const API = 'https://fzzrkscwd7.execute-api.ap-southeast-2.amazonaws.com'
const CUSTOMER_ID = 3
const VEHICLE_ID  = 4  // existing Corolla on customer 3, store 5
const REGO        = 'SMKST1'

const admin   = jwt.sign({ sub: '1', role: 'super_admin',   storeId: 1, permissions: [] }, process.env.JWT_SECRET, { expiresIn: '5m' })
const manager = jwt.sign({ sub: '3', role: 'store_manager', storeId: 5, permissions: [] }, process.env.JWT_SECRET, { expiresIn: '5m' })
const tech    = jwt.sign({ sub: '6', role: 'technician',    storeId: 1, permissions: [] }, process.env.JWT_SECRET, { expiresIn: '5m' })

let pass = 0, fail = 0
const check = (label, cond, extra = '') => {
  if (cond) { console.log(`  ✓ ${label}`); pass++ }
  else      { console.log(`  ✗ ${label} ${extra}`); fail++ }
}

async function api(method, path, token, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch {}
  return { status: res.status, json, text }
}

async function purge(db) {
  const [rows] = await db.query('SELECT id FROM vehicles WHERE rego = ?', [REGO])
  const ids = rows.map(r => r.id)
  if (!ids.length) return
  const ph = ids.map(() => '?').join(',')
  await db.query(`DELETE FROM vehicle_owners WHERE vehicle_id IN (${ph})`, ids)
  await db.query(`DELETE FROM vehicles       WHERE id         IN (${ph})`, ids)
}

async function main() {
  const db = await mysql.createConnection({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT),
    user: process.env.DB_USER, password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME, ssl: { rejectUnauthorized: false },
  })
  await purge(db)

  console.log('\n── Staff vehicle onboarding smoke ──\n')

  // 1. Create
  console.log('[1] POST /customers/3/vehicles (admin)')
  const c = await api('POST', `/customers/${CUSTOMER_ID}/vehicles`, admin, {
    rego: REGO, year: 2020, make: 'Toyota', model: 'Corolla', odometerCurrent: 42000, avgKmPerWeek: 240,
  })
  check('status 201', c.status === 201, `got ${c.status}: ${c.text.slice(0, 200)}`)
  const v = c.json?.vehicle
  check('vehicle.id > 0', typeof v?.id === 'number' && v.id > 0, `id=${v?.id}`)
  check('logbookToken is 64-char hex', /^[a-f0-9]{64}$/.test(v?.logbookToken ?? ''), `token=${v?.logbookToken}`)
  check('full-shape rego matches', v?.rego === REGO)
  check('year/make/model persisted', v?.year === 2020 && v?.make === 'Toyota' && v?.model === 'Corolla')
  check('publicProfileSettings present', v?.publicProfileSettings !== undefined)

  // 2. Tech gets 403
  console.log('\n[2] POST /customers/3/vehicles (technician)')
  const t = await api('POST', `/customers/${CUSTOMER_ID}/vehicles`, tech, {
    rego: 'SMKST2', year: 2020, make: 'Toyota', model: 'Corolla',
  })
  check('status 403', t.status === 403, `got ${t.status}: ${t.text.slice(0, 120)}`)

  // 3. Duplicate rego
  console.log('\n[3] POST duplicate rego')
  const d = await api('POST', `/customers/${CUSTOMER_ID}/vehicles`, admin, {
    rego: REGO, year: 2019, make: 'Mazda', model: '3',
  })
  check('status 409', d.status === 409, `got ${d.status}`)
  check('code DUPLICATE_REGO', d.json?.error?.code === 'DUPLICATE_REGO')

  // 4. Recommendations — admin, real vehicle
  console.log('\n[4] GET recommendations (admin, real vehicle)')
  const r1 = await api('GET', `/customers/${CUSTOMER_ID}/vehicles/${VEHICLE_ID}/recommendations`, admin)
  check('status 200', r1.status === 200, `got ${r1.status}: ${r1.text.slice(0, 160)}`)
  check('recommendations is array', Array.isArray(r1.json?.recommendations))

  // 5. Recommendations — manager (same store 5)
  console.log('\n[5] GET recommendations (store_manager, store 5)')
  const r2 = await api('GET', `/customers/${CUSTOMER_ID}/vehicles/${VEHICLE_ID}/recommendations`, manager)
  check('status 200 (Number() coercion fix)', r2.status === 200, `got ${r2.status}: ${r2.text.slice(0, 160)}`)

  // 6. Cross-customer 404
  console.log('\n[6] GET recommendations (cross-customer)')
  const r3 = await api('GET', `/customers/2/vehicles/${VEHICLE_ID}/recommendations`, admin)
  check('status 404', r3.status === 404, `got ${r3.status}`)

  // 7. Nonexistent vehicle 404
  console.log('\n[7] GET recommendations (nonexistent vehicle)')
  const r4 = await api('GET', `/customers/${CUSTOMER_ID}/vehicles/99999999/recommendations`, admin)
  check('status 404', r4.status === 404, `got ${r4.status}`)

  await purge(db)
  await db.end()

  console.log(`\n── ${pass} passed, ${fail} failed ──\n`)
  process.exit(fail ? 1 : 0)
}

main().catch(err => { console.error(err); process.exit(1) })
