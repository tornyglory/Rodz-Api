import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { getAuthContext } from '../../shared/auth'
import { ok, notFound, validationError, serverError } from '../../shared/errors'
import { guardStaffStoreAccess, shapeSlotResponse } from './_helpers'

const ready = bootstrap()

// PATCH /stores/{id}/booking-slots/{slotId}
// Body: any subset of { time, label, sortOrder, isActive }
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db      = getPool()
  const ctx     = getAuthContext(event)
  const storeId = Number(event.pathParameters?.id)
  const slotId  = Number(event.pathParameters?.slotId)

  if (!storeId || !slotId) return validationError('store id and slot id are required.')
  const guard = await guardStaffStoreAccess(db, ctx, storeId)
  if (guard) return guard

  try {
    const [[existing]] = await db.query<any[]>(
      'SELECT id FROM store_booking_slots WHERE id = ? AND store_id = ? LIMIT 1',
      [slotId, storeId],
    )
    if (!existing) return notFound('Slot')

    const body = JSON.parse(event.body ?? '{}') as Record<string, unknown>
    const sets: string[] = []
    const params: any[]  = []

    if (body.time !== undefined) {
      const time = String(body.time).trim()
      if (!/^\d{2}:\d{2}$/.test(time)) return validationError('time must be in HH:MM format.')
      sets.push('slot_time = ?')
      params.push(`${time}:00`)
    }
    if (body.label !== undefined) {
      sets.push('label = ?')
      params.push(body.label === null ? null : String(body.label).trim().slice(0, 40) || null)
    }
    if (body.sortOrder !== undefined) {
      if (!Number.isInteger(body.sortOrder)) return validationError('sortOrder must be an integer.')
      sets.push('sort_order = ?')
      params.push(Number(body.sortOrder))
    }
    if (body.isActive !== undefined) {
      sets.push('is_active = ?')
      params.push(body.isActive === false ? 0 : 1)
    }

    if (sets.length === 0) return validationError('No editable fields provided.')

    params.push(slotId)
    try {
      await db.query(`UPDATE store_booking_slots SET ${sets.join(', ')} WHERE id = ?`, params)
    } catch (err: any) {
      if (err?.code === 'ER_DUP_ENTRY') {
        return validationError('Another slot at that time already exists for this store.')
      }
      throw err
    }

    const [[row]] = await db.query<any[]>(
      `SELECT id, store_id, slot_time, label, sort_order, is_active, created_at, updated_at
       FROM store_booking_slots WHERE id = ?`,
      [slotId],
    )
    return ok({ slot: shapeSlotResponse(row) })
  } catch (err) {
    return serverError(err)
  }
}
