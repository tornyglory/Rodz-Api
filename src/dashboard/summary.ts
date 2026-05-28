import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { ok, serverError } from '../shared/errors'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const { storeId } = getAuthContext(event)

  try {
    const [[bookings], [jobs], [quotes]] = await Promise.all([
      db.query<any[]>('SELECT COUNT(*) AS total FROM bookings WHERE store_id = ? AND status != "completed"', [storeId]),
      db.query<any[]>('SELECT COUNT(*) AS total FROM jobs WHERE store_id = ? AND status = "in_progress"', [storeId]),
      db.query<any[]>('SELECT COUNT(*) AS total FROM quotes WHERE store_id = ? AND status = "pending"', [storeId]),
    ])

    return ok({
      activeBookings: bookings[0]?.total ?? 0,
      jobsInProgress: jobs[0]?.total ?? 0,
      pendingQuotes:  quotes[0]?.total ?? 0,
    })
  } catch (err) {
    return serverError(err)
  }
}
