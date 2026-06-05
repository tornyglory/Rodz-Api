import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { ok, serverError } from '../shared/errors'
import { buildPhoto } from './_helpers'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const rego = event.pathParameters?.rego
  const { quoteId, quoteItemId } = event.queryStringParameters ?? {}

  try {
    const where: string[] = ['vehicle_rego = ?']
    const params: unknown[] = [rego]

    if (quoteId)     { where.push('quote_id = ?');      params.push(Number(quoteId)) }
    if (quoteItemId) { where.push('quote_item_id = ?'); params.push(Number(quoteItemId)) }

    const [rows] = await db.query<any[]>(
      `SELECT id, image_id, vehicle_rego, quote_id, quote_item_id, uploaded_by, caption, created_at
       FROM photos
       WHERE ${where.join(' AND ')}
       ORDER BY created_at DESC`,
      params,
    )

    return ok({ photos: rows.map(buildPhoto) })
  } catch (err) {
    return serverError(err)
  }
}
