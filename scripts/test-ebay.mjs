// Quick eBay search smoke — run once creds are in .env.
//
//   node scripts/test-ebay.mjs "oil filter Toyota Corolla 2020"
//   node scripts/test-ebay.mjs "5W-30 full synthetic engine oil 4L" --limit 10

import 'dotenv/config'
// esbuild would bundle this from src/ but we invoke .mjs so wire the
// TS via tsx if you want the module-level file; simpler: reimplement
// the tiny bit needed here. Below inlines the same OAuth + search
// against the eBay Browse API, mirroring src/shared/ebay.ts one-for-one.

const appId  = process.env.EBAY_APP_ID
const certId = process.env.EBAY_CERT_ID
if (!appId || !certId) {
  console.error('Missing EBAY_APP_ID / EBAY_CERT_ID in .env')
  console.error('Get them at https://developer.ebay.com/my/keys')
  process.exit(1)
}

const args     = process.argv.slice(2)
const limitArg = args.indexOf('--limit')
const limit    = limitArg >= 0 ? Number(args[limitArg + 1]) : 5
const query    = args.filter((_, i) => i !== limitArg && i !== limitArg + 1).join(' ')
if (!query) { console.error('Usage: node scripts/test-ebay.mjs "<query>" [--limit 5]'); process.exit(1) }

const marketplace = process.env.EBAY_MARKETPLACE ?? 'EBAY_AU'
const env         = (process.env.EBAY_ENV ?? 'production').toLowerCase()
const tokenUrl    = env === 'sandbox' ? 'https://api.sandbox.ebay.com/identity/v1/oauth2/token' : 'https://api.ebay.com/identity/v1/oauth2/token'
const apiBase     = env === 'sandbox' ? 'https://api.sandbox.ebay.com' : 'https://api.ebay.com'

console.log(`— eBay ${env} · ${marketplace} · limit ${limit} · "${query}"`)

// 1. Token
const basic = Buffer.from(`${appId}:${certId}`).toString('base64')
const tRes = await fetch(tokenUrl, {
  method:  'POST',
  headers: { 'Authorization': `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
  body:    new URLSearchParams({ grant_type: 'client_credentials', scope: 'https://api.ebay.com/oauth/api_scope' }).toString(),
})
if (!tRes.ok) {
  console.error(`Token exchange failed: ${tRes.status} — ${await tRes.text()}`)
  process.exit(1)
}
const { access_token } = await tRes.json()
console.log('  ✓ token OK')

// 2. Search
const params = new URLSearchParams({
  q:      query,
  limit:  String(limit),
  filter: 'buyingOptions:{FIXED_PRICE},itemLocationCountry:AU',
})
const sRes = await fetch(`${apiBase}/buy/browse/v1/item_summary/search?${params.toString()}`, {
  headers: {
    'Authorization':           `Bearer ${access_token}`,
    'X-EBAY-C-MARKETPLACE-ID': marketplace,
    'Content-Type':            'application/json',
  },
})
if (!sRes.ok) {
  console.error(`Search failed: ${sRes.status} — ${await sRes.text()}`)
  process.exit(1)
}
const data = await sRes.json()
const items = data.itemSummaries ?? []
console.log(`  ✓ ${items.length} result${items.length === 1 ? '' : 's'}\n`)

for (const i of items) {
  const price    = i.price?.value ? `$${i.price.value}` : '(no price)'
  const shipping = i.shippingOptions?.[0]?.shippingCost?.value
    ? ` + $${i.shippingOptions[0].shippingCost.value} ship`
    : ''
  const cond     = i.condition ? ` [${i.condition}]` : ''
  const seller   = i.seller?.username ? ` — ${i.seller.username}` : ''
  console.log(`  ${price}${shipping}${cond}${seller}`)
  console.log(`    ${i.title.slice(0, 100)}`)
  console.log(`    ${i.itemWebUrl}`)
  console.log('')
}
