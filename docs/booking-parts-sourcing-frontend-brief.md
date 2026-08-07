# Booking Parts Sourcing Panel — Frontend Brief

New "Parts Sourcing" panel on the booking detail page. Given a booking,
the workshop can trigger a live search across eBay AU / US / UK / DE
for every part the service will consume, ranked by delivered-to-AU
price and shipping speed. Foundation for the JIT ordering flow.

Backend deployed 2026-08-07. Two endpoints on the admin API
(`https://lukck5txvh.execute-api.ap-southeast-2.amazonaws.com`).

---

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/bookings/{id}/parts-sourcing` | Read the latest persisted snapshot |
| `POST` | `/bookings/{id}/parts-sourcing/refresh` | Re-run the pipeline (fresh prices) |

Store-scoped: any staff role can read + refresh for bookings at their store; super_admin sees any. Currently no auto-trigger on booking confirm — staff clicks "Refresh" to source. Auto-trigger is a v2 follow-up.

Base URL:
```
https://lukck5txvh.execute-api.ap-southeast-2.amazonaws.com
```

All requests: `Authorization: Bearer <staff_jwt>`.

---

## What the pipeline does

For a given booking:

1. **Aggregates parts** — every service on the booking → every step → every part_name attached to the step. Deduplicates so "Engine Oil" from two services collapses to one entry.
2. **Merges vehicle-specific specs** — if the vehicle has active AI recommendations that mention any of these parts, lifts the `spec` field (e.g. "5W-30 full synthetic, ~4.2L") to enrich the eBay search query.
3. **Composes a search query per part** — `{part name} {spec hint} {year} {make} {model}`.
4. **Fires eBay searches in parallel** — across AU + US + UK + DE marketplaces, 3 parts concurrent to avoid burst-limiting.
5. **Ranks + stores top 10 offerings per part** by delivered-to-AU cost (all prices converted to AUD).

Rough timing: ~1.5s per part warmed, up to 4s cold. A typical 4-part booking sources in about 6-10 seconds.

---

## Response shape

Both endpoints return the same `snapshot` object. `POST` also includes the raw pipeline result (`refreshed: true`, `parts`, `queriesCreated`, `offeringsCreated`, `errors[]`).

```jsonc
{
  "snapshot": {
    "bookingId":      108,
    "partCount":      4,
    "hasResults":     true,
    "lastQueriedAt":  "2026-08-07T00:36:16.000Z",
    "parts": [
      {
        "queryId":          17,
        "partNameId":       385,
        "partName":         "Engine Oil",
        "category":         "Fluid",
        "serviceTypeId":    1,
        "serviceName":      "General Oil Service (…)",
        "specHint":         "5W-30 full synthetic, ~4.2L",
        "searchQuery":      "Engine Oil 5W-30 full synthetic, ~4.2L 2020 Toyota Corolla",
        "status":           "completed",              // "pending" | "completed" | "failed"
        "error":            null,
        "resultsCount":     10,
        "cheapestTotalAud": 42.50,
        "fastestDaysMax":   7,                        // max ETA (days) of the fastest option
        "queriedAt":        "2026-08-07T00:36:14.000Z",
        "completedAt":      "2026-08-07T00:36:15.000Z",
        "offerings": [
          {
            "id":                17421,
            "supplier":          "ebay",
            "marketplace":       "EBAY_AU",
            "externalId":        "144149354486",
            "title":             "Castrol Magnatec 5W-30 Full Synthetic Engine Oil 5L",
            "priceNative":       42.50,
            "currency":          "AUD",
            "shippingNative":    0.00,
            "fxRate":            1.0000,
            "priceAud":          42.50,
            "shippingAud":       0.00,
            "totalAud":          42.50,
            "deliveryMinDays":   3,
            "deliveryMaxDays":   7,
            "condition":         "New",
            "sellerName":        "castrolshop_au",
            "sellerFeedbackPct": 99.5,
            "productUrl":        "https://www.ebay.com.au/itm/…",
            "imageUrl":          "https://i.ebayimg.com/…",
            "location":          "AU",
            "capturedAt":        "2026-08-07T00:36:15.000Z"
          }
          // …up to 10 offerings, sorted by totalAud ascending
        ]
      }
      // …one entry per unique part on the booking's services
    ]
  }
}
```

### `POST` extras

```jsonc
{
  "refreshed":        true,
  "bookingId":        108,
  "vehicleId":        4,
  "vehicleLabel":     "2020 Toyota Corolla",
  "parts":            4,
  "queriesCreated":   4,
  "offeringsCreated": 40,
  "errors":           [],
  "snapshot":         { /* same shape as GET response above */ }
}
```

Errors:
- `403 FORBIDDEN` — not staff, or store guard failed
- `404 NOT_FOUND` — booking doesn't exist / not in your store
- `500 INTERNAL_ERROR` — sourcing failed catastrophically (partial per-part failures are captured in `errors[]` on the response, not the HTTP status)

---

## Suggested UI

### Panel placement

Bottom of the booking detail drawer (or a dedicated tab). Only visible for `confirmed` bookings — no point sourcing a pending booking that may get cancelled.

### Empty state (`snapshot.hasResults === false`)

```
┌──────────────────────────────────────────────────────────┐
│ 🔧 Parts Sourcing                                        │
│                                                          │
│ No prices yet. Click below to check eBay AU / US / UK / │
│ DE for the parts this booking will need.                 │
│                                                          │
│                              [ Get parts prices → ]     │
└──────────────────────────────────────────────────────────┘
```

Button POSTs to `.../refresh`. Show a spinner + "Searching…" for ~5-10s.

### Loaded state (per part)

```
┌──────────────────────────────────────────────────────────────────┐
│ 🔧 Parts Sourcing        Last checked 2 min ago  [ ↻ Refresh ]  │
│                                                                  │
│ Engine Oil [Fluid]                                               │
│ 5W-30 full synthetic, ~4.2L                                      │
│ Search: "Engine Oil 5W-30 full synthetic ~4.2L 2020 Toyota Corolla"                                    │
│                                                                  │
│ 🏆 A$42.50  ·  3-7 days  ·  Castrol Magnatec 5W-30 5L            │
│    AU · castrolshop_au (99.5%)                          [ View ] │
│                                                                  │
│    A$48.20  ·  8-12 days  ·  Penrite Enviro+ 5W-30 5L            │
│    AU · penriteoils_com_au (100%)                       [ View ] │
│                                                                  │
│    A$62.80  ·  14-21 days  ·  Mobil 1 ESP 5W-30 4L (US)          │
│    US · lubricantworld_us (98.2%)                       [ View ] │
│                                                                  │
│    [ Show 7 more options ▼ ]                                     │
└──────────────────────────────────────────────────────────────────┘
```

### Sort / filter

- Default sort: by `totalAud` ascending (cheapest delivered first — the array already comes in this order).
- Alt sort: by `deliveryMaxDays` ascending — "fastest arrival". Frontend re-sorts client-side.
- Optional filter: "must arrive by {booking.date}" — hide offerings where `deliveryMaxDays > days_until_booking`. Very useful for close-in bookings.

### Row rendering rules

- **Winner (top row)** — 🏆 badge, bold, coloured background. This is the current cheapest.
- **`condition` badge** — `[New]`, `[Used]`, `[Refurbished]` — colour-coded (green/yellow/blue).
- **`sellerFeedbackPct`** — show as `(99.5%)` next to seller name. If below 95%, colour red.
- **Marketplace flag icon** — 🇦🇺 🇺🇸 🇬🇧 🇩🇪 based on `marketplace`.
- **ETA** — `deliveryMinDays`-`deliveryMaxDays` days. If `null`, show "ETA unknown" (mostly cross-border DE listings).
- **[ View ]** button — opens `productUrl` in a new tab.

### Refresh button

- Always visible in the panel header.
- Shows "Last checked N min ago" derived from `lastQueriedAt`.
- Click → POST refresh → replace panel content with fresh snapshot when done.
- Disable during in-flight request, spinner icon.

---

## Not addressed here (later phases)

- **Auto-trigger on booking confirmation** — booking flips to `confirmed` → async-invoke sourcing so the panel is warm when the workshop opens the drawer. Adds a Lambda self-invoke or SNS/SQS trigger; not blocking.
- **"Order this" button** — currently every offering shows a "View" link to the seller's eBay page. Placing an actual order via eBay's Buy API is a whole separate integration (needs eBay Buy API access + user consent + purchase confirmation flow). Frontend link + manual order is the interim.
- **Item detail expansion** — clicking a row could hit `getItemDetail(itemId, marketplace)` to show all shipping options (express, standard, expedited) with per-option ETA and cost. Backend function exists (`src/shared/ebay.ts::getItemDetail`), just not exposed on this endpoint yet.
- **Alternative suppliers (Burson, Repco)** — schema already supports multi-supplier via `part_sourcing_offerings.supplier` enum. When those integrations land, offerings from all suppliers appear in the same ranked list.
- **Price history / trend** — snapshots are wiped and replaced on every refresh. If you want "prices dropped 15% this week", we'd add a rollup table.

---

## Deployment notes

- `POST /refresh` calls the eBay API up to `4 marketplaces × N parts` times, capped at 3 concurrent parts. A 4-part booking → ~1-2s per part warmed, ~4-6s cold.
- Hard timeout is 29s (API Gateway max is 30s). Deep-part services (12+ parts) may hit this; upgrade to async self-invoke if it becomes a problem.
- Rate limit on eBay Browse API is 5,000 calls/day. At ~5 parts per booking × 4 marketplaces = 20 calls per refresh, we can refresh 250 bookings/day. Well above realistic workshop volume.
