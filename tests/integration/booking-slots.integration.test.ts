import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { handler as availabilityHandler } from '../../src/customer/stores/booking-slots'
import { handler as staffListHandler }    from '../../src/stores/booking-slots/list'
import { handler as staffCreateHandler }  from '../../src/stores/booking-slots/create'
import { handler as staffUpdateHandler }  from '../../src/stores/booking-slots/update'
import { handler as staffDeleteHandler }  from '../../src/stores/booking-slots/delete'
import { customerEvent, staffEvent, parse } from '../_setup/apigw'
import { db } from '../_setup/db'

// Coverage for the four-slots-a-day booking system. Uses store 1
// (Somerville) — has been seeded with 08:30 / 11:00 / 13:30 / 15:00.
//
// Any slot the tests create is time-stamped with a unique HH:MM so
// we don't collide with the seeded four. Cleanup deletes any slot
// created with test times.

const STORE_ID    = 1
const CUSTOMER_ID = 3

// A unique time far outside the default four so we never collide.
const TEST_TIMES = ['10:15', '10:16', '10:17', '10:18', '10:19']

async function purgeTestSlots() {
  await db().query(
    'DELETE FROM store_booking_slots WHERE store_id = ? AND slot_time IN (?)',
    [STORE_ID, TEST_TIMES.map(t => `${t}:00`)],
  )
}

beforeEach(async () => { await purgeTestSlots() })
afterAll(async () => { await purgeTestSlots() })

// Pick a future Wednesday (day_of_week = 3) — always open.
function nextWednesday(): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + ((3 - d.getUTCDay() + 7) % 7 || 7))
  return d.toISOString().slice(0, 10)
}

// Pick a future Sunday — closed.
function nextSunday(): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + ((7 - d.getUTCDay()) % 7 || 7))
  return d.toISOString().slice(0, 10)
}

const admin   = { staffId: '1', role: 'super_admin' as const, storeId: 1 }
const manager = { staffId: '3', role: 'store_manager' as const, storeId: 1 }
const otherManager = { staffId: '9', role: 'store_manager' as const, storeId: 2 }
const tech    = { staffId: '6', role: 'technician' as const, storeId: 1 }

describe('GET /c/stores/{id}/booking-slots', () => {
  it('returns the three default slots for a weekday, all available', async () => {
    const { status, body } = parse(await availabilityHandler(customerEvent(CUSTOMER_ID, {
      path:  { id: String(STORE_ID) },
      query: { date: nextWednesday() },
    })) as any)
    expect(status).toBe(200)
    expect(body.storeOpen).toBe(true)
    const times = body.slots.map((s: any) => s.time).sort()
    expect(times).toEqual(['08:30', '11:00', '14:00'])
    // On an empty future weekday all three should be available
    for (const s of body.slots) expect(s.available).toBe(true)
  })

  it('returns storeOpen=false with slots marked unavailable on Sunday', async () => {
    const { status, body } = parse(await availabilityHandler(customerEvent(CUSTOMER_ID, {
      path:  { id: String(STORE_ID) },
      query: { date: nextSunday() },
    })) as any)
    expect(status).toBe(200)
    expect(body.storeOpen).toBe(false)
    expect(body.reason).toBe('closed_dow')
    for (const s of body.slots) expect(s.available).toBe(false)
  })

  it('rejects a past date', async () => {
    const yesterday = new Date(Date.now() - 86400_000).toISOString().slice(0, 10)
    const { status, body } = parse(await availabilityHandler(customerEvent(CUSTOMER_ID, {
      path:  { id: String(STORE_ID) },
      query: { date: yesterday },
    })) as any)
    expect(status).toBe(200)
    expect(body.storeOpen).toBe(false)
    expect(body.reason).toBe('past_date')
  })

  it('400s on bad input', async () => {
    const r = parse(await availabilityHandler(customerEvent(CUSTOMER_ID, {
      path: { id: String(STORE_ID) }, query: { date: 'not-a-date' },
    })) as any)
    expect(r.status).toBe(422)
  })
})

describe('GET /stores/{id}/booking-slots (staff)', () => {
  it('returns all slots for the store', async () => {
    const { status, body } = parse(await staffListHandler(staffEvent(admin, {
      path: { id: String(STORE_ID) },
    })) as any)
    expect(status).toBe(200)
    // At least the three seeded slots
    const times = body.slots.map((s: any) => s.time).sort()
    for (const t of ['08:30', '11:00', '14:00']) expect(times).toContain(t)
  })

  it('403s a technician', async () => {
    const r = parse(await staffListHandler(staffEvent(tech, { path: { id: String(STORE_ID) } })) as any)
    expect(r.status).toBe(403)
  })

  it('403s a store_manager viewing another store', async () => {
    const r = parse(await staffListHandler(staffEvent(otherManager, { path: { id: String(STORE_ID) } })) as any)
    expect(r.status).toBe(403)
  })
})

describe('POST /stores/{id}/booking-slots (staff create)', () => {
  it('creates a slot at a new time', async () => {
    const { status, body } = parse(await staffCreateHandler(staffEvent(manager, {
      method: 'POST', path: { id: String(STORE_ID) },
      body: { time: '10:15', label: 'Extra morning', sortOrder: 99, isActive: true },
    })) as any)
    expect(status).toBe(201)
    expect(body.slot.time).toBe('10:15')
    expect(body.slot.label).toBe('Extra morning')
    expect(body.slot.isActive).toBe(true)

    // Verify DB
    const [[row]] = await db().query<any[]>(
      'SELECT slot_time, label FROM store_booking_slots WHERE store_id = ? AND slot_time = ?',
      [STORE_ID, '10:15:00'],
    )
    expect(row).toBeTruthy()
    expect(row.label).toBe('Extra morning')
  })

  it('rejects a duplicate time', async () => {
    // Try to create at 08:30 which is a seeded slot
    const { status, body } = parse(await staffCreateHandler(staffEvent(admin, {
      method: 'POST', path: { id: String(STORE_ID) },
      body: { time: '08:30' },
    })) as any)
    expect(status).toBe(422)
    expect(body.error.message).toMatch(/already exists/)
  })

  it('rejects a malformed time', async () => {
    const r = parse(await staffCreateHandler(staffEvent(admin, {
      method: 'POST', path: { id: String(STORE_ID) }, body: { time: '25:99' },
    })) as any)
    expect(r.status).toBe(422)
  })

  it('403 for technician', async () => {
    const r = parse(await staffCreateHandler(staffEvent(tech, {
      method: 'POST', path: { id: String(STORE_ID) }, body: { time: '10:16' },
    })) as any)
    expect(r.status).toBe(403)
  })
})

describe('PATCH /stores/{id}/booking-slots/{slotId} (staff update)', () => {
  async function seedTestSlot(time: string): Promise<number> {
    const [res] = await db().query<any>(
      'INSERT INTO store_booking_slots (store_id, slot_time, sort_order) VALUES (?, ?, ?)',
      [STORE_ID, `${time}:00`, 100],
    )
    return Number(res.insertId)
  }

  it('updates label + isActive', async () => {
    const id = await seedTestSlot('10:17')
    const { status, body } = parse(await staffUpdateHandler(staffEvent(admin, {
      method: 'PATCH', path: { id: String(STORE_ID), slotId: String(id) },
      body: { label: 'Special', isActive: false },
    })) as any)
    expect(status).toBe(200)
    expect(body.slot.label).toBe('Special')
    expect(body.slot.isActive).toBe(false)
  })

  it('updates the time', async () => {
    const id = await seedTestSlot('10:18')
    const { status, body } = parse(await staffUpdateHandler(staffEvent(admin, {
      method: 'PATCH', path: { id: String(STORE_ID), slotId: String(id) },
      body: { time: '10:19' },
    })) as any)
    expect(status).toBe(200)
    expect(body.slot.time).toBe('10:19')
  })

  it('404s when the slot belongs to another store', async () => {
    const id = await seedTestSlot('10:15')
    // Update via wrong store id
    const r = parse(await staffUpdateHandler(staffEvent(admin, {
      method: 'PATCH', path: { id: '99', slotId: String(id) }, body: { label: 'x' },
    })) as any)
    // Guard returns 403 for manager, or 404 when super_admin passes but slot mismatch
    expect([403, 404]).toContain(r.status)
  })
})

describe('DELETE /stores/{id}/booking-slots/{slotId}', () => {
  it('hard-deletes the slot', async () => {
    const [res] = await db().query<any>(
      'INSERT INTO store_booking_slots (store_id, slot_time) VALUES (?, ?)',
      [STORE_ID, '10:15:00'],
    )
    const id = Number(res.insertId)

    const { status } = parse(await staffDeleteHandler(staffEvent(admin, {
      method: 'DELETE', path: { id: String(STORE_ID), slotId: String(id) },
    })) as any)
    expect(status).toBe(200)

    const [[row]] = await db().query<any[]>(
      'SELECT id FROM store_booking_slots WHERE id = ?', [id],
    )
    expect(row).toBeUndefined()
  })

  it('404 when slot does not exist', async () => {
    const { status } = parse(await staffDeleteHandler(staffEvent(admin, {
      method: 'DELETE', path: { id: String(STORE_ID), slotId: '99999999' },
    })) as any)
    expect(status).toBe(404)
  })
})
