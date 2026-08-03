import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { ok, notFound, serverError } from '../shared/errors'
import { BOOKING_SELECT_BY_ID, buildBooking, getBookingServices } from './_helpers'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const id = Number(event.pathParameters?.id)
  if (!id) return notFound('Booking')

  try {
    const [[row]] = await db.query<any[]>(BOOKING_SELECT_BY_ID, [id])
    if (!row) return notFound('Booking')

    // Attach services so the response shape matches GET /bookings.
    const svcMap = await getBookingServices(db, [id])
    return ok({ booking: buildBooking(row, svcMap.get(id) ?? []) })
  } catch (err) {
    return serverError(err)
  }
}
