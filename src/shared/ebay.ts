// Thin wrapper around the eBay Browse API for the parts-sourcing engine.
//
// Auth: application-level OAuth2 (client_credentials grant). One
// EBAY_APP_ID + EBAY_CERT_ID pair authenticates every call — no
// user tokens needed for read-only searching. Tokens live 2 hours;
// we cache in-memory and refresh at ~90% expiry.
//
// Endpoint: /buy/browse/v1/item_summary/search — the "top hits" API
// eBay's own site uses. Returns structured JSON with price + shipping
// broken out cleanly, unlike scraping.
//
// Env:
//   EBAY_APP_ID       (aka Client ID)  — required
//   EBAY_CERT_ID      (aka Client Secret) — required
//   EBAY_ENV          "production" | "sandbox" — default "production"
//   EBAY_MARKETPLACE  "EBAY_AU" | "EBAY_US" | ... — default "EBAY_AU"

const PROD_TOKEN_URL  = 'https://api.ebay.com/identity/v1/oauth2/token'
const SANDBOX_TOKEN_URL = 'https://api.sandbox.ebay.com/identity/v1/oauth2/token'
const PROD_API_BASE   = 'https://api.ebay.com'
const SANDBOX_API_BASE = 'https://api.sandbox.ebay.com'

function isSandbox(): boolean {
  return (process.env.EBAY_ENV ?? 'production').toLowerCase() === 'sandbox'
}

function tokenUrl(): string { return isSandbox() ? SANDBOX_TOKEN_URL : PROD_TOKEN_URL }
function apiBase():  string { return isSandbox() ? SANDBOX_API_BASE  : PROD_API_BASE }
function marketplace(): string { return process.env.EBAY_MARKETPLACE ?? 'EBAY_AU' }

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
  limit?:           number                   // max 200 per eBay; default 5
  minPrice?:        number
  maxPrice?:        number
  conditionIds?:    string[]                 // "1000" new, "3000" used, "2000" refurb
  buyItNowOnly?:    boolean                  // exclude auctions
  categoryIds?:     string[]                 // eBay category filters
  locationCountry?: string                   // "AU" — restrict to AU sellers
  sort?:            'price' | 'newlyListed' | ''
}

export interface EbaySearchItem {
  itemId:         string
  title:          string
  price:          number
  currency:       string
  shipping:       number | null
  total:          number
  condition:      string | null
  seller:         { name: string | null; feedbackScore: number | null; feedbackPct: number | null }
  itemWebUrl:     string
  imageUrl:       string | null
  location:       string | null
  buyingOptions:  string[]
}

export async function searchItems(opts: EbaySearchOptions): Promise<EbaySearchItem[]> {
  if (!opts.query || !opts.query.trim()) return []

  const token = await getToken()
  const params = new URLSearchParams()
  params.set('q', opts.query.trim())
  params.set('limit', String(Math.max(1, Math.min(50, opts.limit ?? 5))))
  if (opts.sort) params.set('sort', opts.sort)

  const filters: string[] = []
  if (opts.buyItNowOnly ?? true) filters.push('buyingOptions:{FIXED_PRICE}')
  if (opts.conditionIds?.length) filters.push(`conditionIds:{${opts.conditionIds.join('|')}}`)
  if (opts.locationCountry ?? 'AU') {
    filters.push(`itemLocationCountry:${opts.locationCountry ?? 'AU'}`)
  }
  if (opts.minPrice != null || opts.maxPrice != null) {
    filters.push(`price:[${opts.minPrice ?? ''}..${opts.maxPrice ?? ''}],priceCurrency:AUD`)
  }
  if (filters.length) params.set('filter', filters.join(','))
  if (opts.categoryIds?.length) params.set('category_ids', opts.categoryIds.join(','))

  const url = `${apiBase()}/buy/browse/v1/item_summary/search?${params.toString()}`
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization':                    `Bearer ${token}`,
      'X-EBAY-C-MARKETPLACE-ID':          marketplace(),
      'X-EBAY-C-ENDUSERCTX':              'contextualLocation=country=AU,zip=3199',
      'Content-Type':                     'application/json',
    },
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`eBay search failed (${res.status}): ${text.slice(0, 300)}`)
  }
  const data = await res.json() as any
  const items = Array.isArray(data.itemSummaries) ? data.itemSummaries : []
  return items.map((i: any): EbaySearchItem => {
    const price    = Number(i.price?.value ?? 0)
    const shipping = i.shippingOptions?.[0]?.shippingCost?.value != null
      ? Number(i.shippingOptions[0].shippingCost.value)
      : null
    return {
      itemId:        String(i.itemId ?? ''),
      title:         String(i.title  ?? ''),
      price,
      currency:      String(i.price?.currency ?? 'AUD'),
      shipping,
      total:         price + (shipping ?? 0),
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
