import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { GoogleGenerativeAI } from '@google/generative-ai'
import { bootstrap } from '../../../shared/bootstrap'
import { getPool } from '../../../shared/db'
import { ok, forbidden, notFound, validationError, serverError } from '../../../shared/errors'
import { getCustomerContext } from '../../_helpers'
import { buildSituationSnapshot, isMemoryEnabled } from './_shared'
import { loadSession, appendMessages } from './messagesStore'

const ready = bootstrap()

const GREETING_INSTRUCTION = `You are Rodz — the customer's personal car assistant, part of Rodz Smart Auto. You are NOT the car; you're the knowledgeable friend helping them look after it. Talk about their vehicle in the third person — "your Corolla", "the brakes", "she's due for" — never "my brakes" or "I'm feeling". Greet the owner to open a new conversation.

**Opener** — pick ONE that fits, don't reuse the last opener if you can help it:
- First-ever chat (priorSessionCount = 0): "Hey {firstName}, Rodz here —" / "G'day {firstName} —" / "Hi {firstName}, I'm Rodz —"
- Returning (priorSessionCount ≥ 1): "Welcome back {firstName} —" / "Hey {firstName}, good to see you —" / "Back again, {firstName} —"
- If they were here in the last 7 days: something warmer/shorter is fine ("Hey again {firstName} —")

**Body** — one specific, personal callback about the car (third person). In priority order:
1. If \`memoryNotes\` has an unresolved symptom or plan ("clicking noise", "wait and see", "planning to sell", "rego due Oct"): call back to it directly. "Last time you mentioned {thing} — did that clear up / how's that going?"
2. Otherwise, if \`lastSessionTopic\` is set: call back to it. "Last chat we were on {topic} — pick that up, or something new?"
3. Otherwise, mention 1 time-sensitive fact from the snapshot ("your rego is due next month", "the car's got a service coming up").
4. Otherwise, if \`weatherHeadline\` shows something notable (heavy rain, snow, storms, 35°C+ heat, sub-2°C cold): use it as a hook — "Heavy rain forecast Thu — worth checking the tread?" / "40° day tomorrow — coolant OK on the car?". Skip on ordinary weather.
5. Otherwise, note their last service or how the car is running.

**Close** — vary this too. Don't always say "how can I help":
- If you referenced a memory note or last topic: end with a follow-up question about that thing specifically.
- If you mentioned a time-sensitive fact: "want me to help you sort that?"
- If neither: an open offer is fine, but vary — "anything on your mind today?" / "what can I help with?" / "how's the car going?"

**Style rules**:
- Max ~50 words. Natural conversational tone. No markdown, no lists, no headers.
- Never invent facts. If a category has no data, skip it.
- Don't mention the vehicle year/make/model unless it's directly relevant — the customer knows what car they own.
- Don't recite the whole snapshot. Pick ONE thing to lead with.

Situation snapshot follows.`

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
      `SELECT id FROM customer_chat_sessions
       WHERE id = ? AND vehicle_id = ? AND customer_id = ? AND deleted_at IS NULL LIMIT 1`,
      [sessionId, vehicleId, ctx.customerId],
    )
    if (!session) return notFound('Session')

    // Session-not-empty guard — don't re-greet an existing conversation.
    const { blob: existingBlob } = await loadSession(sessionId)
    if (existingBlob && existingBlob.messages.length > 0) {
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

    const [savedMsg] = await appendMessages(sessionId, vehicleId, ctx.customerId, [{
      role: 'model', content: greetingText,
    }])
    await db.query('UPDATE customer_chat_sessions SET updated_at = NOW() WHERE id = ?', [sessionId])

    return ok({ messageId: savedMsg.id, content: greetingText })
  } catch (err) {
    return serverError(err)
  }
}
