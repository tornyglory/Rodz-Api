import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { getAuthContext } from '../../shared/auth'
import { created, forbidden, validationError, serverError } from '../../shared/errors'
import { invalidateActivePromptCache, LearnedGuidance } from '../../shared/prompts'
import { PromptVersionRow, VERSION_SELECT, shapeVersion, nextVersionLabel, fetchFeedbackAggregates } from './_helpers'

const ready = bootstrap()

// POST /admin/prompts/apply-edits
// Body: {
//   edits: [
//     { target: 'system-prompt' | 'agent', agentName?: string, instruction: string, rationale?: string }
//   ],
//   sourceReview?: { windowDays, cached, reviewedCount },
//   notes?: string
// }
//
// Appends the accepted edits to the current active version's
// `learned_guidance` array and saves as a new active version, source =
// 'review-apply'. Same transaction pattern as manual save.
//
// Super-admin only.
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getAuthContext(event)
  if (ctx.role !== 'super_admin') return forbidden()

  let body: Record<string, unknown>
  try { body = JSON.parse(event.body ?? '{}') } catch { return validationError('Body must be JSON.') }

  const editsRaw = Array.isArray(body.edits) ? body.edits : []
  if (editsRaw.length === 0) return validationError('edits[] is required and must be non-empty.')

  const newEntries: LearnedGuidance[] = []
  const nowIso = new Date().toISOString()
  const staffId = Number(ctx.staffId)

  const sourceReview = normaliseSourceReview(body.sourceReview)
  const fromReview = sourceReview
    ? { windowDays: Number(sourceReview.windowDays ?? 0), reviewedCount: Number(sourceReview.reviewedCount ?? 0) }
    : null

  for (const raw of editsRaw) {
    if (!raw || typeof raw !== 'object') return validationError('Each edit must be an object.')
    const e = raw as Record<string, unknown>
    const target = e.target === 'agent' ? 'agent' : 'system-prompt'
    const agentName = typeof e.agentName === 'string' ? e.agentName.trim().slice(0, 60) : null
    if (target === 'agent' && !agentName) return validationError('agentName is required when target = agent.')
    const instruction = typeof e.instruction === 'string' ? e.instruction.trim() : ''
    if (!instruction) return validationError('Each edit must have an instruction string.')
    const rationale = typeof e.rationale === 'string' ? e.rationale.trim().slice(0, 500) : ''

    newEntries.push({
      instruction: instruction.slice(0, 800),
      rationale,
      target,
      agentName: target === 'agent' ? agentName : null,
      addedAt:   nowIso,
      addedBy:   staffId,
      fromReview,
    })
  }

  const notes = typeof body.notes === 'string' ? body.notes.trim().slice(0, 500) : null

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()

    // Full shape so we can return the previous row alongside the new one
    // as `previous` on the response.
    const [activeRows] = await conn.query<any[]>(
      `SELECT ${VERSION_SELECT}
       FROM prompt_versions v
       LEFT JOIN staff s ON s.id = v.saved_by
       WHERE v.is_active = 1 LIMIT 1`,
    )
    if (activeRows.length === 0) {
      await conn.rollback()
      return validationError('No active prompt version — seed v1 first.')
    }
    const activeRow = activeRows[0]

    const currentGuidance = normaliseGuidance(activeRow.learned_guidance)
    const combined = [...currentGuidance, ...newEntries]

    const label = await nextVersionLabel(conn, null)

    await conn.query(`UPDATE prompt_versions SET is_active = 0 WHERE id = ?`, [activeRow.id])

    const [ins]: any = await conn.query(
      `INSERT INTO prompt_versions
         (version_label, base_prompt, learned_guidance, notes, source, source_review, parent_version_id, saved_by, is_active)
       VALUES (?, ?, CAST(? AS JSON), ?, 'review-apply', CAST(? AS JSON), ?, ?, 1)`,
      [
        label,
        String(activeRow.base_prompt),
        JSON.stringify(combined),
        notes,
        sourceReview ? JSON.stringify(sourceReview) : null,
        activeRow.id,
        staffId,
      ],
    )

    const [rows] = await conn.query<any[]>(
      `SELECT ${VERSION_SELECT}
       FROM prompt_versions v
       LEFT JOIN staff s ON s.id = v.saved_by
       WHERE v.id = ? LIMIT 1`,
      [ins.insertId],
    )

    const feedback = await fetchFeedbackAggregates(conn, [rows[0].version_label, activeRow.version_label])

    await conn.commit()

    await invalidateActivePromptCache()

    const shaped = shapeVersion(rows[0] as PromptVersionRow, feedback.get(rows[0].version_label) ?? null)
    // activeRow was captured pre-commit — override is_active so the
    // shaped `previous` reflects the post-mutation state.
    const previous = shapeVersion({ ...activeRow, is_active: 0 } as PromptVersionRow, feedback.get(activeRow.version_label) ?? null)

    return created({ ...shaped, previous })
  } catch (err) {
    try { await conn.rollback() } catch { /* ignore */ }
    return serverError(err)
  } finally {
    conn.release()
  }
}

function normaliseSourceReview(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object') return null
  const src = raw as Record<string, unknown>
  const out: Record<string, unknown> = {}
  if ('windowDays'    in src) out.windowDays    = Number(src.windowDays)
  if ('cached'        in src) out.cached        = Boolean(src.cached)
  if ('reviewedCount' in src) out.reviewedCount = Number(src.reviewedCount)
  return Object.keys(out).length > 0 ? out : null
}

function normaliseGuidance(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw
  if (typeof raw === 'string') {
    try { const p = JSON.parse(raw); return Array.isArray(p) ? p : [] } catch { return [] }
  }
  return []
}
