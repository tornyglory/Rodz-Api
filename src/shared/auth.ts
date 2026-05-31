import { APIGatewayProxyEventV2 } from 'aws-lambda'
import { AuthContext } from './types'

// Extracts the authorizer context injected by the JWT Lambda authorizer.
export function getAuthContext(event: APIGatewayProxyEventV2): AuthContext {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ctx = (event.requestContext as any).authorizer?.lambda ?? {}
  return {
    staffId:     String(ctx.sub     ?? ''),
    role:        String(ctx.role    ?? ''),
    storeId:     String(ctx.storeId ?? ''),
    permissions: ctx.permissions ? JSON.parse(ctx.permissions) : [],
  }
}
