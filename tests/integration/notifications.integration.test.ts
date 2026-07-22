import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { handler as listHandler }        from '../../src/customer/notifications/list'
import { handler as unreadCountHandler } from '../../src/customer/notifications/unread-count'
import { handler as markReadHandler }    from '../../src/customer/notifications/mark-read'
import { handler as markAllReadHandler } from '../../src/customer/notifications/mark-all-read'
import { customerEvent, parse } from '../_setup/apigw'
import { db, insertTestNotification, purgeAllTestNotifications, testEventId } from '../_setup/db'

// End-to-end coverage for the customer portal notification centre.
// Same behaviour we proved manually against deployed Lambdas — now
// asserted every time the suite runs.
//
// Two real customers we use as scopes (both exist in the dev DB):
const CUSTOMER   = 3   // nev@qubestudio.co.nz — the "self" in these tests
const ALIEN      = 2   // nev@torny.co — a different customer, used for the cross-customer guard

beforeEach(async () => {
  await purgeAllTestNotifications()
})

afterAll(async () => {
  await purgeAllTestNotifications()
})

describe('GET /c/notifications', () => {
  it('returns paginated newest-first, with nextCursor', async () => {
    // Seed three rows in order — MySQL AUTO_INCREMENT gives us the ordering
    const a = await insertTestNotification({ customerId: CUSTOMER, eventId: testEventId('a') })
    const b = await insertTestNotification({ customerId: CUSTOMER, eventId: testEventId('b') })
    const c = await insertTestNotification({ customerId: CUSTOMER, eventId: testEventId('c') })

    const { status, body } = parse(await listHandler(customerEvent(CUSTOMER, { query: { limit: 2 } })) as any)
    expect(status).toBe(200)

    // Filter to only rows we know about (dev DB may have real notifications too)
    const ours = body.notifications.filter((n: any) => [a, b, c].includes(n.id))
    expect(ours.map((n: any) => n.id)).toEqual([c, b])   // newest-first, oldest of ours (a) is on page 2
    expect(body.nextCursor).toBeDefined()
    expect(body.nextCursor).not.toBeNull()
  })

  it('honours the cursor and returns the older page with no overlap', async () => {
    const ids = []
    for (let i = 0; i < 4; i++) {
      ids.push(await insertTestNotification({ customerId: CUSTOMER, eventId: testEventId(`p${i}`) }))
    }

    const page1 = parse(await listHandler(customerEvent(CUSTOMER, { query: { limit: 2 } })) as any).body
    const page1Ids = page1.notifications.filter((n: any) => ids.includes(n.id)).map((n: any) => n.id)
    expect(page1Ids.length).toBe(2)

    const page2 = parse(await listHandler(customerEvent(CUSTOMER, { query: { limit: 2, cursor: page1.nextCursor } })) as any).body
    const page2Ids = page2.notifications.filter((n: any) => ids.includes(n.id)).map((n: any) => n.id)

    expect(page2Ids.length).toBeGreaterThan(0)
    expect(page1Ids.some((id: number) => page2Ids.includes(id))).toBe(false)
  })

  it('scopes to the authed customer only', async () => {
    const mine  = await insertTestNotification({ customerId: CUSTOMER, eventId: testEventId('mine') })
    const alien = await insertTestNotification({ customerId: ALIEN,    eventId: testEventId('alien') })

    const body = parse(await listHandler(customerEvent(CUSTOMER)) as any).body
    const ids = body.notifications.map((n: any) => n.id)
    expect(ids).toContain(mine)
    expect(ids).not.toContain(alien)
  })

  it('caps limit at 100 and floors at 1 (defensive)', async () => {
    // Not verifying page size (dev DB has other rows) — just that the endpoint
    // doesn't throw / doesn't 500 on absurd inputs.
    for (const l of [-5, 0, 1, 100, 5000]) {
      const r = parse(await listHandler(customerEvent(CUSTOMER, { query: { limit: l } })) as any)
      expect(r.status).toBe(200)
    }
  })
})

describe('GET /c/notifications/unread-count', () => {
  it('counts only unread rows for the authed customer', async () => {
    const before = parse(await unreadCountHandler(customerEvent(CUSTOMER)) as any).body.unreadCount

    await insertTestNotification({ customerId: CUSTOMER, eventId: testEventId('u1') })
    await insertTestNotification({ customerId: CUSTOMER, eventId: testEventId('u2') })
    // Add one already-read row — should NOT count
    await insertTestNotification({ customerId: CUSTOMER, eventId: testEventId('r1'), readAt: new Date() })

    const after = parse(await unreadCountHandler(customerEvent(CUSTOMER)) as any).body.unreadCount
    expect(after).toBe(before + 2)
  })

  it('another customer\'s unread rows do not leak into this count', async () => {
    const before = parse(await unreadCountHandler(customerEvent(CUSTOMER)) as any).body.unreadCount

    await insertTestNotification({ customerId: ALIEN, eventId: testEventId('alien-unread') })

    const after = parse(await unreadCountHandler(customerEvent(CUSTOMER)) as any).body.unreadCount
    expect(after).toBe(before)   // unchanged
  })
})

describe('POST /c/notifications/{id}/read', () => {
  it('flips read_at on the target row', async () => {
    const id = await insertTestNotification({ customerId: CUSTOMER, eventId: testEventId('mark') })

    const { status, body } = parse(await markReadHandler(customerEvent(CUSTOMER, {
      method: 'POST', path: { id: String(id) },
    })) as any)
    expect(status).toBe(200)
    expect(body.ok).toBe(true)

    const [[row]] = await db().query<any[]>('SELECT read_at FROM notification_events WHERE id = ?', [id])
    expect(row.read_at).toBeTruthy()
  })

  it('is idempotent — re-reading returns 200', async () => {
    const id = await insertTestNotification({ customerId: CUSTOMER, eventId: testEventId('idem'), readAt: new Date() })

    const r = parse(await markReadHandler(customerEvent(CUSTOMER, {
      method: 'POST', path: { id: String(id) },
    })) as any)
    expect(r.status).toBe(200)
    expect(r.body.ok).toBe(true)
  })

  it('returns 404 for another customer\'s row (cross-customer guard)', async () => {
    const alienId = await insertTestNotification({ customerId: ALIEN, eventId: testEventId('cross') })

    const r = parse(await markReadHandler(customerEvent(CUSTOMER, {
      method: 'POST', path: { id: String(alienId) },
    })) as any)
    expect(r.status).toBe(404)
    expect(r.body.error.code).toBe('NOT_FOUND')

    // And crucially — the alien row is STILL unread
    const [[row]] = await db().query<any[]>('SELECT read_at FROM notification_events WHERE id = ?', [alienId])
    expect(row.read_at).toBeNull()
  })

  it('returns 404 for a nonexistent id', async () => {
    const r = parse(await markReadHandler(customerEvent(CUSTOMER, {
      method: 'POST', path: { id: '99999999' },
    })) as any)
    expect(r.status).toBe(404)
  })

  it('validation-errors on a missing id (belt-and-braces)', async () => {
    const r = parse(await markReadHandler(customerEvent(CUSTOMER, {
      method: 'POST', path: { id: '0' },
    })) as any)
    expect(r.status).toBe(422)
  })
})

describe('POST /c/notifications/read-all', () => {
  it('marks every unread row for the customer and reports the count', async () => {
    // Baseline: mark everything currently unread so we start clean
    await markAllReadHandler(customerEvent(CUSTOMER, { method: 'POST' }))

    // Seed three unread + one already-read
    await insertTestNotification({ customerId: CUSTOMER, eventId: testEventId('a1') })
    await insertTestNotification({ customerId: CUSTOMER, eventId: testEventId('a2') })
    await insertTestNotification({ customerId: CUSTOMER, eventId: testEventId('a3') })
    await insertTestNotification({ customerId: CUSTOMER, eventId: testEventId('a4-read'), readAt: new Date() })

    const r = parse(await markAllReadHandler(customerEvent(CUSTOMER, { method: 'POST' })) as any)
    expect(r.status).toBe(200)
    expect(r.body.marked).toBe(3)   // only the 3 unread ones flipped

    const after = parse(await unreadCountHandler(customerEvent(CUSTOMER)) as any).body.unreadCount
    expect(after).toBe(0)
  })

  it('does not touch another customer\'s unread rows', async () => {
    const alienId = await insertTestNotification({ customerId: ALIEN, eventId: testEventId('alien-untouched') })

    await markAllReadHandler(customerEvent(CUSTOMER, { method: 'POST' }))

    const [[row]] = await db().query<any[]>('SELECT read_at FROM notification_events WHERE id = ?', [alienId])
    expect(row.read_at).toBeNull()
  })

  it('is safe to call when nothing is unread — returns marked: 0', async () => {
    await markAllReadHandler(customerEvent(CUSTOMER, { method: 'POST' }))   // ensure clean

    const r = parse(await markAllReadHandler(customerEvent(CUSTOMER, { method: 'POST' })) as any)
    expect(r.status).toBe(200)
    expect(r.body.marked).toBe(0)
  })
})
