import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { notFound, serverError } from '../../shared/errors'
import { QUOTE_SELECT, buildQuote, quoteError, getQuoteItems } from '../_helpers'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const token = event.pathParameters?.token

  if (!token) return quoteError(400, 'MISSING_TOKEN', 'Token is required.')

  try {
    const [[row]] = await db.query<any[]>(
      `${QUOTE_SELECT} WHERE q.token = ? LIMIT 1`,
      [token],
    )
    if (!row) return notFound('Quote')

    const items = await getQuoteItems(db, row.id)
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quote: buildQuote(row, items) }),
    }
  } catch (err) {
    return serverError(err)
  }
}
