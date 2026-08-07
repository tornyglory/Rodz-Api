# Parts Search — Frontend Brief

Standalone ad-hoc parts search — hits eBay across AU + US + UK + DE
in parallel, returns delivered-to-AU ranked results with delivery
ETAs. Not tied to any booking. Useful for:

- Manager doing a **phone quote** — "how much is a brake rotor for a 2018 Civic?"
- **Walk-in** — customer wants a price on a part before booking
- Parts staff **spot-checking** margins on a supplier's current pricing
- **Debugging** the sourcing engine by comparing what search returns
  for a query the workshop composed by hand

Backend deployed 2026-08-07. Endpoint on the admin API.

---

## Endpoint

```
GET https://lukck5txvh.execute-api.ap-southeast-2.amazonaws.com/parts-search
Authorization: Bearer <staff_jwt>
```

Any staff role (super_admin / store_manager / technician). Read-only.

### Query params

| Param | Type | Required | Notes |
|---|---|---|---|
| `q` | string | ✅ | Free-text search — e.g. `"brake pads"`, `"NGK spark plugs iridium"`, `"90915-YZZN2"` (OEM part number works) |
| `year` | int | — | Optional vehicle hint, appended to the query |
| `make` | string | — | Ditto |
| `model` | string | — | Ditto |
| `limit` | int | — | 1-50, default 10 per marketplace |
| `markets` | csv | — | Override marketplaces. Default `EBAY_AU,EBAY_US,EBAY_GB,EBAY_DE`. Pass e.g. `EBAY_AU` for AU-only, `EBAY_AU,EBAY_US` for AU+US |
| `minAud` | number | — | Filter — minimum total AUD (delivered) |
| `maxAud` | number | — | Filter — maximum total AUD (delivered) |

Vehicle hints are simply appended to the search string. So:

```
q=oil filter&year=2020&make=Toyota&model=Corolla
   → composed query: "oil filter 2020 Toyota Corolla"
```

Send whatever combination is useful. The manager typing "brake pads Corolla" in a search box is equivalent to `q=brake pads Corolla` with no vehicle hints.

---

## Response shape

```jsonc
{
  "query":         "brake pads 2020 Toyota Corolla",   // final composed string sent to eBay
  "composed": {
    "base":        "brake pads",
    "year":        "2020",
    "make":        "Toyota",
    "model":       "Corolla"
  },
  "marketplaces":  null,                               // when default was used; otherwise the array passed
  "count":         14,
  "results": [
    {
      "itemId":          "144149354486",
      "title":           "Bendix Brake Pads Front DB1808 for Toyota Corolla ZRE182",
      "marketplace":     "EBAY_AU",
      "priceNative":     58.00,
      "currency":        "AUD",
      "shippingNative":  9.95,
      "priceAud":        58.00,
      "shippingAud":     9.95,
      "totalAud":        67.95,          // ← the ranking key
      "fxRate":          1.0000,
      "shippingCostType": "FIXED",       // "FIXED" | "CALCULATED" | null
      "deliveryMinDays": 5,
      "deliveryMaxDays": 11,
      "deliveryMinDate": "2026-08-12T14:00:00.000Z",
      "deliveryMaxDate": "2026-08-18T14:00:00.000Z",
      "condition":       "Brand New",
      "seller": {
        "name":          "bendixbrakes_au",
        "feedbackScore": 4287,
        "feedbackPct":   99.6
      },
      "location":        "AU",
      "productUrl":      "https://www.ebay.com.au/itm/144149354486?…",
      "imageUrl":        "https://i.ebayimg.com/…"
    }
    // …up to `limit × marketplaces` results, sorted by totalAud ascending
  ]
}
```

### Field notes

- **`totalAud`** — the primary ranking. Item price + shipping, both converted to AUD via built-in FX rates.
- **`deliveryMinDays` / `deliveryMaxDays`** — days from *now*, computed by the backend. When `null`, eBay couldn't estimate (common for some DE sellers) — show "ETA unknown" in the UI.
- **`fxRate`** — the conversion factor applied. If `1.0` the item was already in AUD.
- **`condition`** — free text from eBay (`"Brand New"`, `"Used"`, `"Refurbished"`).
- **`seller.feedbackPct`** — 0-100 %. Below 95 % is worth flagging.
- **`imageUrl`** — 500×500 usually. Nullable.

Sorted by `totalAud` ascending. Reversal / re-sort should happen client-side for speed.

### Errors

| Status | Code | When |
|---|---|---|
| `403` | `FORBIDDEN` | No `staffId` in the JWT |
| `422` | `VALIDATION_ERROR` | `q` missing or empty |
| `500` | `INTERNAL_ERROR` | eBay API failure — worth surfacing "eBay unavailable, try again" |

---

## Suggested UI

### Location

New standalone page or drawer accessible from:

- Top-nav "Search" icon (🔍) → opens a "Parts Search" page
- OR a search bar always visible in the workshop app header
- OR embedded inside the workshop settings under "Tools → Parts Lookup"

### Search form

```
┌────────────────────────────────────────────────────────────────┐
│  🔍 Parts Search                                               │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│  What are you looking for?                                     │
│  [ e.g. "brake pads" or a part number                       ]  │
│                                                                │
│  Vehicle (optional — narrows the search)                       │
│  [ Year ▼ ] [ Make ▼ ]  [ Model ▼ ]                          │
│                                                                │
│  Marketplaces                                                  │
│  ☑ AU  ☑ US  ☑ UK  ☑ DE                                       │
│                                                                │
│  Price range (AUD, delivered)                                  │
│  [ min ] to [ max ]                                            │
│                                                                │
│                                          [ Search parts → ]    │
└────────────────────────────────────────────────────────────────┘
```

### Result rendering

Same shape as the booking sourcing panel — reuse whatever component you built for that:

```
┌────────────────────────────────────────────────────────────────┐
│ 🏆 A$67.95  ·  5-11 days  ·  Bendix Brake Pads Front DB1808   │
│    🇦🇺 EBAY_AU · bendixbrakes_au (99.6%)  [ View on eBay → ]   │
│                                                                │
│    A$74.20  ·  8-15 days  ·  Ryco Brake Pads RDB1808           │
│    🇦🇺 EBAY_AU · rycofilters (100%)                            │
│                                                                │
│    A$62.30  ·  21-28 days  ·  ATE Brake Pads Front (Genuine)   │
│    🇩🇪 EBAY_DE · autoteile-preiswert (98.2%)  ⚠ 3+ weeks       │
│                                                                │
│    A$81.50  ·  ETA unknown  ·  Wagner ThermoQuiet Front Pads   │
│    🇺🇸 EBAY_US · brakesetc (99.1%)                             │
└────────────────────────────────────────────────────────────────┘
```

### Row rules

- **Winner (top row):** 🏆 badge, bold, coloured background
- **Marketplace flag icon** — 🇦🇺 🇺🇸 🇬🇧 🇩🇪
- **Slow-shipping warning:** if `deliveryMaxDays > 21`, add a `⚠ 3+ weeks` badge (workshops rarely wait that long)
- **Poor-seller warning:** if `seller.feedbackPct < 95`, colour it red
- **ETA unknown row:** italic, muted — "ETA unknown"
- **Click a row:** opens `productUrl` in a new tab

### Sort / filter controls

- **Default sort:** by `totalAud` ascending (as returned)
- **Alt sort:** "Fastest first" — sort by `deliveryMaxDays` ascending, nulls last
- **Alt sort:** "Cheapest item (excl. shipping)" — sort by `priceAud` ascending
- **Filter chips:** condition (New/Used), marketplace, seller feedback (>= 95%)

All client-side over the returned array.

### "Add to a booking" flow (nice-to-have)

Each result row could have a small dropdown: `[ + Add to booking ▼ ]`. Opens a mini-picker of the manager's active bookings, then POSTs to `/bookings/{id}/parts-orders` with Shape B (free-form) — instant "buy" from an ad-hoc search. Rough shape of what to send:

```jsonc
POST /bookings/{id}/parts-orders
{
  "partNameId":       354,               // manager picks from part_names catalogue
  "supplier":         "ebay",
  "marketplace":      "EBAY_AU",
  "itemTitle":        result.title,
  "priceNative":      result.priceNative,
  "currency":         result.currency,
  "shippingNative":   result.shippingNative,
  "totalAud":         result.totalAud,
  "externalOrderUrl": result.productUrl,
  "expectedDelivery": today+deliveryMaxDays,
  "quantity":         1
}
```

This ties the ad-hoc search back into the buy/track flow if the manager decides to order.

---

## Example queries the workshop will actually run

- `q=oil filter&year=2020&make=Toyota&model=Corolla`
- `q=NGK IFR6J11 spark plugs&limit=20`   *(OEM part number search)*
- `q=brake rotors Mazda CX-5 front`
- `q=timing belt kit Golf MK7&markets=EBAY_DE`   *(German OEM parts)*
- `q=205/60R16 tyre&year=2015&make=Mazda&maxAud=200`

All return in ~1-3 seconds warmed (4 marketplaces in parallel), ~4-5 seconds cold.

---

## Rate limit note

eBay's Browse API allows 5,000 calls/day. Each search fires up to 4 marketplace calls (one per marketplace in the filter). At 100 workshop searches/day that's 400 API calls — well under limit. If we ever build customer-facing search, that changes.

## Not addressed here

- **Persistence** — this endpoint doesn't save anything. If you want to preserve a lookup for a later booking, use the "Add to a booking" flow (which POSTs to the persistent `parts-orders` endpoint).
- **Compare to Burson/Repco** — those integrations don't exist yet. When they do, they'll surface in the same result shape via the same endpoint.
- **Historical price tracking** — no snapshot history. eBay prices move; each call is a fresh look.
