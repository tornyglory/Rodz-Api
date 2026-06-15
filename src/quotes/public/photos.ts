import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { ok, serverError } from '../../shared/errors'
import { buildPhoto } from '../../photos/_helpers'
import { quoteError } from '../_helpers'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const token = event.pathParameters?.token

  if (!token) return quoteError(400, 'MISSING_TOKEN', 'Token is required.')

  try {
    const [[quote]] = await db.query<any[]>(
      'SELECT id FROM quotes WHERE token = ? LIMIT 1',
      [token],
    )
    if (!quote) return quoteError(404, 'QUOTE_NOT_FOUND', 'Quote not found.')

    const [rows] = await db.query<any[]>(
      `SELECT id, image_id, vehicle_rego, quote_id, quote_item_id, uploaded_by, caption, created_at
       FROM photos
       WHERE quote_id = ?
       ORDER BY created_at DESC`,
      [quote.id],
    )

    return ok({ photos: rows.map(buildPhoto) })
  } catch (err) {
    return serverError(err)
  }
}
