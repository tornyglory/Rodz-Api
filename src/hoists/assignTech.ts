import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { ok, forbidden, serverError } from '../shared/errors'
import { buildHoist, hoistError, getAllowedStoreIds, HOIST_SELECT_BY_ID } from './_helpers'
import { pushToStore } from '../shared/wsPush'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const ctx = getAuthContext(event)
  const id = event.pathParameters?.id

  if (ctx.role === 'technician') return forbidden()

  try {
    const [[hoist]] = await db.query<any[]>(
      'SELECT id, store_id FROM hoists WHERE id = ? AND is_active = 1 LIMIT 1',
      [id],
    )
    if (!hoist) return hoistError(404, 'HOIST_NOT_FOUND', 'Hoist not found.')

    if (ctx.role !== 'super_admin') {
      const allowedIds = await getAllowedStoreIds(db, ctx.staffId)
      if (!allowedIds.includes(hoist.store_id)) return forbidden()
    }

    const body = JSON.parse(event.body ?? '{}') as Record<string, unknown>
    if (!('assignedStaffId' in body)) {
      return hoistError(422, 'VALIDATION_ERROR', 'assignedStaffId is required.')
    }
    const { assignedStaffId } = body

    // Update hoist permanent tech
    await db.query('UPDATE hoists SET assigned_staff_id = ? WHERE id = ?', [assignedStaffId ?? null, id])

    // Propagate to all non-completed jobs in this hoist
    if (assignedStaffId != null) {
      // Get open job IDs for this hoist
      const [openJobs] = await db.query<any[]>(
        `SELECT id FROM service_jobs WHERE hoist_id = ? AND status NOT IN ('completed','invoiced','cancelled')`,
        [id],
      )
      if (openJobs.length > 0) {
        const jobIds = openJobs.map((j: any) => j.id)
        // Remove existing lead_mechanic assignments
        await db.query(
          `DELETE FROM service_job_staff WHERE service_job_id IN (${jobIds.map(() => '?').join(',')}) AND role_on_job = 'lead_mechanic'`,
          jobIds,
        )
        // Insert new assignments
        const staffRows = jobIds.map((jobId: number) => [jobId, assignedStaffId, 'lead_mechanic', new Date()])
        await db.query(
          'INSERT INTO service_job_staff (service_job_id, staff_id, role_on_job, created_at) VALUES ?',
          [staffRows],
        )
      }
    } else {
      // Clear lead_mechanic from all open jobs in this hoist
      const [openJobs] = await db.query<any[]>(
        `SELECT id FROM service_jobs WHERE hoist_id = ? AND status NOT IN ('completed','invoiced','cancelled')`,
        [id],
      )
      if (openJobs.length > 0) {
        const jobIds = openJobs.map((j: any) => j.id)
        await db.query(
          `DELETE FROM service_job_staff WHERE service_job_id IN (${jobIds.map(() => '?').join(',')}) AND role_on_job = 'lead_mechanic'`,
          jobIds,
        )
      }
    }

    const [[updated]] = await db.query<any[]>(HOIST_SELECT_BY_ID, [id])
    const hoistResult = buildHoist(updated)
    await pushToStore(db, hoist.store_id, { type: 'hoist_updated', hoist: hoistResult }).catch(() => {})
    return ok({ hoist: hoistResult })
  } catch (err) {
    return serverError(err)
  }
}
