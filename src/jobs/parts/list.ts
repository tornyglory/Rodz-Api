import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { ok, serverError } from '../../shared/errors'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const jobId = event.pathParameters?.id

  try {
    const [rows] = await db.query<any[]>('SELECT * FROM job_parts WHERE job_id = ? ORDER BY id', [jobId])
    return ok(rows)
  } catch (err) {
    return serverError(err)
  }
}
