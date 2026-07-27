# Vehicle prerender — Cloudflare Pages Function brief

Server-render `/vehicle/{token}` on the edge so search engines and social
crawlers see rich content, structured data, and correct meta tags without
having to execute the SPA.

Backend is live. Two endpoints do all the work you need:

- `GET /logbook/{token}/seo-payload` — consolidated payload for a single vehicle
- `GET /vehicles/public-index` — list of indexable tokens for the sitemap

Full endpoint reference: [`vehicle-seo-payload-endpoint.md`](./vehicle-seo-payload-endpoint.md).
Toggle context: [`vehicle-search-index-toggle-frontend-brief.md`](./vehicle-search-index-toggle-frontend-brief.md).

---

## What you're building

Three Pages Functions in the SPA repo:

| Route | File | Purpose |
|-------|------|---------|
| `/vehicle/:token` | `functions/vehicle/[token].ts` | SSR shell that fetches the payload and injects meta + JSON-LD + a `<noscript>` body summary into the SPA's `index.html`. |
| `/sitemap.xml` | `functions/sitemap.xml.ts` | Emits sitemap XML from the public-index feed. |
| `/robots.txt` | `functions/robots.txt.ts` | Allows `/vehicle/*`, disallows the auth-gated surfaces. |

Everything is fetch-and-inject. No component work in the SPA itself — the
existing client-side rendering stays intact and hydrates on top of the
SSR'd shell.

---

## Environment

Set on the Cloudflare Pages project (Production + Preview):

```
API_BASE = https://fzzrkscwd7.execute-api.ap-southeast-2.amazonaws.com
SITE_URL = https://rodz.com.au        # or whatever the production origin is
```

---

## API contract — quick reference

### `GET /logbook/{token}/seo-payload`

**No auth.** Returns one of two shapes:

**When `publicProfileSettings.searchIndex === false`:**
```json
{
  "searchIndex":  false,
  "vehicle":      { "rego", "regoState", "year", "make", "model" },
  "lastMutation": "2026-07-26T12:34:56.000Z"
}
```
→ SPA still works for real users, but you must inject `<meta name="robots" content="noindex, nofollow">`.

**When `searchIndex === true`:** full payload. Notable fields:
- `vehicle` — full spec sheet: rego, year, make, model, series, colour, body/fuel/transmission/drive, engine details, odometer, VIN, coverUrl, avatarUrl, city, country, for-sale + price.
- `description`, `ownerDescription` — owner-authored blurbs. **Only these two are safe as body prose.**
- `aiOverview.source` — `"override"` | `"base"` | `null`. **Only render `text` when `source === "override"`** (see duplicate-content policy below).
- `ownerCard` — `{ displayName: "Neville R.", city, avatarUrl, memberSince }`. Omitted when hidden.
- `gallery`, `serviceHistoryPreview`, `modificationsPreview`, `storiesPreview` — omitted entirely when the matching visibility toggle is off.
- `lastMutation` — ISO timestamp; use as the `Last-Modified` header and as the cache-bust key.

Errors:
- `404` — token doesn't exist (never issued / rotated)
- `410` — vehicle soft-deleted

For both, serve the SPA with `<meta robots noindex>` — don't 404 the page itself.

### `GET /vehicles/public-index`

**No auth.** Returns `{ items: [{ token, updatedAt }] }` for every vehicle with `is_active=1` and `searchIndex` not explicitly `false`.

---

## Duplicate-content policy — critical

Google demotes sites that publish thousands of near-identical body copies.
On our vehicle pages the risk is real: every 2017 Suzuki Vitara shares a
per-model AI-generated `overview` string.

**Rules**, enforced by the backend already; you must respect them when rendering:

- `aiOverview.source === "base"` → `text` is `null`. **Do not render it.** Fall back to `description` / `ownerDescription` / an assembled unique blurb.
- `aiOverview.source === "override"` → the owner has regenerated with a tone. `text` is unique to this vehicle. Safe to render as body prose.
- Never surface `engineSpecs`, `tyreSpecs`, `commonRepairs`, `serviceNotes`, or `knownIssues` from the shared model profile as body text. They're fine as JSON-LD structured data.

The backend's `shapeAiOverview` helper enforces this, but it only protects the payload contract — the Function must not go looking for the base text elsewhere.

---

## File 1 — `functions/vehicle/[token].ts`

```ts
// Cloudflare Pages Function — SEO prerender for /vehicle/:token

interface Env {
  API_BASE: string
  SITE_URL: string
  ASSETS:   { fetch: (req: Request) => Promise<Response> }
}

type ImageThumb = { url: string; alt: string | null }

type SeoPayload =
  | {
      searchIndex:  false
      lastMutation: string
      vehicle: {
        rego: string; regoState: string | null; year: number
        make: string; model: string
      }
    }
  | {
      searchIndex:  true
      lastMutation: string
      vehicle: {
        rego: string; regoState: string | null; year: number
        make: string; model: string; series: string | null; colour: string | null
        bodyType: string | null; fuelType: string | null; transmission: string | null
        driveType: string | null; engineCode: string | null
        engineSizeCC: number | null; engineSize: string | null
        cylinders: number | null; odometerKm: number | null; vin: string | null
        avatarUrl: string | null; coverUrl: string | null
        city: string | null; country: string | null
        forSale: boolean; askingPrice: number | null
        logbookToken: string
      }
      publicProfileSettings: Record<string, boolean>
      description:      string | null
      ownerDescription: string | null
      aiOverview: {
        source: 'override' | 'base' | null
        tone:   string | null
        text:   string | null
      }
      ownerCard?: {
        displayName: string; city: string | null
        avatarUrl: string | null; memberSince: string
      }
      gallery?:               ImageThumb[]
      serviceHistoryPreview?: {
        totalCount: number
        entries: Array<{
          id: string; date: string | null; odometerKm: number | null
          title: string | null; workshop: string | null
          workshopSuburb: string | null; cost: number | null
          source: 'workshop' | 'external'
        }>
      }
      modificationsPreview?: {
        totalCount: number; totalInvested: number
        items: Array<{
          id: number; name: string; category: string
          installedAt: string | null; status: string
          thumbUrl: string | null
        }>
      }
      storiesPreview?: {
        totalCount: number
        items: Array<{
          id: string; title: string; preview: string | null
          eventDate: string | null; coverUrl: string | null
          hasVideo: boolean; reactionsCount: number
        }>
      }
    }

export const onRequestGet: PagesFunction<Env> = async ({ params, env }) => {
  const token = params.token as string
  if (!token || !/^[a-f0-9]{64}$/i.test(token)) {
    return serveSpa(env, { noindex: true })
  }

  const apiRes = await fetch(`${env.API_BASE}/logbook/${token}/seo-payload`, {
    headers: { accept: 'application/json' },
    cf: { cacheTtl: 300, cacheEverything: true },
  })

  if (apiRes.status === 404 || apiRes.status === 410) {
    return serveSpa(env, { noindex: true })
  }
  if (!apiRes.ok) {
    // Better a working SPA than a 500 — crawlers get no meta, they'll re-crawl.
    return serveSpa(env)
  }

  const data = (await apiRes.json()) as SeoPayload

  if (!data.searchIndex) {
    return serveSpa(env, {
      noindex: true,
      title:   buildTitle(data.vehicle),
      url:     `${env.SITE_URL}/vehicle/${token}`,
    })
  }

  const canonical = `${env.SITE_URL}/vehicle/${token}`
  return serveSpa(env, {
    noindex:      false,
    title:        buildTitle(data.vehicle),
    description:  buildDescription(data),
    url:          canonical,
    ogImage:      data.vehicle.coverUrl ?? data.vehicle.avatarUrl ?? null,
    jsonLd:       buildVehicleJsonLd(data, canonical),
    bodyContent:  buildNoscriptBody(data),
    lastModified: data.lastMutation,
  })
}

// ── HTML shaping ──────────────────────────────────────────────────────────

function buildTitle(v: SeoPayload['vehicle']): string {
  return `${v.year} ${v.make} ${v.model} — Rodz Logbook`
}

function buildDescription(data: Extract<SeoPayload, { searchIndex: true }>): string {
  if (data.description) return truncate(data.description, 160)
  if (data.aiOverview.source === 'override' && data.aiOverview.text) {
    return truncate(data.aiOverview.text, 160)
  }
  if (data.ownerDescription) return truncate(data.ownerDescription, 160)
  const v = data.vehicle
  const loc = v.city ? ` in ${v.city}` : ''
  const forSale = v.forSale ? ' — for sale' : ''
  return `${v.year} ${v.make} ${v.model} (${v.rego})${loc}${forSale}. Full service history and photos on Rodz Logbook.`
}

function buildVehicleJsonLd(
  data: Extract<SeoPayload, { searchIndex: true }>,
  url: string,
): Record<string, unknown> {
  const v = data.vehicle
  const schema: Record<string, unknown> = {
    '@context':       'https://schema.org',
    '@type':          'Vehicle',
    url,
    name:             `${v.year} ${v.make} ${v.model}`,
    brand:            { '@type': 'Brand', name: v.make },
    model:            v.model,
    modelDate:        String(v.year),
    vehicleModelDate: String(v.year),
  }
  if (v.colour)       schema.color                = v.colour
  if (v.bodyType)     schema.bodyType             = v.bodyType
  if (v.fuelType)     schema.fuelType             = v.fuelType
  if (v.transmission) schema.vehicleTransmission  = v.transmission
  if (v.driveType)    schema.driveWheelConfiguration = v.driveType
  if (v.engineSizeCC) schema.engineDisplacement   = { '@type': 'QuantitativeValue', value: v.engineSizeCC, unitCode: 'CMQ' }
  if (v.odometerKm)   schema.mileageFromOdometer  = { '@type': 'QuantitativeValue', value: v.odometerKm, unitCode: 'KMT' }
  if (v.vin)          schema.vehicleIdentificationNumber = v.vin
  if (v.coverUrl || v.avatarUrl) {
    schema.image = [v.coverUrl, v.avatarUrl].filter(Boolean)
  }
  if (v.forSale && v.askingPrice != null) {
    schema.offers = {
      '@type':       'Offer',
      priceCurrency: 'AUD',
      price:         v.askingPrice,
      availability:  'https://schema.org/InStock',
      url,
    }
  }
  return schema
}

function buildNoscriptBody(data: Extract<SeoPayload, { searchIndex: true }>): string {
  const v = data.vehicle
  const parts: string[] = []

  parts.push(`<h1>${esc(`${v.year} ${v.make} ${v.model}`)}${v.series ? ` ${esc(v.series)}` : ''}</h1>`)
  if (v.city || v.country) {
    parts.push(`<p>${esc([v.city, v.country].filter(Boolean).join(', '))}</p>`)
  }
  if (v.forSale && v.askingPrice != null) {
    parts.push(`<p><strong>For sale — A$${v.askingPrice.toLocaleString('en-AU')}</strong></p>`)
  }

  if (data.description) {
    parts.push(`<h2>About this ${esc(v.make)} ${esc(v.model)}</h2><p>${esc(data.description)}</p>`)
  }

  // Only override AI overviews may be surfaced — base is duplicate content.
  if (data.aiOverview.source === 'override' && data.aiOverview.text) {
    parts.push(`<h2>Overview</h2><p>${esc(data.aiOverview.text)}</p>`)
  }

  const specs: Array<[string, string | number | null]> = [
    ['Registration',  v.rego],
    ['Colour',        v.colour],
    ['Body',          v.bodyType],
    ['Fuel',          v.fuelType],
    ['Transmission',  v.transmission],
    ['Drive',         v.driveType],
    ['Engine',        v.engineCode],
    ['Displacement',  v.engineSize],
    ['Cylinders',     v.cylinders],
    ['Odometer',      v.odometerKm != null ? `${v.odometerKm.toLocaleString('en-AU')} km` : null],
  ].filter(([, val]) => val != null && val !== '') as Array<[string, string | number]>
  if (specs.length) {
    parts.push('<h2>Specifications</h2><dl>')
    for (const [k, val] of specs) parts.push(`<dt>${esc(k)}</dt><dd>${esc(String(val))}</dd>`)
    parts.push('</dl>')
  }

  if (data.serviceHistoryPreview?.entries?.length) {
    parts.push(`<h2>Service history (${data.serviceHistoryPreview.totalCount})</h2><ul>`)
    for (const e of data.serviceHistoryPreview.entries) {
      const bits = [e.date, e.title, e.workshop, e.cost != null ? `A$${e.cost}` : null].filter(Boolean)
      parts.push(`<li>${esc(bits.join(' — '))}</li>`)
    }
    parts.push('</ul>')
  }

  if (data.modificationsPreview?.items?.length) {
    parts.push(`<h2>Modifications (${data.modificationsPreview.totalCount})</h2><ul>`)
    for (const m of data.modificationsPreview.items) {
      parts.push(`<li>${esc(`${m.name} — ${m.category}${m.installedAt ? ` (${m.installedAt})` : ''}`)}</li>`)
    }
    parts.push('</ul>')
  }

  if (data.storiesPreview?.items?.length) {
    parts.push(`<h2>Stories</h2>`)
    for (const s of data.storiesPreview.items) {
      parts.push(`<article><h3>${esc(s.title)}</h3>${s.preview ? `<p>${esc(s.preview)}</p>` : ''}</article>`)
    }
  }

  if (data.ownerCard) {
    parts.push(`<p>Owner: ${esc(data.ownerCard.displayName)}${data.ownerCard.city ? ` — ${esc(data.ownerCard.city)}` : ''}</p>`)
  }

  return parts.join('\n')
}

// ── SPA composition via HTMLRewriter ──────────────────────────────────────

interface InjectOpts {
  noindex?:      boolean
  title?:        string
  description?:  string
  url?:          string
  ogImage?:      string | null
  jsonLd?:       Record<string, unknown>
  bodyContent?:  string
  lastModified?: string
}

async function serveSpa(env: Env, opts: InjectOpts = {}): Promise<Response> {
  const shell = await env.ASSETS.fetch(new Request(`${env.SITE_URL}/index.html`))
  if (!shell.ok) return shell

  const rewriter = new HTMLRewriter()

  rewriter.on('head', {
    element(el) {
      if (opts.noindex) {
        el.append(`<meta name="robots" content="noindex, nofollow">`, { html: true })
      }
      if (opts.title) {
        el.append(`<meta property="og:title" content="${escAttr(opts.title)}">`, { html: true })
        el.append(`<meta name="twitter:title" content="${escAttr(opts.title)}">`, { html: true })
      }
      if (opts.description) {
        el.append(`<meta name="description" content="${escAttr(opts.description)}">`, { html: true })
        el.append(`<meta property="og:description" content="${escAttr(opts.description)}">`, { html: true })
        el.append(`<meta name="twitter:description" content="${escAttr(opts.description)}">`, { html: true })
      }
      if (opts.url) {
        el.append(`<link rel="canonical" href="${escAttr(opts.url)}">`, { html: true })
        el.append(`<meta property="og:url" content="${escAttr(opts.url)}">`, { html: true })
        el.append(`<meta property="og:type" content="website">`, { html: true })
      }
      if (opts.ogImage) {
        el.append(`<meta property="og:image" content="${escAttr(opts.ogImage)}">`, { html: true })
        el.append(`<meta name="twitter:card" content="summary_large_image">`, { html: true })
        el.append(`<meta name="twitter:image" content="${escAttr(opts.ogImage)}">`, { html: true })
      }
      if (opts.jsonLd) {
        el.append(
          `<script type="application/ld+json">${JSON.stringify(opts.jsonLd)}</script>`,
          { html: true },
        )
      }
    },
  })

  if (opts.title) {
    rewriter.on('title', {
      element(el) { el.setInnerContent(opts.title!) },
    })
  }

  if (opts.bodyContent) {
    rewriter.on('body', {
      element(el) {
        el.append(`<noscript><div class="rodz-seo-content">${opts.bodyContent}</div></noscript>`, {
          html: true,
        })
      },
    })
  }

  const rewritten = rewriter.transform(shell)
  const headers = new Headers(rewritten.headers)
  headers.set('content-type', 'text/html; charset=utf-8')
  headers.set('cache-control', 'public, s-maxage=3600, stale-while-revalidate=86400')
  if (opts.lastModified) {
    headers.set('last-modified', new Date(opts.lastModified).toUTCString())
  }
  return new Response(rewritten.body, { status: rewritten.status, headers })
}

// ── Utilities ─────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}
function escAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}
function truncate(s: string, n: number): string {
  s = s.replace(/\s+/g, ' ').trim()
  if (s.length <= n) return s
  return s.slice(0, n - 1).trimEnd() + '…'
}
```

---

## File 2 — `functions/sitemap.xml.ts`

```ts
interface Env {
  API_BASE: string
  SITE_URL: string
}

interface IndexItem { token: string; updatedAt: string }

export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  const res = await fetch(`${env.API_BASE}/vehicles/public-index`, {
    headers: { accept: 'application/json' },
    cf: { cacheTtl: 3600, cacheEverything: true },
  })
  if (!res.ok) {
    return new Response(
      `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>`,
      { status: 200, headers: { 'content-type': 'application/xml' } },
    )
  }
  const { items } = (await res.json()) as { items: IndexItem[] }

  const urls = items
    .map((it) => {
      const lastmod = new Date(it.updatedAt).toISOString().slice(0, 10)
      return `  <url><loc>${env.SITE_URL}/vehicle/${it.token}</loc><lastmod>${lastmod}</lastmod><changefreq>weekly</changefreq></url>`
    })
    .join('\n')

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>`

  return new Response(xml, {
    headers: {
      'content-type':  'application/xml; charset=utf-8',
      'cache-control': 'public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400',
    },
  })
}
```

---

## File 3 — `functions/robots.txt.ts`

```ts
interface Env { SITE_URL: string }

export const onRequestGet: PagesFunction<Env> = ({ env }) => {
  const body = `User-agent: *
Allow: /vehicle/
Disallow: /logbook/
Disallow: /c/
Disallow: /admin/

Sitemap: ${env.SITE_URL}/sitemap.xml
`
  return new Response(body, {
    headers: {
      'content-type':  'text/plain; charset=utf-8',
      'cache-control': 'public, max-age=86400',
    },
  })
}
```

---

## Crawler-visible content strategy

The `bodyContent` above is wrapped in `<noscript>`. Two consequences:

- **Real users with JS on** — see only the SPA. The `<noscript>` block is invisible; no hydration conflict; no layout shift.
- **Crawlers that don't execute JS** (Bing, DuckDuckGo, social crawlers, Google's initial pass) — see the `<noscript>` content as body text.
- **Google's rendering pass** — executes the SPA; the `<noscript>` disappears; Google indexes what the SPA produces.

This is deliberately the conservative option. If SEO ranking suggests we need stronger signals — i.e. Googlebot's rendering pass isn't seeing enough on JS-heavy pages — we can swap `<noscript>` for injecting the SEO content directly into the SPA's mount point (`<div id="app">` / `<div id="root">`), so it's present pre-hydration. That change requires knowing your framework's hydration behaviour (React 18's `hydrateRoot` will attempt to reconcile; Vue's SSR expects matching markup). Talk to us before making that swap.

Meta tags and JSON-LD go into `<head>` regardless — they're safe from hydration entirely and are what social crawlers use.

---

## Testing checklist

Before merging:

- [ ] Local dev — `wrangler pages dev` renders `/vehicle/{real-token}` and injects meta + JSON-LD.
- [ ] `curl -H 'User-Agent: Googlebot' https://{preview-url}/vehicle/{token} | grep -Ei "og:title|application/ld+json|robots"` returns the expected tags.
- [ ] Set `searchIndex: false` on a test vehicle via the customer portal. `curl` the URL → contains `<meta name="robots" content="noindex, nofollow">`.
- [ ] Set it back to `true` → the noindex meta is gone within ~5 min (backend Redis TTL) or immediately if the vehicle's `updated_at` bumped.
- [ ] Invalid token (random hex, or non-hex garbage) → SPA renders with `noindex` meta, page still works.
- [ ] Soft-deleted vehicle → same behaviour as invalid token.
- [ ] `curl https://{preview-url}/sitemap.xml` returns valid XML with URLs.
- [ ] `curl https://{preview-url}/robots.txt` matches the expected block.
- [ ] Google's [Rich Results Test](https://search.google.com/test/rich-results) validates the Vehicle JSON-LD.
- [ ] Facebook's [Sharing Debugger](https://developers.facebook.com/tools/debug/) shows the correct og:title / og:description / og:image.

---

## Rollout order

1. Ship the three functions to a preview environment.
2. Manually test with a few real tokens (see checklist above).
3. Deploy to production.
4. Submit `https://rodz.com.au/sitemap.xml` to Google Search Console and Bing Webmaster Tools.
5. Wait ~1 week, then check Search Console coverage / rich results reports.

---

## Follow-ups (out of scope for v1)

- **Cache purge on writes** — when an owner flips `searchIndex` or edits their vehicle, the change propagates once the backend Redis cache expires (5 min) or the vehicle's `updated_at` bumps the cache key. If crawler freshness becomes an issue, add a Cloudflare zone purge hook on `PATCH /c/vehicles/{id}*` in RodzAPI. Requires `CF_ZONE_ID` + `CF_PURGE_TOKEN` on the API's shared env.
- **Sitemap size** — a single sitemap XML is fine up to 50k URLs / 50 MB. Well beyond that, split into a sitemap index. Not urgent.
- **Search Console notification on `searchIndex: true → false`** — surface the flip to the customer portal and offer them a "notify Google to de-index" button. Post-v1.
- **Hydration-safe SSR content** — see "Crawler-visible content strategy" above. Consider once we have real ranking data.
