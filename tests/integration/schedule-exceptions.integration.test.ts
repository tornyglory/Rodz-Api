import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { handler as exceptionsHandler }        from '../../src/stores/schedule-exceptions'
import { handler as customerAvailabilityHandler } from '../../src/customer/stores/booking-slots'
import { customerEvent, staffEvent, parse } from '../_setup/apigw'
import { db } from '../_setup/db'

const STORE_ID    = 1
const CUSTOMER_ID = 3

// Test rows use dates far in the future to avoid colliding with real data.
const TEST_YEAR = '2099'
const testDate = (mm: string, dd: string) => `${TEST_YEAR}-${mm}-${dd}`

async function purge() {
  await db().query(
    'DELETE FROM store_schedule_exceptions WHERE store_id = ? AND date >= ?',
    [STORE_ID, `${TEST_YEAR}-01-01`],
  )
}

beforeEach(async () => { await purge() })
afterAll(async () => { await purge() })

const admin   = { staffId: '1', role: 'super_admin' as const, storeId: 1 }
const manager = { staffId: '3', role: 'store_manager' as const, storeId: 1 }
const otherManager = { staffId: '9', role: 'store_manager' as const, storeId: 2 }
const tech    = { staffId: '6', role: 'technician' as const, storeId: 1 }

describe('POST /stores/{id}/schedule-exceptions', () => {
  it('creates a closure day', async () => {
    const { status, body } = parse(await exceptionsHandler(staffEvent(manager, {
      method: 'POST', path: { id: String(STORE_ID) },
      body: { date: testDate('12', '25'), isClosed: true, reason: 'Christmas Day' },
    })) as any)
    expect(status).toBe(201)
    expect(body.exception.date).toBe(testDate('12', '25'))
    expect(body.exception.isClosed).toBe(true)
    expect(body.exception.reason).toBe('Christmas Day')
    expect(body.exception.openTime).toBeNull()
    expect(body.exception.closeTime).toBeNull()
  })

  it('creates a custom-hours day', async () => {
    const { status, body } = parse(await exceptionsHandler(staffEvent(admin, {
      method: 'POST', path: { id: String(STORE_ID) },
      body: { date: testDate('12', '24'), isClosed: false, openTime: '09:00', closeTime: '13:00', reason: 'Christmas Eve' },
    })) as any)
    expect(status).toBe(201)
    expect(body.exception.isClosed).toBe(false)
    expect(body.exception.openTime).toBe('09:00')
    expect(body.exception.closeTime).toBe('13:00')
  })

  it('requires openTime + closeTime when isClosed is false', async () => {
    const r = parse(await exceptionsHandler(staffEvent(admin, {
      method: 'POST', path: { id: String(STORE_ID) },
      body: { date: testDate('06', '15'), isClosed: false },
    })) as any)
    expect(r.status).toBe(422)
    expect(r.body.error.message).toMatch(/openTime required/)
  })

  it('rejects a duplicate date', async () => {
    await exceptionsHandler(staffEvent(admin, {
      method: 'POST', path: { id: String(STORE_ID) },
      body: { date: testDate('01', '02'), reason: 'first' },
    }))
    const r = parse(await exceptionsHandler(staffEvent(admin, {
      method: 'POST', path: { id: String(STORE_ID) },
      body: { date: testDate('01', '02'), reason: 'second' },
    })) as any)
    expect(r.status).toBe(422)
    expect(r.body.error.message).toMatch(/already exists/)
  })

  it('403s a technician', async () => {
    const r = parse(await exceptionsHandler(staffEvent(tech, {
      method: 'POST', path: { id: String(STORE_ID) }, body: { date: testDate('01', '01') },
    })) as any)
    expect(r.status).toBe(403)
  })
})

describe('GET /stores/{id}/schedule-exceptions', () => {
  it('lists exceptions in a date range', async () => {
    for (const dd of ['01', '02', '03']) {
      await exceptionsHandler(staffEvent(admin, {
        method: 'POST', path: { id: String(STORE_ID) },
        body: { date: testDate('01', dd), reason: `Day ${dd}` },
      }))
    }
    const { status, body } = parse(await exceptionsHandler(staffEvent(admin, {
      path: { id: String(STORE_ID) },
      query: { from: `${TEST_YEAR}-01-01`, to: `${TEST_YEAR}-01-31` },
    })) as any)
    expect(status).toBe(200)
    expect(body.exceptions.length).toBe(3)
  })
})

describe('PATCH /stores/{id}/schedule-exceptions/{excId}', () => {
  it('updates an existing row', async () => {
    const create = parse(await exceptionsHandler(staffEvent(admin, {
      method: 'POST', path: { id: String(STORE_ID) },
      body: { date: testDate('04', '25'), reason: 'ANZAC Day' },
    })) as any)
    const id = create.body.exception.id

    const { status, body } = parse(await exceptionsHandler(staffEvent(admin, {
      method: 'PATCH', path: { id: String(STORE_ID), excId: String(id) },
      body: { reason: 'ANZAC Day (updated)' },
    })) as any)
    expect(status).toBe(200)
    expect(body.exception.reason).toBe('ANZAC Day (updated)')
  })

  it('404 on unknown id', async () => {
    const r = parse(await exceptionsHandler(staffEvent(admin, {
      method: 'PATCH', path: { id: String(STORE_ID), excId: '9999999' }, body: { reason: 'x' },
    })) as any)
    expect(r.status).toBe(404)
  })
})

describe('DELETE /stores/{id}/schedule-exceptions/{excId}', () => {
  it('removes the row', async () => {
    const create = parse(await exceptionsHandler(staffEvent(admin, {
      method: 'POST', path: { id: String(STORE_ID) },
      body: { date: testDate('05', '01') },
    })) as any)
    const id = create.body.exception.id

    const del = parse(await exceptionsHandler(staffEvent(admin, {
      method: 'DELETE', path: { id: String(STORE_ID), excId: String(id) },
    })) as any)
    expect(del.status).toBe(200)

    const [[row]] = await db().query<any[]>('SELECT id FROM store_schedule_exceptions WHERE id = ?', [id])
    expect(row).toBeUndefined()
  })
})

describe('availability integration with exceptions', () => {
  // Pick a Wednesday in the far-future year (2099-01-07 is a Wednesday)
  const wed = '2099-01-07'

  it('marks the whole day closed when an exception says is_closed=1', async () => {
    await exceptionsHandler(staffEvent(admin, {
      method: 'POST', path: { id: String(STORE_ID) },
      body: { date: wed, isClosed: true, reason: 'Staff training' },
    }))
    const { body } = parse(await customerAvailabilityHandler(customerEvent(CUSTOMER_ID, {
      path: { id: String(STORE_ID) }, query: { date: wed },
    })) as any)
    expect(body.storeOpen).toBe(false)
    expect(body.reason).toBe('closed_exception')
    expect(body.exceptionReason).toBe('Staff training')
    for (const s of body.slots) expect(s.available).toBe(false)
  })

  it('respects custom open/close on a special-hours day', async () => {
    // Custom hours 09:00–11:30 — only the 08:30 slot ends before 11:30 – offset(60) = 10:30 cutoff
    await exceptionsHandler(staffEvent(admin, {
      method: 'POST', path: { id: String(STORE_ID) },
      body: { date: wed, isClosed: false, openTime: '09:00', closeTime: '11:30' },
    }))
    const { body } = parse(await customerAvailabilityHandler(customerEvent(CUSTOMER_ID, {
      path: { id: String(STORE_ID) }, query: { date: wed },
    })) as any)
    expect(body.storeOpen).toBe(true)
    // 08:30 is before 09:00 open — unavailable
    const morning1 = body.slots.find((s: any) => s.time === '08:30')
    expect(morning1?.available).toBe(false)
    // 11:00 is inside window but starts less than 60 min before close (11:30)
    const morning2 = body.slots.find((s: any) => s.time === '11:00')
    expect(morning2?.available).toBe(false)
    // 14:00 is after close — unavailable
    const afternoon = body.slots.find((s: any) => s.time === '14:00')
    expect(afternoon?.available).toBe(false)
  })
})
