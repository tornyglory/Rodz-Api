import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { handler as unlockHandler } from '../../src/customers/unlock'
import { staffEvent, parse } from '../_setup/apigw'
import { db } from '../_setup/db'

// Staff-side "unlock a locked-out customer" endpoint. Verifies the core
// state changes + audit trail + role guards.
//
// Test customer is a real dev-DB row (customer 2). We don't create/tear
// down the customer_auth row — we set failed_login_attempts + locked_until
// to known states before each test and reset them after.

const CUSTOMER_ID = 2

async function setAuthState(failed: number, lockedUntil: Date | null) {
  await db().query(
    'UPDATE customer_auth SET failed_login_attempts = ?, locked_until = ? WHERE customer_id = ?',
    [failed, lockedUntil, CUSTOMER_ID],
  )
}

async function getAuthState() {
  const [[row]] = await db().query<any[]>(
    'SELECT failed_login_attempts, locked_until FROM customer_auth WHERE customer_id = ?',
    [CUSTOMER_ID],
  )
  return row as { failed_login_attempts: number; locked_until: Date | null }
}

async function purgeUnlockLog() {
  await db().query(
    "DELETE FROM customer_auth_log WHERE customer_id = ? AND event_type = 'account_unlocked' AND metadata LIKE ?",
    [CUSTOMER_ID, '%vitest%'],
  )
}

beforeEach(async () => {
  await setAuthState(0, null)
  await purgeUnlockLog()
})

afterAll(async () => {
  await setAuthState(0, null)
  await purgeUnlockLog()
})

const admin = { staffId: 'vitest-admin', role: 'super_admin' as const, storeId: 1 }
const manager = { staffId: 'vitest-manager', role: 'store_manager' as const, storeId: 1 }
const tech    = { staffId: 'vitest-tech',    role: 'technician' as const,    storeId: 1 }

describe('POST /customers/{id}/unlock', () => {
  it('clears failed_login_attempts + locked_until when the customer is locked', async () => {
    const future = new Date(Date.now() + 15 * 60_000)
    await setAuthState(5, future)

    const { status, body } = parse(await unlockHandler(staffEvent(admin, {
      method: 'POST', path: { id: String(CUSTOMER_ID) },
    })) as any)

    expect(status).toBe(200)
    expect(body).toMatchObject({ id: CUSTOMER_ID, unlocked: true })

    const s = await getAuthState()
    expect(s.failed_login_attempts).toBe(0)
    expect(s.locked_until).toBeNull()
  })

  it('is idempotent — already-unlocked customer still returns 200', async () => {
    // beforeEach already set state to (0, null)
    const { status, body } = parse(await unlockHandler(staffEvent(admin, {
      method: 'POST', path: { id: String(CUSTOMER_ID) },
    })) as any)

    expect(status).toBe(200)
    expect(body.unlocked).toBe(true)   // affectedRows still counts the UPDATE
  })

  it('writes an audit row to customer_auth_log with the acting staff id', async () => {
    await setAuthState(3, null)

    await unlockHandler(staffEvent({ ...admin, staffId: 'vitest-admin' }, {
      method: 'POST', path: { id: String(CUSTOMER_ID) },
    }))

    const [[row]] = await db().query<any[]>(
      `SELECT event_type, metadata FROM customer_auth_log
       WHERE customer_id = ? AND event_type = 'account_unlocked'
       ORDER BY id DESC LIMIT 1`,
      [CUSTOMER_ID],
    )
    expect(row.event_type).toBe('account_unlocked')
    const meta = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata
    expect(meta.unlocked_by_staff_id).toBe('vitest-admin')
    expect(meta.role).toBe('super_admin')
  })

  it('returns 403 for technician role', async () => {
    const { status } = parse(await unlockHandler(staffEvent(tech, {
      method: 'POST', path: { id: String(CUSTOMER_ID) },
    })) as any)
    expect(status).toBe(403)
  })

  it('allows store_manager', async () => {
    await setAuthState(5, new Date(Date.now() + 15 * 60_000))
    const { status } = parse(await unlockHandler(staffEvent(manager, {
      method: 'POST', path: { id: String(CUSTOMER_ID) },
    })) as any)
    expect(status).toBe(200)
  })

  it('returns 404 for a nonexistent customer', async () => {
    const { status, body } = parse(await unlockHandler(staffEvent(admin, {
      method: 'POST', path: { id: '99999999' },
    })) as any)
    expect(status).toBe(404)
    expect(body.error.code).toBe('NOT_FOUND')
  })

  it('validation-errors on missing id', async () => {
    const { status } = parse(await unlockHandler(staffEvent(admin, {
      method: 'POST', path: { id: '0' },
    })) as any)
    expect(status).toBe(422)
  })
})
