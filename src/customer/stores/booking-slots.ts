import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { ok, notFound, validationError, serverError } from '../../shared/errors'
import { computeSlotAvailability, toHHMM } from '../../shared/bookingSlots'

const ready = bootstrap()

// GET /c/stores/{id}/booking-slots?date=YYYY-MM-DD
//
// Returns each configured slot for the store with an `available` boolean
// for the requested date. Customer-authed (a customer needs to be logged
// in to be looking at bookings) but doesn't check ownership — the store
// list is public shape.
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db      = getPool()
  const storeId = Number(event.pathParameters?.id)
  const date    = event.queryStringParameters?.date

  if (!storeId) return validationError('store id is required.')
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return validationError('date query param must be YYYY-MM-DD format.')
  }

  try {
    const [[store]] = await db.query<any[]>(
      'SELECT id, name FROM stores WHERE id = ? AND is_active = 1 LIMIT 1',
      [storeId],
    )
    if (!store) return notFound('Store')

    const result = await computeSlotAvailability(db, storeId, date)

    return ok({
      store:           { id: Number(store.id), name: store.name },
      date,
      storeOpen:       result.storeOpen,
      reason:          result.reason ?? null,
      exceptionReason: result.exceptionReason ?? null,
      slots:           result.slots.map(s => ({
        id:        s.id,
        time:      toHHMM(s.time),
        endTime:   toHHMM(s.endTime),
        label:     s.label,
        sortOrder: s.sortOrder,
        available: s.available,
        reason:    (s as any).reason ?? null,
      })),
    })
  } catch (err) {
    return serverError(err)
  }
}
