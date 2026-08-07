// Thin wrapper around the eBay Browse API for the parts-sourcing engine.
//
// Multi-marketplace by default — the workshop wants best prices, and the
// cheapest oil filter often lives on eBay US (bulk sellers) or eBay UK.
// We fan out one call per marketplace, merge, convert to AUD, and rank
// by delivered-to-AU price.
//
// Auth: application-level OAuth2 (client_credentials grant). One
// EBAY_APP_ID + EBAY_CERT_ID pair authenticates every call — no user
// tokens needed for read-only searching. Tokens live 2 hours; cached
// in-memory and refreshed at ~90% expiry.
//
// Env:
//   EBAY_APP_ID           (Client ID)  — required
//   EBAY_CERT_ID          (Client Secret) — required
//   EBAY_ENV              "production" | "sandbox" — default production
//   EBAY_MARKETPLACES     comma-sep list (e.g. "EBAY_AU,EBAY_US,EBAY_GB")
//                         — default "EBAY_AU,EBAY_US"
//   EBAY_SHIP_TO_COUNTRY  destination country ISO code — default "AU"
//                         (shipping quotes come back for this destination)
//   EBAY_SHIP_TO_POSTCODE optional zip/postcode for tighter shipping
//                         quotes — default "3199" (Somerville)
//   EBAY_FX_USD_AUD       override FX rate USD → AUD — default 1.52
//   EBAY_FX_GBP_AUD       override FX rate GBP → AUD — default 1.93
//   EBAY_FX_EUR_AUD       override FX rate EUR → AUD — default 1.65
//   EBAY_FX_NZD_AUD       override FX rate NZD → AUD — default 0.92
//   EBAY_FX_JPY_AUD       override FX rate JPY → AUD — default 0.010
//   EBAY_FX_CAD_AUD       override FX rate CAD → AUD — default 1.11

const PROD_TOKEN_URL    = 'https://api.ebay.com/identity/v1/oauth2/token'
const SANDBOX_TOKEN_URL = 'https://api.sandbox.ebay.com/identity/v1/oauth2/token'
const PROD_API_BASE     = 'https://api.ebay.com'
const SANDBOX_API_BASE  = 'https://api.sandbox.ebay.com'

function isSandbox(): boolean {
  return (process.env.EBAY_ENV ?? 'production').toLowerCase() === 'sandbox'
}
function tokenUrl(): string { return isSandbox() ? SANDBOX_TOKEN_URL : PROD_TOKEN_URL }
function apiBase():  string { return isSandbox() ? SANDBOX_API_BASE  : PROD_API_BASE }

// EBAY_JP is not accessible via Browse API (eBay joint-venture in Japan,
// API locked down — returns 409 for outside applications). If we ever
// want JDM parts we'll need a separate integration (Yahoo Auctions
// Japan / Rakuten). Everything else is fair game.
function defaultMarketplaces(): string[] {
  const raw = process.env.EBAY_MARKETPLACES ?? 'EBAY_AU,EBAY_US,EBAY_GB,EBAY_DE'
  return raw.split(',').map(s => s.trim()).filter(Boolean)
}
function shipToCountry(): string  { return process.env.EBAY_SHIP_TO_COUNTRY  ?? 'AU'   }
function shipToPostcode(): string { return process.env.EBAY_SHIP_TO_POSTCODE ?? '3199' }

// FX to AUD. Simple hard-coded defaults + env overrides — accurate
// enough for cost comparison ranking, we don't need FX bureau precision
// for a "which supplier is cheaper" call. Refresh periodically or wire
// a rates API later if the drift matters.
function fxRate(currency: string): number {
  const c = currency.toUpperCase()
  if (c === 'AUD') return 1
  const overrides: Record<string, number | undefined> = {
    USD: process.env.EBAY_FX_USD_AUD ? Number(process.env.EBAY_FX_USD_AUD) : undefined,
    GBP: process.env.EBAY_FX_GBP_AUD ? Number(process.env.EBAY_FX_GBP_AUD) : undefined,
    EUR: process.env.EBAY_FX_EUR_AUD ? Number(process.env.EBAY_FX_EUR_AUD) : undefined,
    NZD: process.env.EBAY_FX_NZD_AUD ? Number(process.env.EBAY_FX_NZD_AUD) : undefined,
    JPY: process.env.EBAY_FX_JPY_AUD ? Number(process.env.EBAY_FX_JPY_AUD) : undefined,
    CAD: process.env.EBAY_FX_CAD_AUD ? Number(process.env.EBAY_FX_CAD_AUD) : undefined,
  }
  if (overrides[c] && Number.isFinite(overrides[c])) return overrides[c]!
  const defaults: Record<string, number> = {
    USD: 1.52, GBP: 1.93, EUR: 1.65, NZD: 0.92, JPY: 0.010, CAD: 1.11,
    HKD: 0.20, SGD: 1.15, CNY: 0.21,
  }
  return defaults[c] ?? 1  // unknown currency → 1:1 as a last resort
}

interface CachedToken {
  token:     string
  expiresAt: number  // epoch ms
}

let cachedToken: CachedToken | null = null

async function getToken(): Promise<string> {
  const now = Date.now()
  if (cachedToken && cachedToken.expiresAt > now + 60_000) {
    return cachedToken.token
  }

  const appId  = process.env.EBAY_APP_ID
  const certId = process.env.EBAY_CERT_ID
  if (!appId || !certId) {
    throw new Error('eBay: EBAY_APP_ID / EBAY_CERT_ID env vars are required')
  }

  const basic = Buffer.from(`${appId}:${certId}`).toString('base64')
  const body  = new URLSearchParams({
    grant_type: 'client_credentials',
    scope:      'https://api.ebay.com/oauth/api_scope',
  })

  const res = await fetch(tokenUrl(), {
    method:  'POST',
    headers: {
      'Authorization': `Basic ${basic}`,
      'Content-Type':  'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`eBay token exchange failed (${res.status}): ${text.slice(0, 300)}`)
  }
  const data = await res.json() as { access_token: string; expires_in: number }
  cachedToken = {
    token:     data.access_token,
    // Refresh at 90% of the eBay-provided TTL so we never race the
    // expiry mid-flight.
    expiresAt: now + Math.floor(data.expires_in * 900),
  }
  return cachedToken.token
}

export interface EbaySearchOptions {
  query:            string
  limit?:           number                   // per-marketplace cap (max 50); default 5
  minPrice?:        number                   // in AUD, applied post-conversion
  maxPrice?:        number                   // in AUD, applied post-conversion
  conditionIds?:    string[]                 // "1000" new, "3000" used, "2000" refurb
  buyItNowOnly?:    boolean                  // exclude auctions (default true)
  categoryIds?:     string[]                 // eBay category filters
  marketplaces?:    string[]                 // e.g. ['EBAY_AU','EBAY_US','EBAY_GB']
                                             // default from EBAY_MARKETPLACES env
  sort?:            'price' | 'newlyListed' | ''
}

export interface EbaySearchItem {
  itemId:         string
  title:          string
  marketplace:    string             // 'EBAY_AU' / 'EBAY_US' / …
  price:          number             // native currency
  currency:       string
  shipping:       number | null
  total:          number             // native currency
  priceAud:       number             // converted to AUD for ranking
  shippingAud:    number | null
  totalAud:       number             // priceAud + shippingAud; the ranking key
  fxRate:         number             // conversion factor applied (audit trail)
  condition:      string | null
  seller:         { name: string | null; feedbackScore: number | null; feedbackPct: number | null }
  itemWebUrl:     string
  imageUrl:       string | null
  location:       string | null
  buyingOptions:  string[]
}

async function searchOne(
  marketplace: string,
  opts: EbaySearchOptions,
): Promise<EbaySearchItem[]> {
  const token  = await getToken()
  const params = new URLSearchParams()
  params.set('q', opts.query.trim())
  params.set('limit', String(Math.max(1, Math.min(50, opts.limit ?? 5))))
  if (opts.sort) params.set('sort', opts.sort)

  const filters: string[] = []
  if (opts.buyItNowOnly ?? true) filters.push('buyingOptions:{FIXED_PRICE}')
  if (opts.conditionIds?.length) filters.push(`conditionIds:{${opts.conditionIds.join('|')}}`)
  if (filters.length) params.set('filter', filters.join(','))
  if (opts.categoryIds?.length) params.set('category_ids', opts.categoryIds.join(','))

  const url = `${apiBase()}/buy/browse/v1/item_summary/search?${params.toString()}`
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization':           `Bearer ${token}`,
      'X-EBAY-C-MARKETPLACE-ID': marketplace,
      // Tells eBay to quote shipping for delivery to AU — even on US or
      // UK marketplace searches. Without this, shipping cost is quoted
      // to the marketplace's default country and international items
      // look artificially cheap.
      'X-EBAY-C-ENDUSERCTX':     `contextualLocation=country=${shipToCountry()},zip=${shipToPostcode()}`,
      'Content-Type':            'application/json',
    },
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`eBay search (${marketplace}) failed ${res.status}: ${text.slice(0, 250)}`)
  }
  const data = await res.json() as any
  const items = Array.isArray(data.itemSummaries) ? data.itemSummaries : []
  return items.map((i: any): EbaySearchItem => {
    const price    = Number(i.price?.value ?? 0)
    const currency = String(i.price?.currency ?? 'AUD')
    const rate     = fxRate(currency)
    const shipping = i.shippingOptions?.[0]?.shippingCost?.value != null
      ? Number(i.shippingOptions[0].shippingCost.value)
      : null
    // Shipping currency can differ from item currency on cross-border
    // items (rare but not unseen). If eBay marks the shipping currency,
    // use its rate; otherwise inherit the item's.
    const shipCurrency = String(i.shippingOptions?.[0]?.shippingCost?.currency ?? currency)
    const shipRate     = shipCurrency === currency ? rate : fxRate(shipCurrency)

    const priceAud    = price * rate
    const shippingAud = shipping != null ? shipping * shipRate : null
    const totalAud    = priceAud + (shippingAud ?? 0)

    return {
      itemId:        String(i.itemId ?? ''),
      title:         String(i.title  ?? ''),
      marketplace,
      price,
      currency,
      shipping,
      total:         price + (shipping ?? 0),
      priceAud:      round2(priceAud),
      shippingAud:   shippingAud != null ? round2(shippingAud) : null,
      totalAud:      round2(totalAud),
      fxRate:        rate,
      condition:     i.condition ? String(i.condition) : null,
      seller: {
        name:          i.seller?.username ? String(i.seller.username) : null,
        feedbackScore: i.seller?.feedbackScore != null ? Number(i.seller.feedbackScore) : null,
        feedbackPct:   i.seller?.feedbackPercentage != null ? Number(i.seller.feedbackPercentage) : null,
      },
      itemWebUrl:    String(i.itemWebUrl ?? ''),
      imageUrl:      i.image?.imageUrl ? String(i.image.imageUrl) : (i.thumbnailImages?.[0]?.imageUrl ?? null),
      location:      i.itemLocation?.country ? String(i.itemLocation.country) : null,
      buyingOptions: Array.isArray(i.buyingOptions) ? i.buyingOptions.map(String) : [],
    }
  })
}

function round2(n: number): number { return Math.round(n * 100) / 100 }

// Fan out across every marketplace in `opts.marketplaces` (or the env
// default), merge results, filter by AUD price bounds if set, then sort
// by total AUD delivered cost ascending. One marketplace failing (rate
// limit, geo-block, etc.) doesn't take the whole search down.
export async function searchItems(opts: EbaySearchOptions): Promise<EbaySearchItem[]> {
  if (!opts.query || !opts.query.trim()) return []

  const markets = (opts.marketplaces?.length ? opts.marketplaces : defaultMarketplaces())

  const results = await Promise.allSettled(markets.map(m => searchOne(m, opts)))
  const merged: EbaySearchItem[] = []
  for (const r of results) {
    if (r.status === 'fulfilled') merged.push(...r.value)
    else console.warn('[ebay] marketplace failed:', r.reason?.message ?? r.reason)
  }

  const min = opts.minPrice ?? null
  const max = opts.maxPrice ?? null
  const filtered = merged.filter(i =>
    (min == null || i.totalAud >= min) &&
    (max == null || i.totalAud <= max),
  )

  filtered.sort((a, b) => a.totalAud - b.totalAud)
  return filtered
}
