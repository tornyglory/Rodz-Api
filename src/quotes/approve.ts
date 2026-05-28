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
    const [result] = await db.query<any>(
      "UPDATE quotes SET status = 'approved', approved_at = NOW() WHERE id = ? AND status = 'sent'",
      [id],
    )
    if (result.affectedRows === 0) return notFound('Quote')

    const [rows] = await db.query<any[]>('SELECT * FROM quotes WHERE id = ? LIMIT 1', [id])
    return ok(rows[0])
  } catch (err) {
    return serverError(err)
  }
}
