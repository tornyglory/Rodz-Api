// Shared helpers for integration tests that touch the DB.
//
// The test process reuses the same mysql pool as the handlers under test —
// getPool() is a module-level singleton. On process exit vitest would
// otherwise hang for the keepalive TTL; the closePool() helper is called
// from globalTeardown so tests exit cleanly.

import type { Pool } from 'mysql2/promise'
import { getPool } from '../../src/shared/db'

const TEST_EVENT_ID_PREFIX = 'test:vitest:'

export function db(): Pool {
  return getPool()
}

// Any row inserted by tests uses this prefix so cleanup is a one-liner
// that can't clobber real data.
export function testEventId(name: string): string {
  return `${TEST_EVENT_ID_PREFIX}${name}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`
}

// Wipe every test-created notification row for a given customer. Cheap
// isolation between tests without touching real notifications.
export async function purgeTestNotifications(customerId: number): Promise<void> {
  await db().query(
    'DELETE FROM notification_events WHERE customer_id = ? AND event_id LIKE ?',
    [customerId, `${TEST_EVENT_ID_PREFIX}%`],
  )
}

export async function purgeAllTestNotifications(): Promise<void> {
  await db().query('DELETE FROM notification_events WHERE event_id LIKE ?', [`${TEST_EVENT_ID_PREFIX}%`])
}

export async function insertTestNotification(row: {
  customerId: number
  eventId?:   string
  type?:      string
  title?:     string
  body?:      string
  deeplink?:  string
  vehicleId?: number | null
  sentAt?:    Date
  readAt?:    Date | null
}): Promise<number> {
  const eventId  = row.eventId  ?? testEventId('n')
  const type     = row.type     ?? 'test'
  const title    = row.title    ?? 'Test'
  const body     = row.body     ?? 'Test body'
  const deeplink = row.deeplink ?? '/'
  const [res] = await db().query<any>(
    `INSERT INTO notification_events
       (customer_id, vehicle_id, event_id, type, title, body, deeplink, sent_at, read_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, NOW()), ?)`,
    [row.customerId, row.vehicleId ?? null, eventId, type, title, body, deeplink,
     row.sentAt ?? null, row.readAt ?? null],
  )
  return Number(res.insertId)
}
