import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { notFound, serverError } from '../../shared/errors'
import { QUOTE_SELECT, buildQuote, quoteError, getQuoteItems } from '../_helpers'
import { fetchVoiceNotesForQuotes, toVoiceNoteResponse } from '../voice-notes/_helpers'

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
    const built = buildQuote(row, items)

    // Attach voice notes — same shape as the staff endpoint. Playback URLs
    // are short-lived; the customer refreshes the page or hits the
    // playback-url endpoint if one expires mid-session.
    const notesMap = await fetchVoiceNotesForQuotes(db, [Number(row.id)])
    const bucket = notesMap.get(Number(row.id))
    const quoteLevelRows = bucket?.itemGroups.get(null) ?? []
    ;(built as any).voiceNotes = await Promise.all(quoteLevelRows.map(r => toVoiceNoteResponse(r)))

    for (const item of built.items) {
      const itemRows = bucket?.itemGroups.get(Number(item.id)) ?? []
      ;(item as any).voiceNotes = await Promise.all(itemRows.map(r => toVoiceNoteResponse(r)))
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quote: built }),
    }
  } catch (err) {
    return serverError(err)
  }
}
