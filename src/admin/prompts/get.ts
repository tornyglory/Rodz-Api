import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { getAuthContext } from '../../shared/auth'
import { ok, forbidden, notFound, serverError } from '../../shared/errors'
import { PromptVersionRow, VERSION_SELECT, fetchFeedbackAggregates, shapeVersion } from './_helpers'

const ready = bootstrap()

// GET /admin/prompts/{id}
//
// Full detail for a single prompt version. Companion to the lite mode of
// the list endpoint — search returns lite rows for speed, the reviewer
// clicks a row, this endpoint loads the full `basePrompt` +
// `learnedGuidance` for that specific version.
//
// Super-admin only.
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getAuthContext(event)
  if (ctx.role !== 'super_admin') return forbidden()

  const id = Number(event.pathParameters?.id)
  if (!Number.isFinite(id) || id <= 0) return notFound('Version')

  try {
    const [rows] = await db.query<any[]>(
      `SELECT ${VERSION_SELECT}
       FROM prompt_versions v
       LEFT JOIN staff s ON s.id = v.saved_by
       WHERE v.id = ?
       LIMIT 1`,
      [id],
    )
    if (rows.length === 0) return notFound('Version')

    const row      = rows[0] as PromptVersionRow
    const feedback = (await fetchFeedbackAggregates(db, [String(row.version_label)])).get(String(row.version_label)) ?? null

    return ok(shapeVersion(row, feedback))
  } catch (err) {
    return serverError(err)
  }
}
