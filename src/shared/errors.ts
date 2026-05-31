import { APIGatewayProxyResultV2 } from 'aws-lambda'

const json = (statusCode: number, body: unknown): APIGatewayProxyResultV2 => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

const apiError = (statusCode: number, code: string, message: string): APIGatewayProxyResultV2 =>
  json(statusCode, { error: { code, message } })

export const ok        = (data: unknown): APIGatewayProxyResultV2 => json(200, data)
export const created   = (data: unknown): APIGatewayProxyResultV2 => json(201, data)
export const noContent = (): APIGatewayProxyResultV2 => ({ statusCode: 204 })

export const validationError     = (message: string)          => apiError(422, 'VALIDATION_ERROR',    message)
export const invalidCredentials  = ()                          => apiError(401, 'INVALID_CREDENTIALS', 'Invalid email or password.')
export const accountDisabled     = ()                          => apiError(403, 'ACCOUNT_DISABLED',    'This account has been disabled.')
export const accountLocked       = (until: Date)               => apiError(429, 'ACCOUNT_LOCKED',      `Too many failed attempts. Try again after ${until.toISOString()}.`)
export const sessionExpired      = ()                          => apiError(401, 'SESSION_EXPIRED',     'Session has expired or been revoked.')
export const unauthorized        = (code = 'UNAUTHORIZED', message = 'Unauthorized.') => apiError(401, code, message)
export const forbidden           = (code = 'FORBIDDEN', message = 'Forbidden.')       => apiError(403, code, message)
export const notFound            = (resource = 'Resource')     => apiError(404, 'NOT_FOUND',           `${resource} not found.`)
export const badRequest          = (message: string)           => apiError(400, 'BAD_REQUEST',         message)

export function serverError(err: unknown): APIGatewayProxyResultV2 {
  console.error('Unhandled error:', err)
  return apiError(500, 'INTERNAL_ERROR', 'An unexpected error occurred.')
}
