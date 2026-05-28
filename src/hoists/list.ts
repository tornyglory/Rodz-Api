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
    const [rows] = await db.query<any[]>(
      `SELECT h.*, j.id AS current_job_id, j.status AS job_status
       FROM hoists h
       LEFT JOIN jobs j ON j.hoist_id = h.id AND j.status = 'in_progress'
       WHERE h.store_id = ?
       ORDER BY h.name`,
      [storeId],
    )
    return ok(rows)
  } catch (err) {
    return serverError(err)
  }
}
