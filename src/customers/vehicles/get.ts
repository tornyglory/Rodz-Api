import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { getAuthContext } from '../../shared/auth'
import { ok, notFound, gone, serverError } from '../../shared/errors'
import { loadVehicleForResponse } from './_helpers'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getAuthContext(event)
  const { customerId, vehicleId } = event.pathParameters ?? {}

  try {
    const load = await loadVehicleForResponse(db, customerId!, vehicleId!)
    if (load.state === 'missing') return notFound('Vehicle')
    if (load.state === 'gone')    return gone('Vehicle')

    if (ctx.role !== 'super_admin' && String(load.storeId ?? '') !== ctx.storeId) {
      return notFound('Vehicle')
    }

    return ok({ vehicle: load.payload })
  } catch (err) {
    return serverError(err)
  }
}
