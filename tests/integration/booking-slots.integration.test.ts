import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
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

// Canonical seed the file assumes exists. Each test starts from exactly
// this state (nothing extra, seed rows reset to their default times).
const SEED_SLOTS = [
  { time: '08:30:00', end: '09:30:00', label: 'Morning 1', sort: 0 },
  { time: '11:00:00', end: '12:00:00', label: 'Morning 2', sort: 1 },
  { time: '14:00:00', end: '15:00:00', label: 'Afternoon', sort: 2 },
]

async function resetSlotsToSeed() {
  // Full reset — wipe every slot at store 1 and re-seed the three canonical
  // rows. Robust against any ambient DB drift (staff editing via the API,
  // half-cleaned tests from a prior run, etc.).
  await db().query('DELETE FROM store_booking_slots WHERE store_id = ?', [STORE_ID])
  for (const s of SEED_SLOTS) {
    await db().query(
      `INSERT INTO store_booking_slots (store_id, slot_time, end_time, label, sort_order, is_active)
       VALUES (?, ?, ?, ?, ?, 1)`,
      [STORE_ID, s.time, s.end, s.label, s.sort],
    )
  }
}

beforeAll(resetSlotsToSeed)
beforeEach(resetSlotsToSeed)
afterAll(resetSlotsToSeed)

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
    // Each slot carries both time + endTime now
    for (const s of body.slots) {
      expect(s.available).toBe(true)
      expect(typeof s.endTime).toBe('string')
      expect(s.endTime > s.time).toBe(true)
    }
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
  it('creates a slot at a new time with an explicit endTime', async () => {
    const { status, body } = parse(await staffCreateHandler(staffEvent(manager, {
      method: 'POST', path: { id: String(STORE_ID) },
      body: { time: '10:15', endTime: '10:45', label: 'Extra morning', sortOrder: 99, isActive: true },
    })) as any)
    expect(status).toBe(201)
    expect(body.slot.time).toBe('10:15')
    expect(body.slot.endTime).toBe('10:45')
    expect(body.slot.label).toBe('Extra morning')

    const [[row]] = await db().query<any[]>(
      'SELECT slot_time, end_time, label FROM store_booking_slots WHERE store_id = ? AND slot_time = ?',
      [STORE_ID, '10:15:00'],
    )
    expect(row).toBeTruthy()
    const end = row.end_time instanceof Date ? row.end_time.toISOString().slice(11, 16) : String(row.end_time).slice(0, 5)
    expect(end).toBe('10:45')
  })

  it('rejects a duplicate time', async () => {
    const { status, body } = parse(await staffCreateHandler(staffEvent(admin, {
      method: 'POST', path: { id: String(STORE_ID) },
      body: { time: '08:30', endTime: '09:30' },
    })) as any)
    expect(status).toBe(422)
    // Might be flagged as overlap first (08:30 slot exists) — accept either wording.
    expect(body.error.message).toMatch(/already exists|overlaps/)
  })

  it('rejects a slot that overlaps an existing active slot', async () => {
    // 08:30–09:30 already seeded. Try 09:00–10:00 → should overlap.
    const { status, body } = parse(await staffCreateHandler(staffEvent(admin, {
      method: 'POST', path: { id: String(STORE_ID) },
      body: { time: '09:00', endTime: '10:00' },
    })) as any)
    expect(status).toBe(422)
    expect(body.error.message).toMatch(/overlap/)
  })

  it('rejects when endTime <= time', async () => {
    const r = parse(await staffCreateHandler(staffEvent(admin, {
      method: 'POST', path: { id: String(STORE_ID) },
      body: { time: '10:16', endTime: '10:16' },
    })) as any)
    expect(r.status).toBe(422)
    expect(r.body.error.message).toMatch(/endTime must be after time/)
  })

  it('rejects a malformed time', async () => {
    const r = parse(await staffCreateHandler(staffEvent(admin, {
      method: 'POST', path: { id: String(STORE_ID) }, body: { time: '25:99', endTime: '26:00' },
    })) as any)
    expect(r.status).toBe(422)
  })

  it('rejects a missing endTime', async () => {
    const r = parse(await staffCreateHandler(staffEvent(admin, {
      method: 'POST', path: { id: String(STORE_ID) }, body: { time: '10:16' },
    })) as any)
    expect(r.status).toBe(422)
    expect(r.body.error.message).toMatch(/endTime/)
  })

  it('403 for technician', async () => {
    const r = parse(await staffCreateHandler(staffEvent(tech, {
      method: 'POST', path: { id: String(STORE_ID) }, body: { time: '10:16', endTime: '10:46' },
    })) as any)
    expect(r.status).toBe(403)
  })
})

describe('PATCH /stores/{id}/booking-slots/{slotId} (staff update)', () => {
  async function seedTestSlot(time: string, end: string): Promise<number> {
    const [res] = await db().query<any>(
      'INSERT INTO store_booking_slots (store_id, slot_time, end_time, sort_order) VALUES (?, ?, ?, ?)',
      [STORE_ID, `${time}:00`, `${end}:00`, 100],
    )
    return Number(res.insertId)
  }

  it('updates label + isActive', async () => {
    const id = await seedTestSlot('10:17', '10:47')
    const { status, body } = parse(await staffUpdateHandler(staffEvent(admin, {
      method: 'PATCH', path: { id: String(STORE_ID), slotId: String(id) },
      body: { label: 'Special', isActive: false },
    })) as any)
    expect(status).toBe(200)
    expect(body.slot.label).toBe('Special')
    expect(body.slot.isActive).toBe(false)
  })

  it('updates time + endTime together', async () => {
    const id = await seedTestSlot('10:18', '10:48')
    // Pick a target range that fits between the seeded 08:30 and 11:00 slots.
    const { status, body } = parse(await staffUpdateHandler(staffEvent(admin, {
      method: 'PATCH', path: { id: String(STORE_ID), slotId: String(id) },
      body: { time: '10:19', endTime: '10:49' },
    })) as any)
    expect(status).toBe(200)
    expect(body.slot.time).toBe('10:19')
    expect(body.slot.endTime).toBe('10:49')
  })

  it('rejects a patch where new endTime <= new time', async () => {
    const id = await seedTestSlot('10:15', '10:45')
    const r = parse(await staffUpdateHandler(staffEvent(admin, {
      method: 'PATCH', path: { id: String(STORE_ID), slotId: String(id) },
      body: { endTime: '10:15' },
    })) as any)
    expect(r.status).toBe(422)
    expect(r.body.error.message).toMatch(/endTime must be after time/)
  })

  it('rejects a patch that overlaps another active slot', async () => {
    const id = await seedTestSlot('10:15', '10:45')
    // Try to widen it to 08:00–11:00 which would overlap the 08:30 seed
    const r = parse(await staffUpdateHandler(staffEvent(admin, {
      method: 'PATCH', path: { id: String(STORE_ID), slotId: String(id) },
      body: { time: '08:00', endTime: '11:00' },
    })) as any)
    expect(r.status).toBe(422)
    expect(r.body.error.message).toMatch(/overlap/)
  })

  it('allows a patch that would overlap when deactivating (is_active=false skips the check)', async () => {
    const id = await seedTestSlot('10:16', '10:46')
    const r = parse(await staffUpdateHandler(staffEvent(admin, {
      method: 'PATCH', path: { id: String(STORE_ID), slotId: String(id) },
      body: { time: '08:00', endTime: '11:00', isActive: false },
    })) as any)
    expect(r.status).toBe(200)
    expect(r.body.slot.isActive).toBe(false)
  })

  it('404s when the slot belongs to another store', async () => {
    const id = await seedTestSlot('10:15', '10:45')
    const r = parse(await staffUpdateHandler(staffEvent(admin, {
      method: 'PATCH', path: { id: '99', slotId: String(id) }, body: { label: 'x' },
    })) as any)
    expect([403, 404]).toContain(r.status)
  })
})

describe('DELETE /stores/{id}/booking-slots/{slotId}', () => {
  it('hard-deletes the slot', async () => {
    const [res] = await db().query<any>(
      'INSERT INTO store_booking_slots (store_id, slot_time, end_time) VALUES (?, ?, ?)',
      [STORE_ID, '10:15:00', '10:45:00'],
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
