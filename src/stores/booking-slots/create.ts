import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { getAuthContext } from '../../shared/auth'
import { created, notFound, validationError, serverError } from '../../shared/errors'
import { guardStaffStoreAccess, shapeSlotResponse, parseTime } from './_helpers'

const ready = bootstrap()

// POST /stores/{id}/booking-slots
// Body: { time: 'HH:MM', label?: string, sortOrder?: number, isActive?: boolean }
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db      = getPool()
  const ctx     = getAuthContext(event)
  const storeId = Number(event.pathParameters?.id)

  if (!storeId) return validationError('store id is required.')
  const guard = await guardStaffStoreAccess(db, ctx, storeId)
  if (guard) return guard

  try {
    const [[store]] = await db.query<any[]>('SELECT id FROM stores WHERE id = ? LIMIT 1', [storeId])
    if (!store) return notFound('Store')

    const body     = JSON.parse(event.body ?? '{}') as Record<string, unknown>
    const timeVal  = parseTime(body.time)
    const endVal   = parseTime(body.endTime)
    if (!timeVal)  return validationError('time must be in HH:MM format.')
    if (!endVal)   return validationError('endTime must be in HH:MM format.')
    if (endVal <= timeVal) return validationError('endTime must be after time.')

    const label     = body.label != null ? String(body.label).trim().slice(0, 40) || null : null
    const sortOrder = Number.isInteger(body.sortOrder) ? Number(body.sortOrder) : 0
    const isActive  = body.isActive === false ? 0 : 1

    // Overlap check against other active slots at this store — reject
    // configurations that would let two slots share a hoist window.
    const [overlaps] = await db.query<any[]>(
      `SELECT id FROM store_booking_slots
       WHERE store_id = ? AND is_active = 1
         AND slot_time < ? AND end_time > ?
       LIMIT 1`,
      [storeId, endVal, timeVal],
    )
    if (overlaps.length > 0) {
      return validationError('This slot overlaps an existing active slot at this store.')
    }

    try {
      const [res] = await db.query<any>(
        `INSERT INTO store_booking_slots (store_id, slot_time, end_time, label, sort_order, is_active)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [storeId, timeVal, endVal, label, sortOrder, isActive],
      )
      const [[row]] = await db.query<any[]>(
        `SELECT id, store_id, slot_time, end_time, label, sort_order, is_active, created_at, updated_at
         FROM store_booking_slots WHERE id = ?`,
        [res.insertId],
      )
      return created({ slot: shapeSlotResponse(row) })
    } catch (err: any) {
      if (err?.code === 'ER_DUP_ENTRY') {
        return validationError('A slot at that time already exists for this store.')
      }
      throw err
    }
  } catch (err) {
    return serverError(err)
  }
}
