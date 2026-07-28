import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import * as jwt from 'jsonwebtoken'
import { unauthorized } from './errors'

// Utility for routes that use `HttpMethod.ANY` (to save on the 300-route
// API Gateway cap) — because ANY intercepts OPTIONS preflight, and the
// HttpApi's route-level authorizer would 401 that preflight before the
// Lambda ever runs. These routes are registered WITHOUT an authorizer;
// the Lambda handles both CORS preflight and JWT verification itself.
//
// Mirrors the config in cdk/lib/constructs/api-gateway.ts corsPreflight.
const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,x-api-key',
  'Access-Control-Max-Age':       '86400',
}

// OPTIONS preflight response. Echoes the caller's Origin so browsers accept
// it even when credentials are involved (a wildcard '*' won't cut it then).
export function corsPreflightResponse(event: APIGatewayProxyEventV2): APIGatewayProxyResultV2 {
  const origin = event.headers?.origin ?? event.headers?.Origin ?? '*'
  return {
    statusCode: 204,
    headers: { ...CORS_HEADERS, 'Access-Control-Allow-Origin': String(origin) },
  }
}

// Verifies the Authorization header's JWT and injects the claims into the
// event's authorizer context slot — so downstream `getAuthContext(event)`
// reads them without knowing we did the work here.
//
// Returns a 401 response on failure. Caller should short-circuit with it.
export function ensureStaffAuth(event: APIGatewayProxyEventV2): APIGatewayProxyResultV2 | null {
  // Fast path: authorizer context already populated (e.g. test harness
  // synthetic event, or upstream API Gateway authorizer if one is ever
  // re-added). Trust it.
  const existing = (event.requestContext as any).authorizer?.lambda
  if (existing && existing.sub) return null

  const raw = event.headers?.authorization ?? event.headers?.Authorization ?? ''
  const token = raw.replace(/^Bearer /i, '').trim()
  if (!token) return unauthorized()

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET!) as jwt.JwtPayload
    ;(event.requestContext as any).authorizer = {
      lambda: {
        sub:         String(payload.sub         ?? ''),
        role:        String(payload.role        ?? ''),
        storeId:     String(payload.storeId     ?? ''),
        permissions: JSON.stringify(payload.permissions ?? []),
      },
    }
    return null
  } catch {
    return unauthorized()
  }
}
