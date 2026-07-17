import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { ok, validationError, serverError } from '../../shared/errors'
import { getCustomerContext } from '../_helpers'

const ready = bootstrap()

const TOPIC_COLS = [
  'service_due', 'rego_expiring', 'booking', 'quote',
  'invoice', 'urgent_reco', 'workshop_message',
] as const

const CAMEL_TO_DB: Record<string, typeof TOPIC_COLS[number]> = {
  serviceDue:      'service_due',
  regoExpiring:    'rego_expiring',
  booking:         'booking',
  quote:           'quote',
  invoice:         'invoice',
  urgentReco:      'urgent_reco',
  workshopMessage: 'workshop_message',
}

// PATCH /c/me/notification-prefs — partial update. Body is any subset of:
//   { serviceDue, regoExpiring, booking, quote, invoice, urgentReco,
//     workshopMessage, quietHoursStart, quietHoursEnd }
// Time fields are 'HH:MM' strings, or null to clear.
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getCustomerContext(event)

  try {
    const body = JSON.parse(event.body ?? '{}') as Record<string, unknown>

    const setCols: string[]  = []
    const setVals: unknown[] = []
    const insertVals: Record<string, unknown> = {}

    for (const [camel, dbCol] of Object.entries(CAMEL_TO_DB)) {
      if (camel in body) {
        const raw = body[camel]
        if (raw !== true && raw !== false) {
          return validationError(`${camel} must be a boolean.`)
        }
        setCols.push(`${dbCol} = ?`)
        setVals.push(raw ? 1 : 0)
        insertVals[dbCol] = raw ? 1 : 0
      }
    }

    if ('quietHoursStart' in body) {
      const v = body.quietHoursStart
      if (v !== null && !isValidHhMm(v)) return validationError("quietHoursStart must be 'HH:MM' or null.")
      setCols.push('quiet_hours_start = ?')
      setVals.push(v === null ? null : `${v}:00`)
      insertVals.quiet_hours_start = v === null ? null : `${v}:00`
    }
    if ('quietHoursEnd' in body) {
      const v = body.quietHoursEnd
      if (v !== null && !isValidHhMm(v)) return validationError("quietHoursEnd must be 'HH:MM' or null.")
      setCols.push('quiet_hours_end = ?')
      setVals.push(v === null ? null : `${v}:00`)
      insertVals.quiet_hours_end = v === null ? null : `${v}:00`
    }

    if (setCols.length === 0) return validationError('No pref fields provided.')

    // Upsert pattern: try UPDATE first, INSERT if no row exists. Cleaner than
    // ON DUPLICATE KEY UPDATE for a wide, sparsely-set column list.
    const [updRes] = await db.query<any>(
      `UPDATE customer_notification_prefs SET ${setCols.join(', ')} WHERE customer_id = ?`,
      [...setVals, ctx.customerId],
    )
    if (updRes.affectedRows === 0) {
      const cols = ['customer_id', ...Object.keys(insertVals)]
      const placeholders = cols.map(() => '?').join(', ')
      await db.query(
        `INSERT INTO customer_notification_prefs (${cols.join(', ')}) VALUES (${placeholders})`,
        [ctx.customerId, ...Object.values(insertVals)],
      )
    }

    return ok({ ok: true })
  } catch (err) {
    return serverError(err)
  }
}

function isValidHhMm(v: unknown): boolean {
  return typeof v === 'string' && /^\d{2}:\d{2}$/.test(v)
}
