import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../../shared/bootstrap'
import { getPool } from '../../../shared/db'
import { getAuthContext } from '../../../shared/auth'
import { created, forbidden, notFound, validationError, serverError } from '../../../shared/errors'

const ready = bootstrap()

const VALID_TYPES = new Set(['annual','sick','personal','long_service','unpaid'])

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getAuthContext(event)

  if (ctx.role === 'technician') return forbidden()

  const staffId = event.pathParameters?.id

  try {
    const [[staff]] = await db.query<any[]>(
      'SELECT id FROM staff WHERE id = ? AND is_active = 1 LIMIT 1', [staffId],
    )
    if (!staff) return notFound('Staff member')

    const { type, startDate, endDate, days, notes } = JSON.parse(event.body ?? '{}')

    if (!type || !VALID_TYPES.has(type)) {
      return validationError(`type must be one of: ${[...VALID_TYPES].join(', ')}.`)
    }
    if (!startDate || !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
      return validationError('startDate is required (YYYY-MM-DD).')
    }
    if (!endDate || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
      return validationError('endDate is required (YYYY-MM-DD).')
    }
    if (startDate > endDate) return validationError('startDate must be before or equal to endDate.')
    const daysNum = parseFloat(days)
    if (!isFinite(daysNum) || daysNum <= 0) {
      return validationError('days must be a positive number.')
    }

    const [result] = await db.query<any>(
      `INSERT INTO staff_leave (staff_id, type, start_date, end_date, days, notes)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [staffId, type, startDate, endDate, daysNum, notes?.trim() ?? null],
    )

    const [[row]] = await db.query<any[]>(
      'SELECT id, type, start_date, end_date, days, notes, created_at FROM staff_leave WHERE id = ? LIMIT 1',
      [result.insertId],
    )

    return created({
      entry: {
        id:        Number(row.id),
        type:      row.type,
        startDate: row.start_date instanceof Date ? row.start_date.toISOString().slice(0, 10) : String(row.start_date).slice(0, 10),
        endDate:   row.end_date   instanceof Date ? row.end_date.toISOString().slice(0, 10)   : String(row.end_date).slice(0, 10),
        days:      Number(row.days),
        notes:     row.notes ?? null,
        createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString(),
      },
    })
  } catch (err) {
    return serverError(err)
  }
}
