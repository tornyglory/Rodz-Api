import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { ok, notFound, forbidden, serverError } from '../shared/errors'
import { jobError, getAllowedStoreIds } from './_helpers'

const ready = bootstrap()

export async function getJobCard(db: any, jobId: number) {
  const [items] = await db.query<any[]>(
    `SELECT jci.id, jci.description, jci.qty, jci.sort_order,
            jci.completed, jci.completed_at, jci.notes,
            CONCAT(st.first_name, ' ', LEFT(st.last_name, 1), '.') AS completed_by
     FROM job_card_items jci
     LEFT JOIN staff st ON st.id = jci.completed_by_staff_id
     WHERE jci.job_id = ?
     ORDER BY jci.sort_order, jci.id`,
    [jobId],
  )
  return items
}

export function buildCardResponse(jobId: number, items: any[]) {
  const allComplete = items.length > 0 && items.every((i) => i.completed)
  return {
    jobId,
    allComplete,
    items: items.map((i) => ({
      id:          i.id,
      description: i.description,
      qty:         Number(i.qty),
      sortOrder:   i.sort_order,
      completed:   Boolean(i.completed),
      completedAt: i.completed_at ? new Date(i.completed_at).toISOString() : null,
      completedBy: i.completed_by ?? null,
      notes:       i.notes ?? null,
    })),
  }
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getAuthContext(event)
  const id  = event.pathParameters?.id

  try {
    const [[job]] = await db.query<any[]>(
      'SELECT j.id, j.store_id FROM service_jobs j WHERE j.id = ? LIMIT 1',
      [id],
    )
    if (!job) return jobError(404, 'JOB_NOT_FOUND', 'Job not found.')

    if (ctx.role !== 'super_admin') {
      const allowedIds = await getAllowedStoreIds(db, ctx.staffId)
      if (!allowedIds.includes(job.store_id)) return forbidden()
    }

    const [[{ cnt }]] = await db.query<any[]>(
      'SELECT COUNT(*) AS cnt FROM job_card_items WHERE job_id = ?',
      [job.id],
    )

    if (cnt === 0) {
      const [lineItems] = await db.query<any[]>(
        `SELECT qi.id AS quote_item_id, qi.description, qi.quantity, qi.sort_order
         FROM service_jobs j
         LEFT JOIN quotes jq ON jq.id = j.quote_id
         LEFT JOIN quotes bq ON bq.booking_id = j.booking_id AND bq.id = (
           SELECT MAX(q2.id) FROM quotes q2 WHERE q2.booking_id = j.booking_id
         )
         JOIN quote_items qi ON qi.quote_id = COALESCE(jq.id, bq.id)
         WHERE j.id = ?
           AND COALESCE(jq.status, bq.status) IN ('approved', 'converted', 'invoiced', 'paid')
           AND (qi.is_accepted = 1 OR qi.is_accepted IS NULL)
         ORDER BY qi.sort_order, qi.id`,
        [job.id],
      )

      if (lineItems.length === 0) return notFound('Job card')

      try {
        for (const li of lineItems) {
          await db.query(
            'INSERT INTO job_card_items (job_id, quote_item_id, description, qty, sort_order) VALUES (?, ?, ?, ?, ?)',
            [job.id, li.quote_item_id, li.description, li.quantity, li.sort_order],
          )
        }
      } catch (err: any) {
        // Concurrent request already seeded the card — fall through to fetch
        if (err.code !== 'ER_DUP_ENTRY') throw err
      }
    }

    const items = await getJobCard(db, job.id)
    return ok(buildCardResponse(job.id, items))
  } catch (err) {
    return serverError(err)
  }
}
