import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { getAuthContext } from '../../shared/auth'
import { ok, forbidden, serverError, validationError } from '../../shared/errors'
import { PromptVersionRow, VERSION_SELECT, fetchFeedbackAggregates, shapeVersion, shapeVersionLite } from './_helpers'

const ready = bootstrap()

const CANONICAL_AGENTS = new Set(['booking', 'expense', 'fuel', 'vehicle', 'logbook', 'quote'])
const VALID_SOURCES    = new Set(['manual', 'review-apply', 'revert'])

// GET /admin/prompts?limit=50&source=...&agent=...&q=...&savedBy=...&from=...&to=...&cursor=...&lite=true
//
// Search + filter + pagination over the version history. All filter
// params are optional and combinable — same endpoint powers the "just
// show me the latest 50" editor view AND the "find every version where I
// tweaked the expense agent between March and April" search view.
//
// `lite=true` strips the two large fields (basePrompt + learnedGuidance)
// and returns lightweight rows for list-view rendering. Fetch full detail
// per row via `GET /admin/prompts/{id}`.
//
// `active` is always returned in full shape (unfiltered) so the editor
// can pin the currently-live version regardless of filters.
//
// Super-admin only.
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getAuthContext(event)
  if (ctx.role !== 'super_admin') return forbidden()

  const qs    = event.queryStringParameters ?? {}
  const limit = clamp(Number(qs.limit) || 50, 1, 200)
  const lite  = qs.lite === 'true' || qs.lite === '1'

  // Parse + validate filters.
  const source  = typeof qs.source === 'string' && qs.source.trim() ? qs.source.trim() : null
  if (source && !VALID_SOURCES.has(source)) {
    return validationError(`source must be one of: manual, review-apply, revert.`)
  }

  const agent = typeof qs.agent === 'string' && qs.agent.trim() ? qs.agent.trim() : null
  if (agent && !CANONICAL_AGENTS.has(agent)) {
    return validationError(`agent must be one of: ${Array.from(CANONICAL_AGENTS).join(', ')}.`)
  }

  const q = typeof qs.q === 'string' ? qs.q.trim().slice(0, 200) : ''

  const savedBy = qs.savedBy != null && qs.savedBy !== '' ? Number(qs.savedBy) : null
  if (savedBy != null && (!Number.isFinite(savedBy) || savedBy <= 0)) {
    return validationError('savedBy must be a positive integer.')
  }

  const from = parseDate(qs.from)
  const to   = parseDate(qs.to)
  if ((qs.from && !from) || (qs.to && !to)) {
    return validationError("from and to must be 'YYYY-MM-DD'.")
  }

  const cursor = qs.cursor != null && qs.cursor !== '' ? Number(qs.cursor) : null
  if (cursor != null && (!Number.isFinite(cursor) || cursor <= 0)) {
    return validationError('cursor must be a positive integer id.')
  }

  try {
    // Build WHERE + params dynamically. Base 1=1 so every added clause is
    // a simple `AND …`.
    const where: string[] = ['1 = 1']
    const params: any[] = []

    if (source) {
      where.push('v.source = ?')
      params.push(source)
    }
    if (agent) {
      // MySQL JSON_CONTAINS does deep containment on arrays — returns
      // true if any element of the array is a superset of the candidate.
      where.push(`JSON_CONTAINS(v.learned_guidance, JSON_OBJECT('agentName', ?))`)
      params.push(agent)
    }
    if (q) {
      // LIKE across notes, base_prompt, and the raw JSON text of
      // learned_guidance. Not indexed — fine at hundreds of rows, revisit
      // if we ever hit 100k+.
      const like = `%${q.replace(/[%_]/g, m => '\\' + m)}%`
      where.push(`(
        v.notes       LIKE ?
        OR v.base_prompt LIKE ?
        OR CAST(v.learned_guidance AS CHAR) LIKE ?
      )`)
      params.push(like, like, like)
    }
    if (savedBy != null) {
      where.push('v.saved_by = ?')
      params.push(savedBy)
    }
    if (from) {
      where.push('v.saved_at >= ?')
      params.push(from)
    }
    if (to) {
      // Inclusive to-end-of-day.
      where.push('v.saved_at < DATE_ADD(?, INTERVAL 1 DAY)')
      params.push(to)
    }
    if (cursor != null) {
      // id-based cursor. Rows are ordered DESC, so "next page" = ids
      // strictly less than the cursor.
      where.push('v.id < ?')
      params.push(cursor)
    }

    // Fetch limit+1 to detect hasMore without a COUNT.
    const [rows] = await db.query<any[]>(
      `SELECT ${VERSION_SELECT}
       FROM prompt_versions v
       LEFT JOIN staff s ON s.id = v.saved_by
       WHERE ${where.join(' AND ')}
       ORDER BY v.saved_at DESC, v.id DESC
       LIMIT ?`,
      [...params, limit + 1],
    )

    const hasMore    = rows.length > limit
    const kept       = hasMore ? rows.slice(0, limit) : rows
    const nextCursor = hasMore && kept.length > 0 ? Number(kept[kept.length - 1].id) : null

    // Batch-fetch feedback aggregates for every label in the page.
    const labels    = kept.map((r: any) => String(r.version_label))
    const feedback  = await fetchFeedbackAggregates(db, labels)

    // Active row is always returned unfiltered — powers the "current live
    // version" pin on the editor page.
    const [[activeRow]] = await db.query<any[]>(
      `SELECT ${VERSION_SELECT}
       FROM prompt_versions v
       LEFT JOIN staff s ON s.id = v.saved_by
       WHERE v.is_active = 1
       LIMIT 1`,
    )
    const active = activeRow
      ? shapeVersion(activeRow as PromptVersionRow, (await fetchFeedbackAggregates(db, [activeRow.version_label])).get(activeRow.version_label) ?? null)
      : null

    const shape    = lite ? shapeVersionLite : shapeVersion
    const versions = kept.map((r: PromptVersionRow) => shape(r, feedback.get(String(r.version_label)) ?? null))

    return ok({
      active,
      versions,
      hasMore,
      nextCursor,
    })
  } catch (err) {
    return serverError(err)
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}

function parseDate(v: unknown): string | null {
  if (typeof v !== 'string' || !v) return null
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null
}
