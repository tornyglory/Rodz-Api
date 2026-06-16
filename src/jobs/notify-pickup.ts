import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { ok, forbidden, serverError } from '../shared/errors'
import { jobError, getAllowedStoreIds } from './_helpers'
import { sendPickupReadyEmail } from '../shared/emailTemplates'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getAuthContext(event)
  const id  = event.pathParameters?.id

  if (ctx.role === 'technician') return forbidden()

  try {
    const [[job]] = await db.query<any[]>(
      'SELECT j.id, j.store_id, j.status FROM service_jobs j WHERE j.id = ? LIMIT 1',
      [id],
    )
    if (!job) return jobError(404, 'JOB_NOT_FOUND', 'Job not found.')

    if (ctx.role !== 'super_admin') {
      const allowedIds = await getAllowedStoreIds(db, ctx.staffId)
      if (!allowedIds.includes(job.store_id)) return forbidden()
    }

    const [[row]] = await db.query<any[]>(
      `SELECT c.first_name, c.last_name, c.email,
              CONCAT(v.year, ' ', v.make, ' ', v.model) AS vehicle_label,
              v.rego,
              s.name AS store_name, s.phone AS store_phone
       FROM service_jobs j
       JOIN customers c ON c.id = j.customer_id
       JOIN stores s    ON s.id = j.store_id
       LEFT JOIN vehicles v ON v.id = j.vehicle_id
       WHERE j.id = ? LIMIT 1`,
      [id],
    )

    if (!row?.email) return jobError(400, 'NO_EMAIL', 'Customer has no email address on file.')

    await sendPickupReadyEmail(db, {
      customerEmail: row.email,
      customer:      `${row.first_name} ${row.last_name}`,
      vehicle:       row.vehicle_label ?? '',
      rego:          row.rego ?? '',
      store:         (row.store_name ?? '').replace(/^Rodz /, ''),
      storePhone:    row.store_phone ?? '',
    })

    await db.query(
      `INSERT INTO customer_pickup_notifications (job_id, channel, recipient, sent_at) VALUES (?, 'email', ?, NOW())`,
      [id, row.email],
    )

    return ok({ sent: true, recipient: row.email })
  } catch (err) {
    return serverError(err)
  }
}
