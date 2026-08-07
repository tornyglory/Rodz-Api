// Quick eBay search smoke — multi-marketplace (AU + US by default),
// results ranked by total delivered-to-AU cost.
//
//   node scripts/test-ebay.mjs "oil filter Toyota Corolla 2020"
//   node scripts/test-ebay.mjs "5W-30 full synthetic engine oil 4L" --limit 10
//   node scripts/test-ebay.mjs "brake pads Toyota Corolla" --markets EBAY_AU,EBAY_US,EBAY_GB

import 'dotenv/config'

const appId  = process.env.EBAY_APP_ID
const certId = process.env.EBAY_CERT_ID
if (!appId || !certId) {
  console.error('Missing EBAY_APP_ID / EBAY_CERT_ID in .env')
  process.exit(1)
}

const args = process.argv.slice(2)
function readFlag(flag) {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : null
}
function stripFlag(flag) {
  const i = args.indexOf(flag)
  if (i < 0) return
  args.splice(i, 2)
}
const limit   = Number(readFlag('--limit') ?? 5)
const markets = (readFlag('--markets') ?? 'EBAY_AU,EBAY_US').split(',').map(s => s.trim()).filter(Boolean)
stripFlag('--limit'); stripFlag('--markets')
const query = args.join(' ')
if (!query) { console.error('Usage: node scripts/test-ebay.mjs "<query>" [--limit 5] [--markets EBAY_AU,EBAY_US]'); process.exit(1) }

const env      = (process.env.EBAY_ENV ?? 'production').toLowerCase()
const tokenUrl = env === 'sandbox' ? 'https://api.sandbox.ebay.com/identity/v1/oauth2/token' : 'https://api.ebay.com/identity/v1/oauth2/token'
const apiBase  = env === 'sandbox' ? 'https://api.sandbox.ebay.com' : 'https://api.ebay.com'
const shipToC  = process.env.EBAY_SHIP_TO_COUNTRY  ?? 'AU'
const shipToPc = process.env.EBAY_SHIP_TO_POSTCODE ?? '3199'

const fxDefaults = { AUD: 1, USD: 1.52, GBP: 1.93, EUR: 1.65, NZD: 0.92, JPY: 0.010, CAD: 1.11, HKD: 0.20, SGD: 1.15, CNY: 0.21 }
function fx(cur) { return fxDefaults[cur?.toUpperCase()] ?? 1 }

console.log(`— eBay ${env} · ship to ${shipToC} ${shipToPc} · markets ${markets.join(', ')} · "${query}"`)

// Token
const basic = Buffer.from(`${appId}:${certId}`).toString('base64')
const tRes = await fetch(tokenUrl, {
  method: 'POST',
  headers: { 'Authorization': `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'https://api.ebay.com/oauth/api_scope' }).toString(),
})
if (!tRes.ok) { console.error(`Token: ${tRes.status} — ${await tRes.text()}`); process.exit(1) }
const { access_token } = await tRes.json()
console.log('  ✓ token OK\n')

// Fan out per marketplace, merge, rank by AUD total
const params = new URLSearchParams({
  q:      query,
  limit:  String(limit),
  filter: 'buyingOptions:{FIXED_PRICE}',
})

const perMarket = await Promise.allSettled(markets.map(async m => {
  const res = await fetch(`${apiBase}/buy/browse/v1/item_summary/search?${params.toString()}`, {
    headers: {
      'Authorization':           `Bearer ${access_token}`,
      'X-EBAY-C-MARKETPLACE-ID': m,
      'X-EBAY-C-ENDUSERCTX':     `contextualLocation=country=${shipToC},zip=${shipToPc}`,
      'Content-Type':            'application/json',
    },
  })
  if (!res.ok) throw new Error(`${m}: ${res.status} — ${(await res.text()).slice(0, 120)}`)
  const data = await res.json()
  return { marketplace: m, items: data.itemSummaries ?? [] }
}))

function daysFromNow(iso) {
  if (!iso) return null
  const d = new Date(iso).getTime()
  if (!Number.isFinite(d)) return null
  return Math.max(0, Math.ceil((d - Date.now()) / (1000 * 60 * 60 * 24)))
}

const rows = []
for (const r of perMarket) {
  if (r.status === 'rejected') { console.warn('  ⚠ ' + r.reason.message); continue }
  const { marketplace, items } = r.value
  for (const i of items) {
    const cur       = i.price?.currency ?? 'AUD'
    const price     = Number(i.price?.value ?? 0)
    const rate      = fx(cur)
    const opt       = i.shippingOptions?.[0] ?? {}
    const ship      = opt.shippingCost?.value != null ? Number(opt.shippingCost.value) : null
    const shipCur   = opt.shippingCost?.currency ?? cur
    const shipRate  = shipCur === cur ? rate : fx(shipCur)
    const priceAud  = price * rate
    const shipAud   = ship != null ? ship * shipRate : null
    const totalAud  = priceAud + (shipAud ?? 0)
    const dMin      = daysFromNow(opt.minEstimatedDeliveryDate)
    const dMax      = daysFromNow(opt.maxEstimatedDeliveryDate)
    rows.push({
      marketplace, cur, price, rate, ship, priceAud, shipAud, totalAud,
      dMin, dMax,
      title:  String(i.title ?? ''),
      cond:   i.condition ?? null,
      seller: i.seller?.username ?? null,
      url:    i.itemWebUrl ?? null,
      loc:    i.itemLocation?.country ?? null,
    })
  }
}

rows.sort((a, b) => a.totalAud - b.totalAud)
console.log(`  ✓ ${rows.length} total results (ranked by delivered AUD)\n`)

function eta(min, max) {
  if (min == null && max == null) return 'ETA unknown'
  if (min != null && max != null && min !== max) return `arrives in ${min}-${max} days`
  return `arrives in ~${min ?? max} days`
}

for (const r of rows.slice(0, limit)) {
  const shipStr = r.shipAud != null ? ` + $${r.shipAud.toFixed(2)} ship` : ''
  const nativeStr = r.cur === 'AUD' ? '' : `  (${r.cur} ${r.price.toFixed(2)} @ ${r.rate})`
  const cond = r.cond ? `[${r.cond}] ` : ''
  console.log(`  A$${r.priceAud.toFixed(2)}${shipStr}  =  A$${r.totalAud.toFixed(2)}  ·  ${eta(r.dMin, r.dMax)}${nativeStr}`)
  console.log(`    ${cond}${r.marketplace} — ${r.seller ?? '(unknown)'} · ${r.loc ?? '?'}`)
  console.log(`    ${r.title.slice(0, 100)}`)
  console.log(`    ${r.url}`)
  console.log('')
}
