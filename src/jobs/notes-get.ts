import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { ok, notFound, forbidden, serverError } from '../shared/errors'
import { getAllowedStoreIds } from './_helpers'

// GET /jobs/{id}/notes  →  { customerNotes, technicianNotes }
//
// Simple read of the two free-text note columns on service_jobs. Kept
// as a dedicated endpoint (not just a field on GET /jobs/{id}) so the
// frontend can poll or refresh notes without re-loading the whole job.

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getAuthContext(event)
  const id  = event.pathParameters?.id

  try {
    const [[job]] = await db.query<any[]>(
      `SELECT id, store_id, customer_notes, technician_notes
       FROM service_jobs WHERE id = ? LIMIT 1`,
      [id],
    )
    if (!job) return notFound('Job')

    if (ctx.role !== 'super_admin') {
      const allowedIds = await getAllowedStoreIds(db, ctx.staffId)
      if (!allowedIds.includes(job.store_id)) return forbidden()
    }

    return ok({
      jobId:           Number(job.id),
      customerNotes:   job.customer_notes   ?? null,
      technicianNotes: job.technician_notes ?? null,
    })
  } catch (err) {
    return serverError(err)
  }
}
