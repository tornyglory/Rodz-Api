import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { getAuthContext } from '../../shared/auth'
import { created, forbidden, validationError, serverError } from '../../shared/errors'
import { invalidateActivePromptCache } from '../../shared/prompts'
import { PromptVersionRow, VERSION_SELECT, shapeVersion, nextVersionLabel, validateSlug, fetchFeedbackAggregates } from './_helpers'

const ready = bootstrap()

// POST /admin/prompts
// Body: { basePrompt: string, learnedGuidance?: any[], notes?: string, slug?: string }
//
// Saves a new manual prompt version and activates it in one transaction.
// The previous active row is flipped to inactive. If `learnedGuidance`
// is omitted, the current active version's guidance is copied so the
// operator doesn't accidentally wipe accumulated rules by saving a
// tweaked base prompt.
//
// Super-admin only.
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getAuthContext(event)
  if (ctx.role !== 'super_admin') return forbidden()

  let body: Record<string, unknown>
  try { body = JSON.parse(event.body ?? '{}') } catch { return validationError('Body must be JSON.') }

  const basePrompt = typeof body.basePrompt === 'string' ? body.basePrompt.trim() : ''
  if (!basePrompt) return validationError('basePrompt is required.')

  const notes = typeof body.notes === 'string' ? body.notes.trim().slice(0, 500) : null

  let slug: string | null
  try { slug = validateSlug(body.slug) } catch (msg) { return validationError(String(msg)) }

  const guidanceProvided = 'learnedGuidance' in body
  const providedGuidance = guidanceProvided && Array.isArray(body.learnedGuidance) ? body.learnedGuidance : null

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()

    // Load current active in full shape — used for parent id, guidance
    // fallback, AND the `previous` field on the response (so the frontend
    // can render a before/after diff without a second fetch).
    const [activeRows] = await conn.query<any[]>(
      `SELECT ${VERSION_SELECT}
       FROM prompt_versions v
       LEFT JOIN staff s ON s.id = v.saved_by
       WHERE v.is_active = 1 LIMIT 1`,
    )
    const activeRow    = activeRows[0] ?? null
    const guidanceOut  = providedGuidance
      ?? (activeRow ? normaliseGuidance(activeRow.learned_guidance) : [])

    const label = await nextVersionLabel(conn, slug)

    // Flip current active off. Do this BEFORE the insert so the virtual
    // active_lock uniqueness constraint doesn't fire.
    if (activeRow) {
      await conn.query(`UPDATE prompt_versions SET is_active = 0 WHERE id = ?`, [activeRow.id])
    }

    const [ins]: any = await conn.query(
      `INSERT INTO prompt_versions
         (version_label, base_prompt, learned_guidance, notes, source, parent_version_id, saved_by, is_active)
       VALUES (?, ?, CAST(? AS JSON), ?, 'manual', ?, ?, 1)`,
      [
        label,
        basePrompt,
        JSON.stringify(guidanceOut),
        notes,
        activeRow ? activeRow.id : null,
        Number(ctx.staffId),
      ],
    )

    // Read the shaped row on the same connection BEFORE commit/release so
    // we don't try to grab a second connection from a limit-1 pool.
    const [rows] = await conn.query<any[]>(
      `SELECT ${VERSION_SELECT}
       FROM prompt_versions v
       LEFT JOIN staff s ON s.id = v.saved_by
       WHERE v.id = ? LIMIT 1`,
      [ins.insertId],
    )

    // Feedback aggregates for BOTH the new row (always null, no ratings
    // yet) and the previous row so the diff view can show the up-rate
    // the outgoing version accumulated.
    const labels: string[] = []
    if (rows[0])    labels.push(rows[0].version_label)
    if (activeRow) labels.push(activeRow.version_label)
    const feedback = await fetchFeedbackAggregates(conn, labels)

    await conn.commit()

    await invalidateActivePromptCache()

    const shaped   = shapeVersion(rows[0] as PromptVersionRow, feedback.get(rows[0].version_label) ?? null)
    const previous = activeRow
      // The activeRow snapshot was captured pre-commit — override
      // is_active so the shaped `previous` reflects the post-mutation
      // state (it's now inactive).
      ? shapeVersion({ ...activeRow, is_active: 0 } as PromptVersionRow, feedback.get(activeRow.version_label) ?? null)
      : null

    return created({ ...shaped, previous })
  } catch (err) {
    try { await conn.rollback() } catch { /* ignore */ }
    return serverError(err)
  } finally {
    conn.release()
  }
}

function normaliseGuidance(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw
  if (typeof raw === 'string') {
    try { const p = JSON.parse(raw); return Array.isArray(p) ? p : [] } catch { return [] }
  }
  return []
}
