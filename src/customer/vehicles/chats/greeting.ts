import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { GoogleGenerativeAI } from '@google/generative-ai'
import { bootstrap } from '../../../shared/bootstrap'
import { getPool } from '../../../shared/db'
import { ok, forbidden, notFound, validationError, serverError } from '../../../shared/errors'
import { getCustomerContext } from '../../_helpers'
import { buildSituationSnapshot, isMemoryEnabled } from './_shared'

const ready = bootstrap()

const GREETING_INSTRUCTION = `You are Rod, the customer's vehicle AI assistant at Rodz, an Australian workshop. Greet the customer to open a new conversation.

Rules:
- Start with "Hey {firstName}" (only their first name).
- Mention 1–2 concrete facts from the situation snapshot below — ideally something time-sensitive (service due, rego expiring).
- If nothing time-sensitive, note the last service or general state.
- Do not list — write as a natural sentence or two, max ~40 words.
- End with an open-ended offer like "want to sort one of those, or something else?"
- Never invent facts. If a value is missing, don't mention that category.
- Do not use markdown, headers, or bullets. Plain conversational text only.`

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db        = getPool()
  const ctx       = getCustomerContext(event)
  const vehicleId = Number(event.pathParameters?.id)
  const sessionId = Number(event.pathParameters?.sessionId)

  if (!vehicleId || !sessionId) return validationError('vehicleId and sessionId are required')

  try {
    const [[ownership]] = await db.query<any[]>(
      'SELECT id FROM vehicle_owners WHERE vehicle_id = ? AND customer_id = ? AND is_current = 1 LIMIT 1',
      [vehicleId, ctx.customerId],
    )
    if (!ownership) return forbidden()

    const [[session]] = await db.query<any[]>(
      'SELECT id FROM customer_chat_sessions WHERE id = ? AND vehicle_id = ? AND customer_id = ? LIMIT 1',
      [sessionId, vehicleId, ctx.customerId],
    )
    if (!session) return notFound('Session')

    // Session-not-empty guard — don't re-greet an existing conversation.
    const [[countRow]] = await db.query<any[]>(
      'SELECT COUNT(*) AS cnt FROM customer_vehicle_chats WHERE session_id = ?',
      [sessionId],
    )
    if (Number(countRow.cnt) > 0) {
      return {
        statusCode: 409,
        headers:    { 'Content-Type': 'application/json' },
        body:       JSON.stringify({ error: 'SESSION_NOT_EMPTY', message: 'Session already has messages' }),
      }
    }

    // Feature gate — if disabled, treat as if the endpoint doesn't exist so the
    // frontend's fallback path (empty state) takes over cleanly.
    if (!isMemoryEnabled()) return notFound('Greeting')

    const snapshot = await buildSituationSnapshot(db, vehicleId, ctx.customerId)
    if (!snapshot) return notFound('Vehicle')

    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY ?? '')
    const model = genAI.getGenerativeModel({
      model:             'gemini-2.5-flash',
      systemInstruction: { role: 'system', parts: [{ text: GREETING_INSTRUCTION }] },
      generationConfig:  { thinkingConfig: { thinkingBudget: 0 } } as any,
    })

    let greetingText: string
    try {
      const result = await model.generateContent({
        contents: [{
          role:  'user',
          parts: [{ text: `Snapshot for this greeting:\n${JSON.stringify(snapshot, null, 2)}` }],
        }],
      })
      greetingText = result.response.text().trim()
      if (!greetingText) throw new Error('empty greeting')
    } catch (err) {
      // AI failure — return 503 so the frontend falls back to the empty state.
      console.error('Greeting generation failed:', err)
      return {
        statusCode: 503,
        headers:    { 'Content-Type': 'application/json' },
        body:       JSON.stringify({ error: 'AI_UNAVAILABLE', message: 'Greeting generation failed, safe to retry' }),
      }
    }

    const [insert] = await db.query<any>(
      `INSERT INTO customer_vehicle_chats (vehicle_id, customer_id, session_id, role, content)
       VALUES (?, ?, ?, 'model', ?)`,
      [vehicleId, ctx.customerId, sessionId, greetingText],
    )
    await db.query('UPDATE customer_chat_sessions SET updated_at = NOW() WHERE id = ?', [sessionId])

    return ok({ messageId: Number(insert.insertId), content: greetingText })
  } catch (err) {
    return serverError(err)
  }
}
