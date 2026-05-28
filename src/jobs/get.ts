import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { ok, notFound, serverError } from '../shared/errors'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const id = event.pathParameters?.id

  try {
    const [[job], [parts]] = await Promise.all([
      db.query<any[]>('SELECT * FROM jobs WHERE id = ? LIMIT 1', [id]),
      db.query<any[]>('SELECT * FROM job_parts WHERE job_id = ?', [id]),
    ])

    if (!job[0]) return notFound('Job')
    return ok({ ...job[0], parts })
  } catch (err) {
    return serverError(err)
  }
}
