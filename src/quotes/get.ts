import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { ok, forbidden, notFound, serverError } from '../shared/errors'
import { QUOTE_SELECT, buildQuote, getAllowedStoreIds, getQuoteItems } from './_helpers'
import { attachVoiceNotesToQuote } from './voice-notes/_helpers'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const ctx = getAuthContext(event)
  const id = event.pathParameters?.id

  try {
    const [[row]] = await db.query<any[]>(
      `${QUOTE_SELECT} WHERE q.id = ? LIMIT 1`,
      [id],
    )
    if (!row) return notFound('Quote')

    if (ctx.role !== 'super_admin') {
      const allowedIds = await getAllowedStoreIds(db, ctx.staffId)
      if (!allowedIds.includes(row.store_id)) return forbidden()
    }

    const items = await getQuoteItems(db, row.id)
    const built = buildQuote(row, items)
    await attachVoiceNotesToQuote(db, built)

    return ok({ quote: built })
  } catch (err) {
    return serverError(err)
  }
}
