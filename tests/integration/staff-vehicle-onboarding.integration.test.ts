import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { handler as createHandler }          from '../../src/customers/vehicles/create'
import { handler as recommendationsHandler } from '../../src/customers/vehicles/recommendations'
import { staffEvent, parse } from '../_setup/apigw'
import { db } from '../_setup/db'

// Backend contract for the workshop-side "add vehicle" wizard.
//
// Verifies:
//   • POST /customers/{id}/vehicles returns a logbookToken (unlocks
//     the AI-profile step: /logbook/{token}/profile).
//   • Response is the full vehicle shape (matches staff GET /vehicles/:id)
//     — not the sparse { id, rego, year, make, model } we had before.
//   • GET /customers/{cid}/vehicles/{vid}/recommendations works and
//     enforces the role guard + cross-customer 404.
//
// Uses customer 3 (nev@qubestudio.co.nz) with a test-only rego. Cleanup
// removes the created vehicle + owner link but leaves the customer
// untouched (real dev customer).

const CUSTOMER_ID  = 3
const OTHER_CUST   = 2
const TEST_REGO    = 'STAFFT'

async function purge() {
  const [rows] = await db().query<any[]>('SELECT id FROM vehicles WHERE rego = ?', [TEST_REGO])
  const ids = rows.map(r => r.id)
  if (!ids.length) return
  const ph = ids.map(() => '?').join(',')
  await db().query(`DELETE FROM vehicle_owners WHERE vehicle_id IN (${ph})`, ids)
  await db().query(`DELETE FROM vehicles       WHERE id         IN (${ph})`, ids)
}

afterEach(purge)
afterAll(purge)

// Customer 3 lives at store 5. Manager needs matching storeId to pass
// the same-store guard on the recommendations endpoint.
const admin   = { staffId: '1', role: 'super_admin'   as const, storeId: 1 }
const manager = { staffId: '3', role: 'store_manager' as const, storeId: 5 }
const tech    = { staffId: '6', role: 'technician'    as const, storeId: 1 }

describe('POST /customers/{id}/vehicles (staff create)', () => {
  it('returns logbookToken + full vehicle shape', async () => {
    const { status, body } = parse(await createHandler(staffEvent(admin, {
      method: 'POST', path: { id: String(CUSTOMER_ID) },
      body: { rego: TEST_REGO, year: 2020, make: 'Toyota', model: 'Corolla' },
    })) as any)

    expect(status).toBe(201)
    expect(body.vehicle).toBeDefined()
    expect(body.vehicle.rego).toBe(TEST_REGO)
    // The wizard needs these to work:
    expect(typeof body.vehicle.logbookToken).toBe('string')
    expect(body.vehicle.logbookToken).toMatch(/^[a-f0-9]{64}$/)   // 32 bytes hex
    expect(body.vehicle.id).toBeGreaterThan(0)
    // Full-shape spot-checks (loadVehicleForResponse output):
    expect(body.vehicle.year).toBe(2020)
    expect(body.vehicle.make).toBe('Toyota')
    expect(body.vehicle.model).toBe('Corolla')
    expect(body.vehicle.publicProfileSettings).toBeDefined()

    // DB truth — token was persisted, not just returned in memory.
    const [[row]] = await db().query<any[]>(
      'SELECT logbook_token FROM vehicles WHERE id = ?',
      [body.vehicle.id],
    )
    expect(row.logbook_token).toBe(body.vehicle.logbookToken)
  })

  it('accepts odometerCurrent + avgKmPerWeek anchors for the maintenance manager', async () => {
    const { body } = parse(await createHandler(staffEvent(admin, {
      method: 'POST', path: { id: String(CUSTOMER_ID) },
      body: { rego: TEST_REGO, year: 2020, make: 'Toyota', model: 'Corolla', odometerCurrent: 85000, avgKmPerWeek: 240 },
    })) as any)

    const [[row]] = await db().query<any[]>(
      'SELECT odometer_current, avg_km_per_week, odometer_recorded_at FROM vehicles WHERE id = ?',
      [body.vehicle.id],
    )
    expect(Number(row.odometer_current)).toBe(85000)
    expect(Number(row.avg_km_per_week)).toBe(240)
    expect(row.odometer_recorded_at).not.toBeNull()
  })

  it('403s a technician', async () => {
    const { status } = parse(await createHandler(staffEvent(tech, {
      method: 'POST', path: { id: String(CUSTOMER_ID) },
      body: { rego: TEST_REGO, year: 2020, make: 'Toyota', model: 'Corolla' },
    })) as any)
    expect(status).toBe(403)
  })

  it('rejects duplicate rego with 409', async () => {
    const first = parse(await createHandler(staffEvent(admin, {
      method: 'POST', path: { id: String(CUSTOMER_ID) },
      body: { rego: TEST_REGO, year: 2020, make: 'Toyota', model: 'Corolla' },
    })) as any)
    expect(first.status).toBe(201)

    const dup = parse(await createHandler(staffEvent(admin, {
      method: 'POST', path: { id: String(OTHER_CUST) },
      body: { rego: TEST_REGO, year: 2019, make: 'Mazda', model: '3' },
    })) as any)
    expect(dup.status).toBe(409)
    expect(dup.body.error.code).toBe('DUPLICATE_REGO')
  })
})

describe('GET /customers/{cid}/vehicles/{vid}/recommendations (staff)', () => {
  it('returns 200 + recommendations array for a real vehicle owned by the customer', async () => {
    // Use vehicle 4 (Corolla, HUT665) which belongs to customer 3.
    const { status, body } = parse(await recommendationsHandler(staffEvent(admin, {
      path: { customerId: String(CUSTOMER_ID), vehicleId: '4' },
    })) as any)
    expect(status).toBe(200)
    expect(Array.isArray(body.recommendations)).toBe(true)
    // Each row (if any) carries the expected keys.
    for (const r of body.recommendations) {
      expect(typeof r.id).toBe('number')
      expect(typeof r.title).toBe('string')
      // ai_recommendations.urgency enum: advisory | recommended | important | urgent.
      expect(['advisory', 'recommended', 'important', 'urgent']).toContain(r.urgency)
    }
  })

  it('404s when the vehicle doesn\'t belong to the customer', async () => {
    // vehicle 4 belongs to customer 3, not customer 2.
    const { status } = parse(await recommendationsHandler(staffEvent(admin, {
      path: { customerId: String(OTHER_CUST), vehicleId: '4' },
    })) as any)
    expect(status).toBe(404)
  })

  it('404s a nonexistent vehicle (not 403 — don\'t leak existence)', async () => {
    const { status } = parse(await recommendationsHandler(staffEvent(admin, {
      path: { customerId: String(CUSTOMER_ID), vehicleId: '99999999' },
    })) as any)
    expect(status).toBe(404)
  })

  it('accessible to store_manager for their own store', async () => {
    const { status } = parse(await recommendationsHandler(staffEvent(manager, {
      path: { customerId: String(CUSTOMER_ID), vehicleId: '4' },
    })) as any)
    expect(status).toBe(200)
  })
})
