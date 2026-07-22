// Synthetic APIGatewayProxyEventV2 builder. Handlers only touch a small
// subset of the real shape (`pathParameters`, `queryStringParameters`,
// `body`, and `requestContext.authorizer.lambda.<claim>`), so we build
// exactly that — nothing else. Two flavours: customer-authed and
// staff-authed.

import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'

interface EventOpts {
  method?:      'GET' | 'POST' | 'PATCH' | 'DELETE'
  path?:        Record<string, string>
  query?:       Record<string, string | number>
  body?:        unknown
}

function base(opts: EventOpts): APIGatewayProxyEventV2 {
  const { method = 'GET', path = {}, query, body } = opts
  return {
    version:               '2.0',
    routeKey:              '$default',
    rawPath:               '/',
    rawQueryString:        '',
    headers:               {},
    requestContext: {
      accountId:    '000000000000',
      apiId:        'test',
      domainName:   'test.execute-api.local',
      domainPrefix: 'test',
      http:         { method, path: '/', protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'vitest' },
      requestId:    'vitest',
      routeKey:     '$default',
      stage:        '$default',
      time:         '01/Jan/2026:00:00:00 +0000',
      timeEpoch:    1735689600000,
    } as any,
    pathParameters:        path,
    queryStringParameters: query
      ? Object.fromEntries(Object.entries(query).map(([k, v]) => [k, String(v)]))
      : undefined,
    body:                  body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body)),
    isBase64Encoded:       false,
  } as APIGatewayProxyEventV2
}

export function customerEvent(customerId: number, opts: EventOpts = {}): APIGatewayProxyEventV2 {
  const ev = base(opts)
  ;(ev.requestContext as any).authorizer = { lambda: { customerId: String(customerId) } }
  return ev
}

export function staffEvent(
  ctx: { staffId: string; role: 'super_admin' | 'store_manager' | 'technician'; storeId?: number },
  opts: EventOpts = {},
): APIGatewayProxyEventV2 {
  const ev = base(opts)
  ;(ev.requestContext as any).authorizer = {
    lambda: {
      staffId:     ctx.staffId,
      role:        ctx.role,
      storeId:     String(ctx.storeId ?? 0),
      permissions: '[]',
    },
  }
  return ev
}

// Unwrap the handler's response — every handler routes through the shared
// `ok/created/notFound/...` helpers, so `body` is always JSON.
export function parse(result: APIGatewayProxyResultV2): { status: number; body: any } {
  const r = result as { statusCode?: number; body?: string }
  return {
    status: r.statusCode ?? 200,
    body:   r.body ? JSON.parse(r.body) : null,
  }
}
