# Fuel & Charging Price Intelligence — Frontend Implementation Brief

Crowd-sourced fuel and EV charging prices surfaced to customers inside the Rodz app. Price data grows automatically as customers log fuel expenses — no separate "report a price" UI needed. This brief covers the two read endpoints for displaying prices.

**Premium feature.** Only available to customers with an active subscription.

---

## Base URL

```
https://fzzrkscwd7.execute-api.ap-southeast-2.amazonaws.com
```

All endpoints require a customer JWT:

```
Authorization: Bearer <customer_jwt>
```

---

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/c/fuel-prices` | Most recent price per station for a suburb and fuel type |
| `GET` | `/c/fuel-prices/trends` | Daily price history for a specific station |

---

## Where prices come from

Prices are contributed automatically when a customer logs a fuel or EV expense with price data. There is no manual "submit a price" flow — it happens silently in the background when expenses are saved.

A pump photo (scanned via the expense tracker) contributes prices for every fuel type visible on the board in a single shot (e.g. 91, 95, 98, and diesel from one photo).

---

## Get nearby prices

### `GET /c/fuel-prices`

Returns the most recent observed price per station for a given suburb and fuel type. Use this for a "prices near me" screen or section.

**Query parameters**

| Param | Type | Required | Default | Notes |
|-------|------|----------|---------|-------|
| `suburb` | string | Yes | — | e.g. `Frankston` |
| `state` | string | No | — | e.g. `VIC`. Include for more accurate nearby filtering. |
| `fuelType` | string | No | `unleaded_95` | See valid values below |
| `radius` | string | No | `nearby` | `local` (same suburb only) or `nearby` (same state) |

**Valid `fuelType` values**

| Value | Display label |
|-------|--------------|
| `unleaded_91` | 91 Unleaded |
| `unleaded_95` | 95 Unleaded |
| `unleaded_98` | 98 Unleaded |
| `diesel` | Diesel |
| `lpg` | LPG |
| `e10` | E10 |
| `ev_kwh` | EV Charging (per kWh) |

**Response — 200**
```json
{
  "suburb":   "Frankston",
  "fuelType": "unleaded_95",
  "radius":   "nearby",
  "asOf":     "2026-07-06T08:00:00.000Z",
  "stations": [
    {
      "stationName": "Shell Frankston",
      "suburb":      "Frankston",
      "state":       "VIC",
      "price":       1.975,
      "priceUnit":   "per_litre",
      "reportedAt":  "2026-07-05T10:30:00.000Z",
      "ageHours":    22,
      "stale":       false
    },
    {
      "stationName": "BP Frankston",
      "suburb":      "Frankston",
      "state":       "VIC",
      "price":       2.000,
      "priceUnit":   "per_litre",
      "reportedAt":  "2026-07-04T08:00:00.000Z",
      "ageHours":    48,
      "stale":       false
    }
  ]
}
```

**Response fields**

| Field | Notes |
|-------|-------|
| `stations` | Sorted cheapest first |
| `price` | The most recent observed price for this station |
| `priceUnit` | `per_litre` for fuel, `per_kwh` for EV charging |
| `ageHours` | Hours since the price was last reported |
| `stale` | `true` when `ageHours > 72`. Show a visual indicator for stale entries. |

**Errors**
- `422 VALIDATION_ERROR` — `suburb` missing or `fuelType` invalid
- `403 FORBIDDEN` — not authenticated

---

## Get price trends

### `GET /c/fuel-prices/trends`

Price history for a specific station over time. Use this when a customer taps a station card to drill in.

**Query parameters**

| Param | Type | Required | Default | Notes |
|-------|------|----------|---------|-------|
| `stationName` | string | Yes | — | Must match exactly (case-insensitive) |
| `suburb` | string | Yes | — | |
| `fuelType` | string | No | `unleaded_95` | |
| `days` | number | No | `90` | History window. Max 365. |

**Response — 200**
```json
{
  "stationName": "Shell Frankston",
  "suburb":      "Frankston",
  "fuelType":    "unleaded_95",
  "days":        90,
  "dataPoints": [
    { "date": "2026-06-14", "price": 1.899 },
    { "date": "2026-06-28", "price": 2.019 },
    { "date": "2026-07-05", "price": 1.975 }
  ],
  "avgPrice": 1.964,
  "minPrice": 1.899,
  "maxPrice": 2.019
}
```

**Response fields**

| Field | Notes |
|-------|-------|
| `dataPoints` | One entry per day data was observed, ordered oldest → newest |
| `avgPrice` | Average across the period |
| `minPrice` | Lowest observed price |
| `maxPrice` | Highest observed price |

If no data exists for the station+fuel combination, `dataPoints` will be an empty array and `avgPrice`, `minPrice`, `maxPrice` will be `null`. Show an empty state rather than an error.

**Errors**
- `422 VALIDATION_ERROR` — `stationName` or `suburb` missing, or `fuelType` invalid

---

## Suggested UI

### Prices screen / section

**Entry point:** A "Fuel Prices" tab or card on the customer home screen or vehicle screen. Pre-populate the suburb from the customer's saved suburb (from their profile) so the list loads without the customer having to type anything.

**Fuel type selector:** Tab row or segmented control at the top — 91, 95, 98, Diesel, EV. Switching tabs re-fetches immediately with the new `fuelType`.

**Station list:** Cards sorted cheapest first. Each card shows:
- Station name + suburb
- Price in large text (e.g. `$1.975/L`)
- Age indicator: "Updated 22h ago" in muted text
- Stale badge (e.g. a clock icon or "⚠ May be outdated") when `stale: true`
- Cheapest station gets a "Best price" badge or green highlight

**Empty state:** "No price data for [Suburb] yet. Prices are added automatically when Rodz customers log fuel expenses in this area."

**Suburb search:** A search field or "Change location" button. When updated, re-fetch with the new suburb.

---

### Station detail / trend screen

Tapping a station card opens a detail screen with:

**Header:** Station name, suburb, current price and age.

**Price chart:** Line chart of `dataPoints` (date on X axis, price on Y axis). Use a simple sparkline if screen space is tight. Only render the chart if `dataPoints.length >= 2` — otherwise show "Not enough history yet."

**Stats row:**
```
Min $1.899   Avg $1.964   Max $2.019
```

**Time window selector:** Chips for 30 days / 90 days / 365 days — re-fetches trends with the corresponding `days` value.

---

## Fuel type display mapping

Map `fuelType` values to user-facing labels:

```javascript
const FUEL_LABELS = {
  unleaded_91: '91',
  unleaded_95: '95',
  unleaded_98: '98',
  diesel:      'Diesel',
  lpg:         'LPG',
  e10:         'E10',
  ev_kwh:      'EV (kWh)',
}

const PRICE_UNIT_LABELS = {
  per_litre: '/L',
  per_kwh:   '/kWh',
}
```

Format prices to 3 decimal places for fuel (e.g. `$1.975/L`) and 2 decimal places for EV (e.g. `$0.45/kWh`).

---

## How prices get contributed (for context)

When a customer logs a fuel or EV expense with price data in the expense tracker, the price is automatically contributed to the crowd-sourced pool. The customer does not see this happening — it's invisible. The only feedback is that the data eventually appears in the prices screen for their area.

**From a fuel receipt:** `pricePerLitre` on the expense → 1 price row
**From a pump photo scan:** Gemini extracts all fuel types visible on the board → multiple price rows in one go
**From an EV charging receipt:** `pricePerKwh` → 1 price row with `fuel_type = 'ev_kwh'`

---

## Notes

- The `stationName` used in the trends query must match exactly what came back from the prices list — pass it through directly, don't let the user type it manually.
- Both endpoints are read-only and safe to poll. Cache the prices list for ~60 seconds to avoid hammering the API on tab switches.
- The data pool is currently small (grows with user adoption). The UI should gracefully handle lists with 0–5 stations rather than expecting dozens.
