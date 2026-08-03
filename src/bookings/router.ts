import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { handler as getHandler }    from './get'
import { handler as updateHandler } from './update'
import { handler as deleteHandler } from './delete'
import { corsPreflightResponse, ensureStaffAuth } from '../shared/staffAuth'

// One Lambda serves the three methods on /bookings/{id} to conserve
// API Gateway routes (shared HttpApi is at its 300-route cap). Route
// is registered as ANY without a route-level authorizer; this handler
// handles CORS preflight + JWT verify + dispatch itself.
//
//   ANY /bookings/{id}  →  GET | PATCH | DELETE
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  const method = event.requestContext.http.method

  if (method === 'OPTIONS') return corsPreflightResponse(event)

  const authErr = ensureStaffAuth(event)
  if (authErr) return authErr

  if (method === 'GET')    return getHandler(event)
  if (method === 'PATCH')  return updateHandler(event)
  if (method === 'DELETE') return deleteHandler(event)

  return {
    statusCode: 405,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ error: { code: 'METHOD_NOT_ALLOWED', message: `${method} not allowed on /bookings/{id}.` } }),
  }
}
