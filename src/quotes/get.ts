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
    const [[quote], [lineItems]] = await Promise.all([
      db.query<any[]>('SELECT * FROM quotes WHERE id = ? LIMIT 1', [id]),
      db.query<any[]>('SELECT * FROM quote_line_items WHERE quote_id = ?', [id]),
    ])

    if (!quote[0]) return notFound('Quote')
    return ok({ ...quote[0], line_items: lineItems })
  } catch (err) {
    return serverError(err)
  }
}
