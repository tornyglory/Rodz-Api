import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { getAuthContext } from '../../shared/auth'
import { forbidden, notFound, badRequest } from '../../shared/errors'

import * as makes    from './makes'
import * as models   from './models'
import * as series   from './series'
import { regenerate } from './regenerate'

const ready = bootstrap()

// Single-Lambda dispatcher for the admin vehicle-catalog CRUD + regen
// endpoints. Consolidated onto ONE HttpApi route
// (ANY /admin/vehicle-catalog/{proxy+}) because the shared HttpApi is
// at the 300-route + 300-integration caps.
//
// Method + path shape:
//   GET/POST     /makes                     → list / create
//   PATCH/DELETE /makes/{id}                → update / delete
//   GET/POST     /models                    → list (?makeId=, ?year=, ?q=) / create
//   PATCH/DELETE /models/{id}               → update / delete
//   GET/POST     /series                    → list (?modelId=) / create
//   PATCH/DELETE /series/{id}               → update / delete
//   POST         /regenerate                → Gemini regen for one year

const RESOURCES = new Set(['makes', 'models', 'series', 'regenerate'])

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const ctx = getAuthContext(event)
  if (ctx.role === 'technician') return forbidden()

  const method = event.requestContext.http.method.toUpperCase()

  // The proxy path is everything after /admin/vehicle-catalog/. HttpApi
  // gives us either `event.pathParameters.proxy` (for {proxy+}) or the
  // parsed path segments — accept both to keep the dispatcher robust.
  const proxy =
    event.pathParameters?.proxy ??
    (event.rawPath ?? '').replace(/^\/admin\/vehicle-catalog\/?/, '')

  const segments = String(proxy).split('/').filter(Boolean)
  const resource = (segments[0] ?? '').toLowerCase()
  const idSegment = segments[1]

  if (!RESOURCES.has(resource)) return notFound('Catalog resource')

  const db = getPool()

  // /regenerate — no id in path
  if (resource === 'regenerate') {
    if (method !== 'POST') return methodNotAllowed()
    if (segments.length !== 1) return notFound('Regenerate route')
    return regenerate(db, event)
  }

  // /makes|/models|/series (collection) or /makes/{id}|... (item)
  const handlers = resource === 'makes' ? makes : resource === 'models' ? models : series
  const hasId = segments.length >= 2

  if (!hasId) {
    if (method === 'GET')  return handlers.list(db, event)
    if (method === 'POST') return handlers.create(db, event)
    return methodNotAllowed()
  }

  const id = Number(idSegment)
  if (!Number.isInteger(id) || id <= 0) return badRequest('id in path must be a positive integer.')

  if (method === 'PATCH')  return handlers.update(db, id, event)
  if (method === 'DELETE') return handlers.remove(db, id)
  return methodNotAllowed()
}

function methodNotAllowed(): APIGatewayProxyResultV2 {
  return {
    statusCode: 405,
    headers: { 'Content-Type': 'application/json', 'Allow': 'GET, POST, PATCH, DELETE' },
    body: JSON.stringify({ error: { code: 'METHOD_NOT_ALLOWED', message: 'This method is not allowed on this route.' } }),
  }
}
