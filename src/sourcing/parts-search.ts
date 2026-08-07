import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getAuthContext } from '../shared/auth'
import { ok, validationError, forbidden, serverError } from '../shared/errors'
import { searchItems } from '../shared/ebay'

// GET /parts-search?q=<query>[&year=Y][&make=X][&model=X][&limit=N][&markets=EBAY_AU,EBAY_US][&minAud=X][&maxAud=Y]
//
// Ad-hoc eBay lookup — no persistence, no booking context. For manual
// price checks / phone quotes / walk-ins where the workshop just wants
// current market prices for a part.
//
// Vehicle hints (year/make/model) get appended to the query if given.
// Results are ranked by delivered-to-AU total, same as the sourcing
// engine, so a manager can trust the ordering.

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const ctx = getAuthContext(event)

  // Any staff role can search — eBay Browse API is read-only, no cost
  // impact from technicians experimenting with queries.
  if (!ctx.staffId) return forbidden()

  try {
    const q          = (event.queryStringParameters?.q ?? '').trim()
    if (!q) return validationError('q is required (search text)')

    const year       = event.queryStringParameters?.year
    const make       = event.queryStringParameters?.make
    const model      = event.queryStringParameters?.model
    const limit      = Math.min(50, Math.max(1, Number(event.queryStringParameters?.limit) || 10))
    const marketsRaw = event.queryStringParameters?.markets
    const marketplaces = marketsRaw
      ? marketsRaw.split(',').map(s => s.trim()).filter(Boolean)
      : undefined
    const minAud = event.queryStringParameters?.minAud ? Number(event.queryStringParameters.minAud) : undefined
    const maxAud = event.queryStringParameters?.maxAud ? Number(event.queryStringParameters.maxAud) : undefined

    // Compose the final query — vehicle hints tacked on end so results
    // are narrowed to fitment when provided. Keeps ~120 chars max to
    // avoid diluting eBay's relevance signal.
    const parts = [q, year, make, model].map(s => (s ?? '').trim()).filter(Boolean)
    const query = parts.join(' ').slice(0, 200)

    const items = await searchItems({
      query,
      limit,
      marketplaces,
      minPrice: minAud,
      maxPrice: maxAud,
    })

    return ok({
      query,
      composed: {
        base:  q,
        year:  year ?? null,
        make:  make ?? null,
        model: model ?? null,
      },
      marketplaces: marketplaces ?? null,
      count:        items.length,
      results:      items.map(i => ({
        itemId:          i.itemId,
        title:           i.title,
        marketplace:     i.marketplace,
        priceNative:     i.price,
        currency:        i.currency,
        shippingNative:  i.shipping,
        priceAud:        i.priceAud,
        shippingAud:     i.shippingAud,
        totalAud:        i.totalAud,
        fxRate:          i.fxRate,
        shippingCostType: i.shippingCostType,
        deliveryMinDays: i.deliveryMinDays,
        deliveryMaxDays: i.deliveryMaxDays,
        deliveryMinDate: i.deliveryMinDate,
        deliveryMaxDate: i.deliveryMaxDate,
        condition:       i.condition,
        seller:          i.seller,
        location:        i.location,
        productUrl:      i.itemWebUrl,
        imageUrl:        i.imageUrl,
      })),
    })
  } catch (err) {
    return serverError(err)
  }
}
