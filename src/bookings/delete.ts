import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { noContent, forbidden, serverError } from '../shared/errors'
import { bookingError, getAllowedStoreIds } from './_helpers'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const ctx = getAuthContext(event)
  const id = event.pathParameters?.id

  if (ctx.role === 'technician') return forbidden()

  try {
    const [[booking]] = await db.query<any[]>(
      'SELECT store_id FROM bookings WHERE id = ? AND deleted_at IS NULL LIMIT 1',
      [id],
    )
    if (!booking) return bookingError(404, 'BOOKING_NOT_FOUND', 'Booking not found.')

    if (ctx.role !== 'super_admin') {
      const allowedIds = await getAllowedStoreIds(db, ctx.staffId)
      if (!allowedIds.includes(booking.store_id)) return forbidden()
    }

    await db.query<any>(
      'UPDATE bookings SET deleted_at = NOW(), deleted_by = ? WHERE id = ? AND deleted_at IS NULL',
      [ctx.staffId, id],
    )

    return noContent()
  } catch (err) {
    return serverError(err)
  }
}
