import { afterEach, describe, expect, it, vi } from 'vitest'
import { log } from '../../src/shared/log'

// Structured logger contract — every emission must be one JSON line
// with the fields consumers rely on (level, ts, requestId when bound,
// message payload). Regressions here would break CloudWatch dashboards.

describe('structured logger', () => {
  afterEach(() => {
    log.clearRequest()
    vi.restoreAllMocks()
  })

  it('emits one JSON line with level + ts', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    log.info({ event: 'test' })
    expect(spy).toHaveBeenCalledOnce()
    const line = JSON.parse(spy.mock.calls[0][0] as string)
    expect(line.level).toBe('info')
    expect(line.event).toBe('test')
    expect(new Date(line.ts).toString()).not.toBe('Invalid Date')
  })

  it('routes errors to stderr, other levels to stdout', () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => {})
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    log.info({ event: 'a' })
    log.warn({ event: 'b' })
    log.error({ event: 'c' })
    expect(out).toHaveBeenCalledTimes(2)
    expect(err).toHaveBeenCalledOnce()
  })

  it('includes requestId + fn when bound', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    log.bindRequest({ awsRequestId: 'abc-123', functionName: 'my-fn' })
    log.info({ event: 'x' })
    const line = JSON.parse(spy.mock.calls[0][0] as string)
    expect(line.requestId).toBe('abc-123')
    expect(line.fn).toBe('my-fn')
  })

  it('omits requestId when not bound', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    log.info({ event: 'x' })
    const line = JSON.parse(spy.mock.calls[0][0] as string)
    expect(line.requestId).toBeUndefined()
  })

  it('serialises an Error passed as `err` into { name, message, stack }', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    log.error({ event: 'boom', err: new Error('kaboom') })
    const line = JSON.parse(spy.mock.calls[0][0] as string)
    expect(line.err.name).toBe('Error')
    expect(line.err.message).toBe('kaboom')
    expect(typeof line.err.stack).toBe('string')
  })

  it('surfaces `code` when present on the error (e.g. mysql2 errors)', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const err: any = new Error('duplicate')
    err.code = 'ER_DUP_ENTRY'
    log.error({ event: 'db', err })
    const line = JSON.parse(spy.mock.calls[0][0] as string)
    expect(line.err.code).toBe('ER_DUP_ENTRY')
  })

  it('serialises a non-Error value passed as `err`', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    log.error({ event: 'weird', err: 'oh no' })
    const line = JSON.parse(spy.mock.calls[0][0] as string)
    expect(line.err.message).toBe('oh no')
  })

  it('bindRequest / clearRequest lifecycle', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    log.bindRequest({ awsRequestId: 'first' })
    log.info({ event: 'a' })
    log.clearRequest()
    log.info({ event: 'b' })
    log.bindRequest({ awsRequestId: 'second' })
    log.info({ event: 'c' })
    const [a, b, c] = spy.mock.calls.map(call => JSON.parse(call[0] as string))
    expect(a.requestId).toBe('first')
    expect(b.requestId).toBeUndefined()
    expect(c.requestId).toBe('second')
  })
})
