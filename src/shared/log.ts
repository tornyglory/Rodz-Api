// Structured JSON logger for Lambda handlers.
//
// Emits one JSON object per line so CloudWatch Logs Insights can filter
// on fields directly (e.g. `filter level = "error" and event = "push.send_failed"`).
// A `requestId` field is populated from the Lambda `context.awsRequestId`
// (set at handler entry via `log.bindRequest(context)`) so every log
// line for the same invocation is tied together.
//
// Usage:
//
//   import { log } from '../shared/log'
//
//   export const handler = async (event, context) => {
//     log.bindRequest(context)
//     log.info({ event: 'quote.send.start', quoteId })
//     try {
//       // …
//       log.info({ event: 'quote.send.ok', quoteId, ms: Date.now() - start })
//     } catch (err) {
//       log.error({ event: 'quote.send.failed', quoteId, err })
//       throw err
//     }
//   }
//
// Prefer named events + structured fields over free-form strings — that
// unlocks filtering, alerting, and durable dashboards. Free-form
// `console.error('something failed:', err)` still works but is opaque
// once the log is more than a page.

type Level = 'debug' | 'info' | 'warn' | 'error'

interface LambdaLikeContext {
  awsRequestId?: string
  functionName?: string
}

// Module-level so nested helpers can log without threading the request
// id through every function signature. Reset on each new invocation via
// bindRequest — handlers that forget just emit rows without a requestId.
let currentRequestId: string | null    = null
let currentFunctionName: string | null = null

function serialiseError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return {
      name:    err.name,
      message: err.message,
      stack:   err.stack ?? null,
      ...(('code' in err) ? { code: (err as any).code } : {}),
    }
  }
  return { message: String(err) }
}

function emit(level: Level, fields: Record<string, unknown>): void {
  const err = 'err' in fields ? serialiseError(fields.err) : null
  const clean = err ? { ...fields } : fields
  if (err) delete (clean as any).err
  const line = JSON.stringify({
    ts:      new Date().toISOString(),
    level,
    ...(currentRequestId    ? { requestId: currentRequestId    } : {}),
    ...(currentFunctionName ? { fn:        currentFunctionName } : {}),
    ...clean,
    ...(err ? { err } : {}),
  })
  // Route errors to stderr so Lambda tags them; everything else to stdout.
  if (level === 'error') console.error(line)
  else                    console.log(line)
}

export const log = {
  bindRequest(context: LambdaLikeContext): void {
    currentRequestId    = context.awsRequestId ?? null
    currentFunctionName = context.functionName ?? null
  },
  clearRequest(): void {
    currentRequestId    = null
    currentFunctionName = null
  },
  debug: (fields: Record<string, unknown>) => emit('debug', fields),
  info:  (fields: Record<string, unknown>) => emit('info',  fields),
  warn:  (fields: Record<string, unknown>) => emit('warn',  fields),
  error: (fields: Record<string, unknown>) => emit('error', fields),
}
