import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { PollyClient, SynthesizeSpeechCommand, type Engine, type VoiceId, type TextType } from '@aws-sdk/client-polly'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { getCustomerContext, getCustomerTier } from '../_helpers'
import { serverError } from '../../shared/errors'

const ready = bootstrap()

const CHAT_TTS_ENABLED = process.env.CHAT_TTS_ENABLED === 'true'
const DAILY_LIMIT_SEC  = Number(process.env.VOICE_DAILY_LIMIT_SECONDS ?? 1800)
const MAX_CHARS        = 3000

// Polly client — one per Lambda container. Region defaults to REGION env
// (ap-southeast-2 in the shared env) which puts synthesis close to AU users.
const polly = new PollyClient({ region: process.env.REGION ?? 'ap-southeast-2' })

// Australian voices — Olivia is neural + natural. Nicole is the legacy
// standard voice; fall back to it only if Olivia synthesis fails.
const ALLOWED_VOICES = new Set<VoiceId>(['Olivia', 'Nicole'])
const DEFAULT_VOICE: VoiceId = 'Olivia'

function errBody(code: string, message: string, extra: object = {}): APIGatewayProxyResultV2 {
  const status = code === 'UNAUTHORIZED'    ? 401
    : code === 'FORBIDDEN_TIER'             ? 403
    : code === 'INVALID_TEXT'               ? 400
    : code === 'RATE_LIMITED'               ? 429
    : code === 'UPSTREAM' || code === 'DISABLED' ? 503
    : 500
  return {
    statusCode: status,
    headers:    { 'Content-Type': 'application/json' },
    body:       JSON.stringify({ error: code, message, ...extra }),
  }
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  if (!CHAT_TTS_ENABLED) return errBody('DISABLED', 'Chat TTS is disabled.')

  const db  = getPool()
  const ctx = getCustomerContext(event)
  if (!ctx.customerId) return errBody('UNAUTHORIZED', 'Missing customer context')

  try {
    // Tier gate — Gold only (matching current voice mode policy)
    const tier = await getCustomerTier(db, ctx.customerId)
    if (tier !== 'gold') return errBody('FORBIDDEN_TIER', 'Chat TTS is a Gold-tier feature.')

    // Parse + validate input
    const body      = JSON.parse(event.body ?? '{}')
    const text      = typeof body.text === 'string' ? body.text.trim() : ''
    const rawVoice  = typeof body.voice === 'string' ? body.voice.trim() : ''
    const sessionId = body.sessionId != null ? Number(body.sessionId) || null : null

    if (!text)                  return errBody('INVALID_TEXT', 'text is required')
    if (text.length > MAX_CHARS) return errBody('INVALID_TEXT', `text must be ≤ ${MAX_CHARS} chars (got ${text.length})`)

    const voice: VoiceId = ALLOWED_VOICES.has(rawVoice as VoiceId) ? (rawVoice as VoiceId) : DEFAULT_VOICE
    const textType: TextType = /^\s*<speak/i.test(text) ? 'ssml' : 'text'

    // Daily quota — reuse customer_voice_usage
    const [[usage]] = await db.query<any[]>(
      `SELECT COALESCE(SUM(seconds), 0) AS used_today
       FROM   customer_voice_usage
       WHERE  customer_id = ? AND created_at >= CURDATE()`,
      [ctx.customerId],
    )
    const usedToday = Number(usage?.used_today ?? 0)
    if (usedToday >= DAILY_LIMIT_SEC) {
      const tomorrow = new Date()
      tomorrow.setUTCHours(24, 0, 0, 0)
      return errBody('RATE_LIMITED', 'Daily voice limit reached.', {
        retryAfter: tomorrow.toISOString(),
        usedToday, dailyLimit: DAILY_LIMIT_SEC,
      })
    }

    // Synthesize
    let audio: Uint8Array
    let engine: Engine = 'neural'
    try {
      const res = await polly.send(new SynthesizeSpeechCommand({
        Text:         text,
        TextType:     textType,
        VoiceId:      voice,
        Engine:       engine,
        OutputFormat: 'mp3',
        SampleRate:   '24000',
        LanguageCode: 'en-AU',
      }))
      if (!res.AudioStream) throw new Error('empty AudioStream')
      audio = await (res.AudioStream as any).transformToByteArray()
    } catch (err: any) {
      // Olivia neural may not exist in every region — fall back to Nicole standard once.
      if (voice === 'Olivia') {
        try {
          engine = 'standard'
          const res = await polly.send(new SynthesizeSpeechCommand({
            Text:         text,
            TextType:     textType,
            VoiceId:      'Nicole',
            Engine:       'standard',
            OutputFormat: 'mp3',
            SampleRate:   '24000',
            LanguageCode: 'en-AU',
          }))
          if (!res.AudioStream) throw new Error('empty AudioStream')
          audio = await (res.AudioStream as any).transformToByteArray()
        } catch (fallbackErr: any) {
          console.error('[chat/tts] Polly failed (Olivia + Nicole fallback):', fallbackErr?.message)
          return errBody('UPSTREAM', 'TTS provider unavailable.')
        }
      } else {
        console.error('[chat/tts] Polly failed:', err?.message)
        return errBody('UPSTREAM', 'TTS provider unavailable.')
      }
    }

    // Rough MP3 duration estimate: ~64 kbps ≈ 8000 bytes/sec at 24 kHz mono.
    // Good enough for the daily quota — precise duration would need SpeechMarks.
    const seconds = Math.max(1, Math.ceil(audio.byteLength / 8000))
    await db.query(
      `INSERT INTO customer_voice_usage (customer_id, session_id, seconds, ended_reason)
       VALUES (?, ?, ?, 'tts')`,
      [ctx.customerId, sessionId, seconds],
    ).catch(err => console.warn('[chat/tts] usage log failed:', (err as Error).message))

    return {
      statusCode: 200,
      headers: {
        'Content-Type':   'audio/mpeg',
        'Content-Length': String(audio.byteLength),
        'Cache-Control':  'no-store',
      },
      isBase64Encoded: true,
      body: Buffer.from(audio).toString('base64'),
    }
  } catch (err) {
    return serverError(err)
  }
}
