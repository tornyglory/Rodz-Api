import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { getAuthContext } from '../../shared/auth'
import { ok, forbidden, serverError } from '../../shared/errors'

const ready = bootstrap()

// GET /admin/chat-feedback?days=7&downLimit=50
//
// Weekly-review feed for the AI chat 👍/👎 signal. Super-admin only.
// Returns:
//   - `summary`         — totals + up-rate for the whole window
//   - `byPromptVersion` — same stats grouped by prompt_version so we can
//                         see whether a prompt change moved the needle
//   - `recentDown`      — most-recent 👎 rows with reasons for triage;
//                         the messageId links back to the session so a
//                         reviewer can see the exact reply in context.
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getAuthContext(event)

  if (ctx.role !== 'super_admin') return forbidden()

  const qs        = event.queryStringParameters ?? {}
  const days      = clamp(Number(qs.days) || 7, 1, 90)
  const downLimit = clamp(Number(qs.downLimit) || 50, 1, 200)

  try {
    const [[summary]] = await db.query<any[]>(
      `SELECT
         COUNT(*)                                     AS total,
         SUM(CASE WHEN rating = 'up'   THEN 1 ELSE 0 END) AS up_count,
         SUM(CASE WHEN rating = 'down' THEN 1 ELSE 0 END) AS down_count
       FROM chat_message_feedback
       WHERE created_at >= (NOW() - INTERVAL ? DAY)`,
      [days],
    )

    const [byVersion] = await db.query<any[]>(
      `SELECT
         COALESCE(prompt_version, '(unversioned)')       AS prompt_version,
         COUNT(*)                                        AS total,
         SUM(CASE WHEN rating = 'up'   THEN 1 ELSE 0 END) AS up_count,
         SUM(CASE WHEN rating = 'down' THEN 1 ELSE 0 END) AS down_count
       FROM chat_message_feedback
       WHERE created_at >= (NOW() - INTERVAL ? DAY)
       GROUP BY COALESCE(prompt_version, '(unversioned)')
       ORDER BY total DESC`,
      [days],
    )

    const [recentDown] = await db.query<any[]>(
      `SELECT customer_id, vehicle_id, session_id, message_id,
              reason, prompt_version, created_at
       FROM chat_message_feedback
       WHERE rating = 'down' AND created_at >= (NOW() - INTERVAL ? DAY)
       ORDER BY created_at DESC
       LIMIT ?`,
      [days, downLimit],
    )

    return ok({
      windowDays: days,
      summary: shapeSummary(summary),
      byPromptVersion: byVersion.map(shapeVersionRow),
      recentDown: recentDown.map((r: any) => ({
        customerId:    Number(r.customer_id),
        vehicleId:     Number(r.vehicle_id),
        sessionId:     Number(r.session_id),
        messageId:     String(r.message_id),
        reason:        r.reason ?? null,
        promptVersion: r.prompt_version ?? null,
        createdAt:     toIso(r.created_at),
      })),
    })
  } catch (err) {
    return serverError(err)
  }
}

function shapeSummary(row: any) {
  const total = Number(row?.total ?? 0)
  const up    = Number(row?.up_count ?? 0)
  const down  = Number(row?.down_count ?? 0)
  return {
    total,
    up,
    down,
    upRate: total > 0 ? Number((up / total).toFixed(3)) : null,
  }
}

function shapeVersionRow(row: any) {
  const total = Number(row.total)
  const up    = Number(row.up_count)
  const down  = Number(row.down_count)
  return {
    promptVersion: row.prompt_version === '(unversioned)' ? null : String(row.prompt_version),
    total,
    up,
    down,
    upRate: total > 0 ? Number((up / total).toFixed(3)) : null,
  }
}

function toIso(v: any): string {
  if (v instanceof Date) return v.toISOString()
  const d = new Date(String(v))
  return isNaN(d.getTime()) ? String(v) : d.toISOString()
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}
