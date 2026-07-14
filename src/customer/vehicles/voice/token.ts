import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../../shared/bootstrap'
import { getPool } from '../../../shared/db'
import { ok, forbidden, notFound, serverError } from '../../../shared/errors'
import { getCustomerContext, getCustomerTier } from '../../_helpers'
import { getCachedVehicleContext } from '../chats/_grounding'
import { BOOKING_TOOL_DECLARATIONS } from '../chats/_tools'

const ready = bootstrap()

const VOICE_MODE_ENABLED       = process.env.VOICE_MODE_ENABLED === 'true'
const VOICE_MODEL              = process.env.VOICE_MODEL              ?? 'gemini-2.5-flash-native-audio-preview-09-2025'
const VOICE_VOICE_NAME         = process.env.VOICE_VOICE_NAME         ?? 'Aoede'
const VOICE_SESSION_TTL_SEC    = Number(process.env.VOICE_SESSION_TTL_SECONDS  ?? 900)
const VOICE_DAILY_LIMIT_SEC    = Number(process.env.VOICE_DAILY_LIMIT_SECONDS ?? 1800)
const GEMINI_VOICE_API_KEY     = process.env.GEMINI_VOICE_API_KEY ?? ''

// Ephemeral tokens live on v1alpha only. The WS method must be
// BidiGenerateContentConstrained (not BidiGenerateContent) — the plain
// method rejects ephemeral tokens with 1008 "unregistered callers".
const WS_URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained'

function errBody(code: string, message: string, extra: object = {}): APIGatewayProxyResultV2 {
  const status = code === 'UNAUTHORIZED' ? 401
    : code === 'FORBIDDEN_TIER' || code === 'FORBIDDEN_VEHICLE' ? 403
    : code === 'NOT_FOUND'      ? 404
    : code === 'RATE_LIMITED'   ? 429
    : code === 'UPSTREAM'       ? 503
    : code === 'DISABLED'       ? 503
    : 500
  return {
    statusCode: status,
    headers:    { 'Content-Type': 'application/json' },
    body:       JSON.stringify({ error: code, message, ...extra }),
  }
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready

  if (!VOICE_MODE_ENABLED) return errBody('DISABLED', 'Voice mode is disabled.')
  if (!GEMINI_VOICE_API_KEY) return errBody('UPSTREAM', 'Voice API key not configured.')

  const db        = getPool()
  const ctx       = getCustomerContext(event)
  const vehicleId = Number(event.pathParameters?.id)
  if (!ctx.customerId) return errBody('UNAUTHORIZED', 'Missing customer context')

  try {
    // Ownership
    const [[ownership]] = await db.query<any[]>(
      'SELECT id FROM vehicle_owners WHERE vehicle_id = ? AND customer_id = ? AND is_current = 1 LIMIT 1',
      [vehicleId, ctx.customerId],
    )
    if (!ownership) return errBody('FORBIDDEN_VEHICLE', "You don't own this vehicle.")

    // Tier gate — Gold only
    const tier = await getCustomerTier(db, ctx.customerId)
    if (tier !== 'gold') return errBody('FORBIDDEN_TIER', 'Voice mode is a Gold-tier feature.')

    // Daily quota check
    const [[usage]] = await db.query<any[]>(
      `SELECT COALESCE(SUM(seconds), 0) AS used_today
       FROM   customer_voice_usage
       WHERE  customer_id = ? AND created_at >= CURDATE()`,
      [ctx.customerId],
    )
    const usedToday = Number(usage?.used_today ?? 0)
    if (usedToday >= VOICE_DAILY_LIMIT_SEC) {
      const tomorrow = new Date()
      tomorrow.setUTCHours(24, 0, 0, 0)
      return errBody('RATE_LIMITED', `Daily voice limit reached.`, {
        retryAfter: tomorrow.toISOString(),
        usedToday, dailyLimit: VOICE_DAILY_LIMIT_SEC,
      })
    }

    // Session — reuse if provided, else create new
    const body      = JSON.parse(event.body ?? '{}')
    let sessionId   = body.sessionId ? Number(body.sessionId) : null
    if (sessionId) {
      const [[owned]] = await db.query<any[]>(
        `SELECT id FROM customer_chat_sessions
         WHERE id = ? AND vehicle_id = ? AND customer_id = ? AND deleted_at IS NULL LIMIT 1`,
        [sessionId, vehicleId, ctx.customerId],
      )
      if (!owned) return errBody('NOT_FOUND', 'Session not found.')
    } else {
      const [result] = await db.query<any>(
        'INSERT INTO customer_chat_sessions (vehicle_id, customer_id) VALUES (?, ?)',
        [vehicleId, ctx.customerId],
      )
      sessionId = Number(result.insertId)
    }

    // Grounded system prompt — reuse the text-chat vehicle context builder
    const [vehicleContext, [[customerRow]]] = await Promise.all([
      getCachedVehicleContext(db, vehicleId),
      db.query<any[]>('SELECT first_name FROM customers WHERE id = ? LIMIT 1', [ctx.customerId]),
    ])
    const firstName = customerRow?.first_name ?? null
    const today     = new Date().toISOString().slice(0, 10)

    const systemPrompt = `You are Rod, a voice assistant on the phone with the vehicle's owner. This is a spoken conversation — keep responses short, 2–3 sentences unless they ask for detail. Speak naturally.
${firstName ? `\nThe customer's name is ${firstName}. Use it occasionally where it feels warm.\n` : ''}
Today's date is ${today}. Always use this when reasoning about availability, service due dates, or anything time-related.

Available Rodz locations:
- Rodz Somerville (storeId: 1) — Somerville VIC

${vehicleContext}

When helping with booking, follow the same steps as text chat but keep them conversational:
1. Call getServiceTypes to fetch the real service list before naming any service
2. Present services conversationally — do NOT invent names or guess IDs
3. If a specific date is mentioned, call checkTimeSlots for that date. Otherwise call checkAvailability for the relevant month
4. When the customer picks a time, that IS their selection — do NOT re-check availability
5. Ask how they'll manage their car — drop off, wait, or courtesy car
6. If they want a courtesy car, call checkCourtesyCars
7. Summarise all details verbally and ask them to confirm before calling bookAppointment
8. After booking, read back the booking reference clearly

Voice-mode style rules:
- Numbers spoken naturally: "two-fifty" not "$250"
- Rego plates: spell each character ("L-W-F-two-five-one")
- If the user interrupts, stop and listen
- Confirm bookings back to them before saying goodbye

If the customer asks what their vehicle is worth, use getVehicleValue.
Do NOT offer to remember things, look up past sessions, or discuss fuel/expense history — that's for text chat. Redirect politely if asked.`

    // Mint the ephemeral token
    const now             = new Date()
    const tokenExpiry     = new Date(now.getTime() + 60 * 1000)                         // 60s window to open the WS
    const sessionExpiry   = new Date(now.getTime() + VOICE_SESSION_TTL_SEC * 1000)      // hard cap on session duration
    const tokenReqBody = {
      expireTime:           tokenExpiry.toISOString(),
      newSessionExpireTime: sessionExpiry.toISOString(),
      uses:                 1,
      bidiGenerateContentSetup: {
        model: `models/${VOICE_MODEL}`,
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig:       { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE_VOICE_NAME } } },
        },
        systemInstruction:  { parts: [{ text: systemPrompt }] },
        tools:              [{ functionDeclarations: BOOKING_TOOL_DECLARATIONS }],
        // Live text captions — empty objects enable with defaults.
        // Gemini emits `serverContent.outputTranscription.text` for Rod's
        // spoken response and `serverContent.inputTranscription.text` for
        // what it heard the user say. Frontend renders both live.
        outputAudioTranscription: {},
        inputAudioTranscription:  {},
      },
    }

    const upstream = await fetch(
      `https://generativelanguage.googleapis.com/v1alpha/auth_tokens?key=${GEMINI_VOICE_API_KEY}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(tokenReqBody) },
    )
    if (!upstream.ok) {
      const errText = await upstream.text().catch(() => '')
      console.error('[voice/token] upstream failed', upstream.status, errText.slice(0, 500))
      return errBody('UPSTREAM', `Voice provider returned ${upstream.status}`)
    }
    const upstreamJson: any = await upstream.json()

    // Google's ephemeral-token response contains `name` (the token identifier)
    // and `expireTime`. The token used by the client is `name` — passed as
    // `access_token` query param on the WebSocket URL.
    const token = upstreamJson.name ?? upstreamJson.token ?? null
    if (!token) {
      console.error('[voice/token] no token in upstream response', JSON.stringify(upstreamJson).slice(0, 500))
      return errBody('UPSTREAM', 'No token in provider response.')
    }

    return ok({
      token,
      expiresAt: sessionExpiry.toISOString(),
      sessionId,
      wsUrl:     WS_URL,
      audioConfig: {
        inputSampleRate:  16000,
        outputSampleRate: 24000,
        encoding:         'pcm16le',
      },
    })
  } catch (err) {
    return serverError(err)
  }
}
