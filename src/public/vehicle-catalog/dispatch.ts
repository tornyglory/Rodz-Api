import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { notFound } from '../../shared/errors'

import { handler as yearsHandler }    from './years'
import { handler as makesHandler }    from './makes'
import { handler as modelsHandler }   from './models'
import { handler as seriesHandler }   from './series'
import { handler as overviewHandler } from './overview'

// Single-Lambda dispatcher for the five vehicle-catalog read endpoints.
// Consolidated onto one HttpApi route (/public/vehicle-catalog/{action})
// because the shared HttpApi is at the 300-route cap; five separate
// routes would blow past it.
//
// Each individual handler still lives in its own file with its own unit
// tests — this file just routes based on the `action` path segment.

const handlers: Record<string, (e: APIGatewayProxyEventV2) => Promise<APIGatewayProxyResultV2>> = {
  years:    yearsHandler,
  makes:    makesHandler,
  models:   modelsHandler,
  series:   seriesHandler,
  overview: overviewHandler,
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  const action = (event.pathParameters?.action ?? '').toLowerCase()
  const fn = handlers[action]
  if (!fn) return notFound('Catalog action')
  return fn(event)
}
