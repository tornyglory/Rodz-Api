import type { APIGatewayProxyEventV2 } from 'aws-lambda'
import { UAParser } from 'ua-parser-js'

// Merges client-provided context (meta.context) with edge-provided
// headers (Cloudflare CF-* set) and server-derived fields (IP from
// API Gateway / X-Forwarded-For, ua-parser-js output) into the JSON
// blob stored on bookings.submission_context.
//
// See docs/migrations/bookings_submission_context.sql for the stored
// shape.

export interface ClientContextInput {
  userAgent?:        unknown
  language?:         unknown
  timezone?:         unknown
  screenWidth?:      unknown
  screenHeight?:     unknown
  viewportWidth?:    unknown
  viewportHeight?:   unknown
  devicePixelRatio?: unknown
  referrer?:         unknown
  pageUrl?:          unknown
  submittedAt?:      unknown
}

interface UAParts {
  browser: { name: string | null; version: string | null }
  os:      { name: string | null; version: string | null }
  device:  { vendor: string | null; model: string | null; type: string | null }
}

// Header lookup — API Gateway v2 lower-cases header names.
function h(event: APIGatewayProxyEventV2, name: string): string | null {
  const v = event.headers?.[name.toLowerCase()]
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

function resolveIp(event: APIGatewayProxyEventV2): string | null {
  // Priority: Cloudflare's CF-Connecting-IP (only present if the CF
  // worker is in front); then first entry of X-Forwarded-For; then
  // API Gateway's socket-level sourceIp.
  const cfIp = h(event, 'cf-connecting-ip')
  if (cfIp) return cfIp

  const xff = h(event, 'x-forwarded-for')
  if (xff) {
    const first = xff.split(',')[0].trim()
    if (first) return first
  }

  const src = event.requestContext?.http?.sourceIp
  return typeof src === 'string' && src.trim() ? src.trim() : null
}

function parseUa(ua: string | null): UAParts {
  if (!ua) {
    return {
      browser: { name: null, version: null },
      os:      { name: null, version: null },
      device:  { vendor: null, model: null, type: null },
    }
  }
  try {
    const p = new UAParser(ua).getResult()
    return {
      browser: { name: p.browser.name ?? null, version: p.browser.version ?? null },
      os:      { name: p.os.name      ?? null, version: p.os.version      ?? null },
      device:  {
        vendor: p.device.vendor ?? null,
        model:  p.device.model  ?? null,
        type:   p.device.type   ?? null,   // 'mobile' | 'tablet' | 'smarttv' | ... | undefined (→ null, meaning desktop-like)
      },
    }
  } catch {
    return {
      browser: { name: null, version: null },
      os:      { name: null, version: null },
      device:  { vendor: null, model: null, type: null },
    }
  }
}

const asString = (v: unknown, cap = 500): string | null => {
  if (typeof v !== 'string') return null
  const s = v.trim()
  return s ? s.slice(0, cap) : null
}
const asInt = (v: unknown): number | null => {
  const n = Number(v)
  return Number.isFinite(n) && Number.isInteger(n) ? n : null
}
const asNumber = (v: unknown): number | null => {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export interface SubmissionContext {
  ip:            string
  submittedAt:   string
  userAgent:     string | null
  browser:       UAParts['browser']
  os:            UAParts['os']
  device:        UAParts['device']
  language:      string | null
  timezone:      string | null
  screen:        { width: number | null; height: number | null; dpr: number | null }
  viewport:      { width: number | null; height: number | null }
  referrer:      string | null
  pageUrl:       string | null
  country:       string | null
  city:          string | null
  region:        string | null
  regionCode:    string | null
  postalCode:    string | null
  edgeTimezone:  string | null
  latitude:      string | null
  longitude:     string | null
}

/**
 * Build the stored submission_context blob. Throws when the client
 * IP can't be resolved (misconfigured proxy) — caller should convert
 * to an INTERNAL_ERROR client-facing.
 */
export function buildSubmissionContext(
  event: APIGatewayProxyEventV2,
  client: ClientContextInput | undefined | null,
): SubmissionContext {
  const ip = resolveIp(event)
  if (!ip) {
    throw new Error('IP not determinable — check proxy configuration')
  }

  const clientUa = asString(client?.userAgent, 800)
  const headerUa = h(event, 'user-agent')
  const userAgent = clientUa ?? headerUa
  const ua = parseUa(userAgent)

  // submittedAt — trust the client's timestamp but fall back to server
  // time. Client timestamps are analytics-only; never trust them for
  // ordering or auth.
  const clientSubmittedAt = asString(client?.submittedAt, 40)
  const submittedAt = clientSubmittedAt && /^\d{4}-\d{2}-\d{2}T/.test(clientSubmittedAt)
    ? clientSubmittedAt
    : new Date().toISOString()

  return {
    ip,
    submittedAt,
    userAgent,
    browser: ua.browser,
    os:      ua.os,
    device:  ua.device,

    // Client-collected
    language:  asString(client?.language, 20),
    timezone:  asString(client?.timezone, 60),
    screen: {
      width:  asInt(client?.screenWidth),
      height: asInt(client?.screenHeight),
      dpr:    asNumber(client?.devicePixelRatio),
    },
    viewport: {
      width:  asInt(client?.viewportWidth),
      height: asInt(client?.viewportHeight),
    },
    referrer: asString(client?.referrer),
    pageUrl:  asString(client?.pageUrl, 1000),

    // Cloudflare edge (null if request didn't come through a CF worker)
    country:      h(event, 'cf-ipcountry'),
    city:         h(event, 'cf-ipcity'),
    region:       h(event, 'cf-region'),
    regionCode:   h(event, 'cf-region-code'),
    postalCode:   h(event, 'cf-postal-code'),
    edgeTimezone: h(event, 'cf-timezone'),
    latitude:     h(event, 'cf-iplatitude'),
    longitude:    h(event, 'cf-iplongitude'),
  }
}
