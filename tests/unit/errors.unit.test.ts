import { describe, expect, it } from 'vitest'
import {
  ok, created, noContent,
  validationError, invalidCredentials, accountDisabled, accountLocked,
  sessionExpired, unauthorized, forbidden, notFound, badRequest, gone,
  serverError,
} from '../../src/shared/errors'

// Every handler in the codebase funnels its response through these helpers.
// If any of them regresses — wrong status, wrong body shape, wrong JSON —
// hundreds of endpoints break at once. Cheap tests to lock the contract.

describe('response helpers', () => {
  it('ok wraps a payload with 200 and JSON content-type', () => {
    const r = ok({ hello: 'world' }) as any
    expect(r.statusCode).toBe(200)
    expect(r.headers['Content-Type']).toBe('application/json')
    expect(JSON.parse(r.body)).toEqual({ hello: 'world' })
  })

  it('created returns 201', () => {
    const r = created({ id: 42 }) as any
    expect(r.statusCode).toBe(201)
    expect(JSON.parse(r.body)).toEqual({ id: 42 })
  })

  it('noContent returns 204 with no body', () => {
    const r = noContent() as any
    expect(r.statusCode).toBe(204)
    expect(r.body).toBeUndefined()
  })

  it('validationError → 422 with code VALIDATION_ERROR', () => {
    const r = validationError('bad input') as any
    expect(r.statusCode).toBe(422)
    expect(JSON.parse(r.body)).toEqual({ error: { code: 'VALIDATION_ERROR', message: 'bad input' } })
  })

  it('notFound → 404 with resource-scoped message', () => {
    const r = notFound('Quote') as any
    expect(r.statusCode).toBe(404)
    expect(JSON.parse(r.body).error.message).toBe('Quote not found.')
  })

  it('notFound defaults to "Resource"', () => {
    const r = notFound() as any
    expect(JSON.parse(r.body).error.message).toBe('Resource not found.')
  })

  it('forbidden → 403', () => {
    const r = forbidden() as any
    expect(r.statusCode).toBe(403)
    expect(JSON.parse(r.body).error.code).toBe('FORBIDDEN')
  })

  it('badRequest → 400', () => {
    const r = badRequest('nope') as any
    expect(r.statusCode).toBe(400)
    expect(JSON.parse(r.body).error.code).toBe('BAD_REQUEST')
  })

  it('gone → 410 with resource-scoped message', () => {
    const r = gone('Vehicle') as any
    expect(r.statusCode).toBe(410)
    expect(JSON.parse(r.body).error.message).toBe('Vehicle is no longer available.')
  })

  it('unauthorized → 401 with configurable code/message', () => {
    const r = unauthorized('SESSION_STALE', 'stale') as any
    expect(r.statusCode).toBe(401)
    expect(JSON.parse(r.body)).toEqual({ error: { code: 'SESSION_STALE', message: 'stale' } })
  })

  it('sessionExpired → 401 with SESSION_EXPIRED code', () => {
    const r = sessionExpired() as any
    expect(r.statusCode).toBe(401)
    expect(JSON.parse(r.body).error.code).toBe('SESSION_EXPIRED')
  })

  it('invalidCredentials → 401', () => {
    const r = invalidCredentials() as any
    expect(r.statusCode).toBe(401)
    expect(JSON.parse(r.body).error.code).toBe('INVALID_CREDENTIALS')
  })

  it('accountDisabled → 403', () => {
    const r = accountDisabled() as any
    expect(r.statusCode).toBe(403)
    expect(JSON.parse(r.body).error.code).toBe('ACCOUNT_DISABLED')
  })

  it('accountLocked → 429 with retry-after timestamp in message', () => {
    const until = new Date('2026-07-22T12:00:00Z')
    const r = accountLocked(until) as any
    expect(r.statusCode).toBe(429)
    expect(JSON.parse(r.body).error.message).toContain(until.toISOString())
  })

  it('serverError → 500 with a generic message (no stack leaked)', () => {
    // Silence the intentional console.error the helper emits.
    const origErr = console.error
    console.error = () => {}
    try {
      const r = serverError(new Error('secret internal detail')) as any
      expect(r.statusCode).toBe(500)
      const body = JSON.parse(r.body)
      expect(body.error.code).toBe('INTERNAL_ERROR')
      expect(body.error.message).toBe('An unexpected error occurred.')
      expect(JSON.stringify(body)).not.toContain('secret internal detail')
    } finally {
      console.error = origErr
    }
  })
})
