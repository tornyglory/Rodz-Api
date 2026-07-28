import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { handler as listHandler }   from './list'
import { handler as createHandler } from './create'
import { handler as updateHandler } from './update'
import { handler as deleteHandler } from './delete'

// One Lambda serves all four staff routes to conserve API Gateway
// integrations. Route paths use ANY so a single route matches every
// method — we branch here.
//
//   ANY /stores/{id}/booking-slots           → GET (list) | POST (create)
//   ANY /stores/{id}/booking-slots/{slotId}  → PATCH (update) | DELETE (delete)
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  const method  = event.requestContext.http.method
  const hasSlot = !!event.pathParameters?.slotId

  if (hasSlot) {
    if (method === 'PATCH')  return updateHandler(event)
    if (method === 'DELETE') return deleteHandler(event)
  } else {
    if (method === 'GET')  return listHandler(event)
    if (method === 'POST') return createHandler(event)
  }
  return {
    statusCode: 405,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ error: { code: 'METHOD_NOT_ALLOWED', message: `${method} not allowed on this path.` } }),
  }
}
