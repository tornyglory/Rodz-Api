import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { ok, serverError } from '../../shared/errors'
import { getCustomerContext } from '../_helpers'
import { pushToCustomer } from '../../shared/push'

const ready = bootstrap()

// POST /c/push/test — sends a synthetic push to the caller's tokens.
// Bypasses gating (type='test' is exempt from prefs + rate limits) so
// support / customer can prove the push pipeline works. Idempotent via a
// per-hour eventId so rapid clicks don't spam the same device.
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getCustomerContext(event)

  try {
    const hourStamp = new Date().toISOString().slice(0, 13) // 'YYYY-MM-DDTHH'
    const result = await pushToCustomer(db, ctx.customerId, {
      type:     'test',
      title:    'Rodz',
      body:     'Push notifications are working. Ping!',
      deeplink: '/account',
      eventId:  `test:${ctx.customerId}:${hourStamp}`,
    })
    return ok(result)
  } catch (err) {
    return serverError(err)
  }
}
