import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { ok, forbidden, serverError } from '../shared/errors'
import { buildJob, jobError, getJobServices, getAllowedStoreIds, JOB_SELECT_BY_ID } from './_helpers'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getAuthContext(event)
  const id  = event.pathParameters?.id

  try {
    const [[row]] = await db.query<any[]>(JOB_SELECT_BY_ID, [id])
    if (!row) return jobError(404, 'JOB_NOT_FOUND', 'Job not found.')

    if (ctx.role !== 'super_admin') {
      const allowedIds = await getAllowedStoreIds(db, ctx.staffId)
      if (!allowedIds.includes(row.store_id)) return forbidden()
    }

    const servicesMap = await getJobServices(db, [Number(id)])
    return ok({ job: buildJob(row, servicesMap.get(Number(id)) ?? []) })
  } catch (err) {
    return serverError(err)
  }
}
