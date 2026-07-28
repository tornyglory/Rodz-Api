import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { ok, forbidden, notFound, validationError, serverError } from '../shared/errors'
import { corsPreflightResponse, ensureStaffAuth } from '../shared/staffAuth'

const ready = bootstrap()

// Business hours = default per-day-of-week schedule for a store.
// Consolidated into one Lambda + one ANY route to conserve API Gateway
// integrations. Dispatches on method + body shape:
//
//   GET   /stores/{id}/business-hours   → all 7 days
//   PATCH /stores/{id}/business-hours   → body: { dayOfWeek, openTime?, closeTime?, isClosed?, lastBookingOffsetMins? }
//
// A PATCH upserts the row for that (store, dayOfWeek) — safe if the seed
// somehow missed a day.

function guard(role: string, ctxStoreId: string, targetStoreId: number): APIGatewayProxyResultV2 | null {
  if (role === 'technician') return forbidden()
  if (role === 'super_admin') return null
  if (Number(ctxStoreId) === targetStoreId) return null
  return forbidden()
}

function shapeRow(row: any) {
  const t = (v: any) => v == null ? null : (v instanceof Date ? v.toISOString().slice(11, 16) : String(v).slice(0, 5))
  return {
    storeId:               Number(row.store_id),
    dayOfWeek:             Number(row.day_of_week),
    openTime:              t(row.open_time),
    closeTime:             t(row.close_time),
    isClosed:              Number(row.is_closed) === 1,
    lastBookingOffsetMins: Number(row.last_booking_offset_mins ?? 60),
    notes:                 row.notes ?? null,
  }
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const method  = event.requestContext.http.method

  if (method === 'OPTIONS') return corsPreflightResponse(event)

  const authErr = ensureStaffAuth(event)
  if (authErr) return authErr

  const db      = getPool()
  const ctx     = getAuthContext(event)
  const storeId = Number(event.pathParameters?.id)

  if (!storeId) return validationError('store id is required.')

  const denied = guard(ctx.role, ctx.storeId, storeId)
  if (denied) return denied

  try {
    const [[store]] = await db.query<any[]>('SELECT id FROM stores WHERE id = ? LIMIT 1', [storeId])
    if (!store) return notFound('Store')

    if (method === 'GET') {
      const [rows] = await db.query<any[]>(
        `SELECT store_id, day_of_week, open_time, close_time, is_closed, last_booking_offset_mins, notes
         FROM business_hours WHERE store_id = ? ORDER BY day_of_week`,
        [storeId],
      )
      return ok({ hours: rows.map(shapeRow) })
    }

    if (method === 'PATCH') {
      const body = JSON.parse(event.body ?? '{}') as Record<string, unknown>
      const dow  = Number(body.dayOfWeek)
      if (!Number.isInteger(dow) || dow < 0 || dow > 6) {
        return validationError('dayOfWeek must be an integer 0–6 (Sunday–Saturday).')
      }

      // Build partial UPSERT. If the row exists we UPDATE only supplied
      // fields; if not we INSERT with sensible defaults.
      const openTime  = 'openTime'  in body ? (body.openTime  === null ? null : String(body.openTime))  : undefined
      const closeTime = 'closeTime' in body ? (body.closeTime === null ? null : String(body.closeTime)) : undefined
      const isClosed  = 'isClosed'  in body ? (body.isClosed ? 1 : 0) : undefined
      const offset    = 'lastBookingOffsetMins' in body ? Number(body.lastBookingOffsetMins) : undefined
      const notes     = 'notes'     in body ? (body.notes === null ? null : String(body.notes).slice(0, 500)) : undefined

      if (openTime !== undefined && openTime !== null && !/^\d{2}:\d{2}(:\d{2})?$/.test(openTime)) {
        return validationError('openTime must be HH:MM or HH:MM:SS.')
      }
      if (closeTime !== undefined && closeTime !== null && !/^\d{2}:\d{2}(:\d{2})?$/.test(closeTime)) {
        return validationError('closeTime must be HH:MM or HH:MM:SS.')
      }
      if (offset !== undefined && (!Number.isInteger(offset) || offset < 0 || offset > 240)) {
        return validationError('lastBookingOffsetMins must be an integer 0–240.')
      }

      const [[existing]] = await db.query<any[]>(
        'SELECT store_id FROM business_hours WHERE store_id = ? AND day_of_week = ? LIMIT 1',
        [storeId, dow],
      )

      if (existing) {
        const sets: string[] = []
        const params: any[]  = []
        if (openTime  !== undefined) { sets.push('open_time = ?');  params.push(openTime) }
        if (closeTime !== undefined) { sets.push('close_time = ?'); params.push(closeTime) }
        if (isClosed  !== undefined) { sets.push('is_closed = ?');  params.push(isClosed) }
        if (offset    !== undefined) { sets.push('last_booking_offset_mins = ?'); params.push(offset) }
        if (notes     !== undefined) { sets.push('notes = ?');      params.push(notes) }
        if (sets.length === 0) return validationError('No editable fields provided.')
        params.push(storeId, dow)
        await db.query(`UPDATE business_hours SET ${sets.join(', ')} WHERE store_id = ? AND day_of_week = ?`, params)
      } else {
        await db.query(
          `INSERT INTO business_hours (store_id, day_of_week, open_time, close_time, is_closed, last_booking_offset_mins, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [storeId, dow, openTime ?? null, closeTime ?? null, isClosed ?? 0, offset ?? 60, notes ?? null],
        )
      }

      const [[row]] = await db.query<any[]>(
        `SELECT store_id, day_of_week, open_time, close_time, is_closed, last_booking_offset_mins, notes
         FROM business_hours WHERE store_id = ? AND day_of_week = ? LIMIT 1`,
        [storeId, dow],
      )
      return ok({ hours: shapeRow(row) })
    }

    return {
      statusCode: 405,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: { code: 'METHOD_NOT_ALLOWED', message: `${method} not allowed.` } }),
    }
  } catch (err) {
    return serverError(err)
  }
}
