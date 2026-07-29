// Shared helpers for the admin catalog handlers. Keeping validation +
// pagination + slug policy in one place so every handler enforces the
// same rules and the same messages.

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const CURRENT_YEAR = new Date().getFullYear()
const YEAR_MIN = 1900
const YEAR_MAX = CURRENT_YEAR + 3

export const CATALOG_YEAR_MIN = YEAR_MIN
export const CATALOG_YEAR_MAX = YEAR_MAX

// Validation ────────────────────────────────────────────────────────────

export function validateSlug(raw: unknown, field = 'slug'): string | { error: string } {
  if (typeof raw !== 'string') return { error: `${field} must be a string.` }
  const s = raw.trim().toLowerCase()
  if (s.length === 0 || s.length > 60) return { error: `${field} must be 1-60 characters.` }
  if (!SLUG_RE.test(s)) {
    return { error: `${field} must be lowercase kebab-case (letters, digits, single hyphens between words).` }
  }
  return s
}

export function validateName(raw: unknown, field = 'name'): string | { error: string } {
  if (typeof raw !== 'string') return { error: `${field} must be a string.` }
  const s = raw.trim()
  if (s.length === 0 || s.length > 120) return { error: `${field} must be 1-120 characters.` }
  return s
}

export function validateYear(raw: unknown, field: string): number | { error: string } {
  const n = Number(raw)
  if (!Number.isInteger(n) || n < YEAR_MIN || n > YEAR_MAX) {
    return { error: `${field} must be an integer between ${YEAR_MIN} and ${YEAR_MAX}.` }
  }
  return n
}

export function validateBool(raw: unknown, field: string, def: boolean): boolean | { error: string } {
  if (raw === undefined || raw === null) return def
  if (typeof raw !== 'boolean') return { error: `${field} must be a boolean.` }
  return raw
}

// Pagination + search ────────────────────────────────────────────────────

export interface PageParams {
  limit:  number
  offset: number
  q:      string | null
}

export function parsePageParams(
  q: Record<string, string | undefined> | undefined,
  defaultLimit = 50,
  maxLimit = 200,
): PageParams {
  const rawLimit  = Number(q?.limit)
  const rawOffset = Number(q?.offset)
  const limit  = Number.isInteger(rawLimit)  && rawLimit  > 0 ? Math.min(rawLimit, maxLimit) : defaultLimit
  const offset = Number.isInteger(rawOffset) && rawOffset >= 0 ? rawOffset : 0
  const searchRaw = (q?.q ?? '').trim()
  return { limit, offset, q: searchRaw ? searchRaw.slice(0, 60) : null }
}

// MySQL LIKE escape — protects against %/_ wildcards in user input.
export function likeEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/[%_]/g, m => `\\${m}`)
}

// Response helpers ───────────────────────────────────────────────────────

import type { APIGatewayProxyResultV2 } from 'aws-lambda'

export const okJson = (body: unknown, statusCode = 200): APIGatewayProxyResultV2 => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

export const conflict = (message: string, details: Record<string, unknown>): APIGatewayProxyResultV2 => ({
  statusCode: 409,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ error: { code: 'CONFLICT', message, details } }),
})
