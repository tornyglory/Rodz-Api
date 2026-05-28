import { APIGatewayProxyResultV2 } from 'aws-lambda'

const json = (statusCode: number, body: unknown): APIGatewayProxyResultV2 => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

export const ok        = (data: unknown):          APIGatewayProxyResultV2 => json(200, data)
export const created   = (data: unknown):          APIGatewayProxyResultV2 => json(201, data)
export const noContent = ():                       APIGatewayProxyResultV2 => ({ statusCode: 204 })
export const badRequest= (message: string):        APIGatewayProxyResultV2 => json(400, { error: message })
export const unauthorized=(message = 'Unauthorized'): APIGatewayProxyResultV2 => json(401, { error: message })
export const forbidden = (message = 'Forbidden'):  APIGatewayProxyResultV2 => json(403, { error: message })
export const notFound  = (resource = 'Resource'):  APIGatewayProxyResultV2 => json(404, { error: `${resource} not found` })

export function serverError(err: unknown): APIGatewayProxyResultV2 {
  console.error('Unhandled error:', err)
  return json(500, { error: 'Internal server error' })
}
