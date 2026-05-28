import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { ok } from '../shared/errors'

// JWT is stateless — logout is handled client-side by discarding the token.
// Extend this handler to maintain a token denylist if needed.
export const handler = async (_event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  return ok({ message: 'Logged out' })
}
