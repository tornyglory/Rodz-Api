import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import mysql from 'mysql2/promise'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { ok, forbidden, validationError, serverError } from '../shared/errors'
import { jobError, getAllowedStoreIds } from './_helpers'
import { getJobCard, buildCardResponse } from './card-get'
import { sendPickupReadyEmail } from '../shared/emailTemplates'

const ready = bootstrap()

async function sendPickupNotification(db: mysql.Pool, jobId: number): Promise<void> {
  // Only send once per job — skip if already logged
  const [[sent]] = await db.query<any[]>(
    'SELECT id FROM customer_pickup_notifications WHERE job_id = ? LIMIT 1',
    [jobId],
  )
  if (sent) return

  const [[row]] = await db.query<any[]>(
    `SELECT c.first_name, c.last_name, c.email, c.mobile,
            CONCAT(v.year, ' ', v.make, ' ', v.model) AS vehicle_label,
            v.rego,
            s.name AS store_name, s.phone AS store_phone
     FROM service_jobs j
     JOIN customers c ON c.id = j.customer_id
     JOIN stores s    ON s.id = j.store_id
     LEFT JOIN vehicles v ON v.id = j.vehicle_id
     WHERE j.id = ? LIMIT 1`,
    [jobId],
  )
  if (!row) return

  const channel   = 'email'
  const recipient = row.email
  if (!recipient) return

  await sendPickupReadyEmail(db, {
    customerEmail: recipient,
    customer:      `${row.first_name} ${row.last_name}`,
    vehicle:       row.vehicle_label ?? '',
    rego:          row.rego ?? '',
    store:         (row.store_name ?? '').replace(/^Rodz /, ''),
    storePhone:    row.store_phone ?? '',
  })

  await db.query(
    `INSERT INTO customer_pickup_notifications (job_id, channel, recipient, sent_at) VALUES (?, ?, ?, NOW())`,
    [jobId, channel, recipient],
  )
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db     = getPool()
  const ctx    = getAuthContext(event)
  const jobId  = event.pathParameters?.id
  const itemId = event.pathParameters?.itemId

  try {
    const [[job]] = await db.query<any[]>(
      'SELECT j.id, j.store_id, j.status FROM service_jobs j WHERE j.id = ? LIMIT 1',
      [jobId],
    )
    if (!job) return jobError(404, 'JOB_NOT_FOUND', 'Job not found.')

    if (ctx.role !== 'super_admin') {
      const allowedIds = await getAllowedStoreIds(db, ctx.staffId)
      if (!allowedIds.includes(job.store_id)) return forbidden()
    }

    const [[item]] = await db.query<any[]>(
      'SELECT id FROM job_card_items WHERE id = ? AND job_id = ? LIMIT 1',
      [itemId, jobId],
    )
    if (!item) return jobError(404, 'ITEM_NOT_FOUND', 'Job card item not found.')

    const body      = JSON.parse(event.body ?? '{}') as Record<string, unknown>
    const { completed, notes } = body

    if (completed === undefined) return validationError('completed is required.')
    if (typeof completed !== 'boolean') return validationError('completed must be a boolean.')

    const updates: [string, unknown][] = [
      ['completed', completed ? 1 : 0],
      ['completed_at',          completed ? new Date() : null],
      ['completed_by_staff_id', completed ? ctx.staffId : null],
    ]
    if (notes !== undefined) updates.push(['notes', notes ?? null])

    const set    = updates.map(([k]) => `${k} = ?`).join(', ')
    const values = [...updates.map(([, v]) => v), itemId, jobId]
    await db.query(`UPDATE job_card_items SET ${set} WHERE id = ? AND job_id = ?`, values)

    // ── Check overall completion ───────────────────────────────────────────
    const items      = await getJobCard(db, Number(jobId))
    const allDone    = items.length > 0 && items.every((i: any) => i.completed)
    const wasComplete = job.status === 'completed'

    if (allDone && !wasComplete) {
      await db.query(
        `UPDATE service_jobs SET status = 'completed', completed_at = NOW(), updated_at = NOW() WHERE id = ?`,
        [jobId],
      )
      await sendPickupNotification(db, Number(jobId))
    } else if (!allDone && wasComplete) {
      await db.query(
        `UPDATE service_jobs SET status = 'in_progress', completed_at = NULL, updated_at = NOW() WHERE id = ?`,
        [jobId],
      )
    }

    return ok(buildCardResponse(Number(jobId), items))
  } catch (err) {
    return serverError(err)
  }
}
