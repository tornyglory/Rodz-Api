import { GoogleGenerativeAI } from '@google/generative-ai'
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'

const ready = bootstrap()

const REGION    = process.env.REGION            ?? 'ap-southeast-2'
const DATA_LAKE = process.env.DATA_LAKE_BUCKET  ?? 'rodz-data-lake'
const s3 = new S3Client({ region: REGION })

// Async invoked by POST /quotes/:id/voice-notes and by the retry endpoint.
// Reads the audio from S3, passes to Gemini 2.5 Flash for transcription,
// writes the result back on the DB row.
//
// Idempotent by design: on entry we only proceed if transcript_status is
// 'pending' or 'failed' (retries). Any other state is a no-op.
export const handler = async (event: { noteId?: number }): Promise<{ ok: boolean; reason?: string }> => {
  await ready
  const db = getPool()
  const noteId = Number(event?.noteId ?? 0)
  if (!noteId) return { ok: false, reason: 'missing_note_id' }

  try {
    const [[row]] = await db.query<any[]>(
      `SELECT id, s3_key, content_type, duration_seconds, transcript_status
       FROM quote_voice_notes WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
      [noteId],
    )
    if (!row) return { ok: false, reason: 'note_not_found' }
    if (row.transcript_status === 'ready') return { ok: true, reason: 'already_ready' }

    // Pull audio bytes from S3
    const s3Res = await s3.send(new GetObjectCommand({ Bucket: DATA_LAKE, Key: row.s3_key }))
    if (!s3Res.Body) throw new Error('empty S3 body')

    const chunks: Buffer[] = []
    for await (const chunk of s3Res.Body as any) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
    const audioBase64 = Buffer.concat(chunks).toString('base64')

    // Call Gemini with native audio input
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY ?? '')
    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      generationConfig: { maxOutputTokens: 800, thinkingConfig: { thinkingBudget: 0 } } as any,
    })

    const durationHint = Number(row.duration_seconds).toFixed(1)
    const prompt = `Transcribe this ~${durationHint}-second voice note from a mechanic inspecting an Australian customer's vehicle. Return the transcript only — no preamble, no quote marks, no "Here is the transcript:" framing. Use natural sentence casing and full stops. Preserve the mechanic's phrasing. If the audio is silent or garbled, return the exact string: <no audio>.`

    const result = await model.generateContent([
      { text: prompt },
      { inlineData: { mimeType: row.content_type, data: audioBase64 } },
    ])

    const raw = result.response.text().trim()
    const transcript = raw === '<no audio>' ? '' : raw

    await db.query(
      `UPDATE quote_voice_notes
       SET transcript = ?, transcript_status = 'ready'
       WHERE id = ?`,
      [transcript || null, noteId],
    )

    return { ok: true }
  } catch (err) {
    console.error('[voice-notes] transcription failed', noteId, err)
    try {
      await db.query(
        `UPDATE quote_voice_notes SET transcript_status = 'failed' WHERE id = ?`,
        [noteId],
      )
    } catch {}
    return { ok: false, reason: 'transcription_error' }
  }
}
