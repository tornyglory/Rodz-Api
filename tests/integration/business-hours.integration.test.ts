import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { handler as hoursHandler } from '../../src/stores/business-hours'
import { staffEvent, parse } from '../_setup/apigw'
import { db } from '../_setup/db'

// Tests use store 1. Snapshot the 7 business_hours rows before each test
// and restore after so we can freely mutate them.
const STORE_ID = 1
let snapshot: any[] = []

async function snapAll() {
  const [rows] = await db().query<any[]>(
    'SELECT * FROM business_hours WHERE store_id = ? ORDER BY day_of_week', [STORE_ID],
  )
  return rows
}

async function restore() {
  await db().query('DELETE FROM business_hours WHERE store_id = ?', [STORE_ID])
  for (const r of snapshot) {
    await db().query(
      `INSERT INTO business_hours (id, store_id, day_of_week, open_time, close_time, is_closed, last_booking_offset_mins, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [r.id, r.store_id, r.day_of_week, r.open_time, r.close_time, r.is_closed, r.last_booking_offset_mins, r.notes],
    )
  }
}

beforeEach(async () => { snapshot = await snapAll() })
afterAll(async () => { await restore() })

const admin   = { staffId: '1', role: 'super_admin' as const, storeId: 1 }
const manager = { staffId: '3', role: 'store_manager' as const, storeId: 1 }
const otherManager = { staffId: '9', role: 'store_manager' as const, storeId: 2 }
const tech    = { staffId: '6', role: 'technician' as const, storeId: 1 }

describe('GET /stores/{id}/business-hours', () => {
  it('returns all 7 days for the store', async () => {
    const { status, body } = parse(await hoursHandler(staffEvent(admin, {
      path: { id: String(STORE_ID) },
    })) as any)
    expect(status).toBe(200)
    expect(body.hours).toHaveLength(7)
    const days = body.hours.map((h: any) => h.dayOfWeek).sort()
    expect(days).toEqual([0, 1, 2, 3, 4, 5, 6])
  })

  it('403s a technician', async () => {
    const r = parse(await hoursHandler(staffEvent(tech, { path: { id: String(STORE_ID) } })) as any)
    expect(r.status).toBe(403)
  })

  it('403s a manager viewing another store', async () => {
    const r = parse(await hoursHandler(staffEvent(otherManager, { path: { id: String(STORE_ID) } })) as any)
    expect(r.status).toBe(403)
  })
})

describe('PATCH /stores/{id}/business-hours', () => {
  it('updates one day\'s hours', async () => {
    const { status, body } = parse(await hoursHandler(staffEvent(manager, {
      method: 'PATCH', path: { id: String(STORE_ID) },
      body: { dayOfWeek: 3, openTime: '09:00', closeTime: '18:00', isClosed: false, lastBookingOffsetMins: 30 },
    })) as any)
    expect(status).toBe(200)
    expect(body.hours.dayOfWeek).toBe(3)
    expect(body.hours.openTime).toBe('09:00')
    expect(body.hours.closeTime).toBe('18:00')
    expect(body.hours.lastBookingOffsetMins).toBe(30)

    const [[row]] = await db().query<any[]>(
      'SELECT open_time, close_time, last_booking_offset_mins FROM business_hours WHERE store_id = ? AND day_of_week = 3', [STORE_ID],
    )
    // MySQL TIME comes back as HH:MM:SS or as a Date depending on driver config
    const open = row.open_time instanceof Date ? row.open_time.toISOString().slice(11, 16) : String(row.open_time).slice(0, 5)
    expect(open).toBe('09:00')
    expect(Number(row.last_booking_offset_mins)).toBe(30)
  })

  it('marks a day as closed', async () => {
    const { status, body } = parse(await hoursHandler(staffEvent(admin, {
      method: 'PATCH', path: { id: String(STORE_ID) },
      body: { dayOfWeek: 6, isClosed: true },
    })) as any)
    expect(status).toBe(200)
    expect(body.hours.isClosed).toBe(true)
  })

  it('rejects a bad dayOfWeek', async () => {
    const r = parse(await hoursHandler(staffEvent(admin, {
      method: 'PATCH', path: { id: String(STORE_ID) },
      body: { dayOfWeek: 7 },
    })) as any)
    expect(r.status).toBe(422)
  })

  it('rejects a bad time format', async () => {
    const r = parse(await hoursHandler(staffEvent(admin, {
      method: 'PATCH', path: { id: String(STORE_ID) },
      body: { dayOfWeek: 1, openTime: 'noon' },
    })) as any)
    expect(r.status).toBe(422)
  })

  it('rejects an out-of-range offset', async () => {
    const r = parse(await hoursHandler(staffEvent(admin, {
      method: 'PATCH', path: { id: String(STORE_ID) },
      body: { dayOfWeek: 1, lastBookingOffsetMins: 999 },
    })) as any)
    expect(r.status).toBe(422)
  })

  it('403s a technician on PATCH', async () => {
    const r = parse(await hoursHandler(staffEvent(tech, {
      method: 'PATCH', path: { id: String(STORE_ID) },
      body: { dayOfWeek: 3, openTime: '09:00' },
    })) as any)
    expect(r.status).toBe(403)
  })
})
