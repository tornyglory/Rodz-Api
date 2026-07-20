import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { getAuthContext } from '../../shared/auth'
import { ok, forbidden, notFound, serverError } from '../../shared/errors'
import { invalidateActivePromptCache } from '../../shared/prompts'
import { PromptVersionRow, VERSION_SELECT, shapeVersion, nextVersionLabel, fetchFeedbackAggregates } from './_helpers'

const ready = bootstrap()

// POST /admin/prompts/{id}/activate
//
// Revert to a prior version. Clones the target row's content into a NEW
// active row with source = 'revert' so the version list reads as a
// linear story (…"applied Rodz edits" → "reverted to v41"…) instead of
// silently rewinding the active flag. Slightly more rows, much cleaner
// audit trail.
//
// Super-admin only.
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getAuthContext(event)
  if (ctx.role !== 'super_admin') return forbidden()

  const targetId = Number(event.pathParameters?.id)
  if (!Number.isFinite(targetId) || targetId <= 0) return notFound('Version')

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()

    const [targetRows] = await conn.query<any[]>(
      `SELECT id, version_label, base_prompt, learned_guidance, is_active
       FROM prompt_versions WHERE id = ? LIMIT 1`,
      [targetId],
    )
    if (targetRows.length === 0) {
      await conn.rollback()
      return notFound('Version')
    }
    const target = targetRows[0]

    // No-op if the target is already active — return the shaped row.
    // `previous` is null in this case (nothing actually changed).
    if (Number(target.is_active) === 1) {
      const shaped = await loadShaped(conn, targetId)
      await conn.commit()
      return ok({ ...shaped, previous: null })
    }

    // Snapshot current active in full shape — used for the parent link
    // AND returned as `previous` on the response for diff rendering.
    const [activeRows] = await conn.query<any[]>(
      `SELECT ${VERSION_SELECT}
       FROM prompt_versions v
       LEFT JOIN staff s ON s.id = v.saved_by
       WHERE v.is_active = 1 LIMIT 1`,
    )
    const previousActive   = activeRows[0] ?? null
    const previousActiveId = previousActive?.id ?? null

    // Flip existing active off.
    if (previousActiveId) {
      await conn.query(`UPDATE prompt_versions SET is_active = 0 WHERE id = ?`, [previousActiveId])
    }

    // Insert a new row that clones the target's content.
    const label = await nextVersionLabel(conn, `revert-of-v${extractN(target.version_label)}`)

    const [ins]: any = await conn.query(
      `INSERT INTO prompt_versions
         (version_label, base_prompt, learned_guidance, notes, source, parent_version_id, saved_by, is_active)
       VALUES (?, ?, CAST(? AS JSON), ?, 'revert', ?, ?, 1)`,
      [
        label,
        String(target.base_prompt),
        typeof target.learned_guidance === 'string' ? target.learned_guidance : JSON.stringify(target.learned_guidance ?? []),
        `Reverted to ${target.version_label}.`,
        previousActiveId,
        Number(ctx.staffId),
      ],
    )

    const shaped = await loadShaped(conn, ins.insertId)

    // Feedback aggregates for shaped + previous — same pattern as the
    // other mutation handlers.
    const labels: string[] = [shaped.versionLabel as string]
    if (previousActive) labels.push(String(previousActive.version_label))
    const feedback = await fetchFeedbackAggregates(conn, labels)

    await conn.commit()

    await invalidateActivePromptCache()

    // Re-shape with feedback for consistency with save/apply responses.
    const shapedWithFeedback = { ...shaped, feedback: feedback.get(shaped.versionLabel as string) ?? null }
    // previousActive was captured pre-commit — override is_active so
    // the shaped `previous` reflects the post-mutation state.
    const previous = previousActive
      ? shapeVersion({ ...previousActive, is_active: 0 } as PromptVersionRow, feedback.get(previousActive.version_label) ?? null)
      : null

    return ok({ ...shapedWithFeedback, previous })
  } catch (err) {
    try { await conn.rollback() } catch { /* ignore */ }
    return serverError(err)
  } finally {
    conn.release()
  }
}

async function loadShaped(db: any, id: number) {
  const [rows] = await db.query(
    `SELECT ${VERSION_SELECT}
     FROM prompt_versions v
     LEFT JOIN staff s ON s.id = v.saved_by
     WHERE v.id = ? LIMIT 1`,
    [id],
  )
  return shapeVersion(rows[0] as PromptVersionRow)
}

function extractN(label: string): number {
  const m = /^v(\d+)-/.exec(label)
  return m ? Number(m[1]) : 0
}
