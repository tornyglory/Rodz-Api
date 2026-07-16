# Vehicle Health Dashboard — Frontend Brief

**Endpoint:** `GET /c/vehicles/{id}/health`
**Route:** `/account/vehicles/:id/health` (suggested)
**Auth:** customer JWT
**Deployed:** yes (RodzApiStack3)

One call, one JSON blob, no client-side merging. Everything the dashboard needs is aggregated server-side from operational MySQL + summary tables. No S3 reads = fast (~200-400ms cold, <100ms warm).

---

## Response shape

```json
{
  "vehicle": {
    "id": 4,
    "rego": "HUT665",
    "label": "2026 Toyota Corolla",
    "ageYears": 0,
    "odometerKm": 85005
  },
  "verdict": {
    "tone": "alert",                          // 'good' | 'warn' | 'alert' — drives card colour
    "summary": "I've got 2 urgent items…",    // rule-based, deterministic fallback
    "aiSummary": "Alright, driver, I'm …"     // Gemini-generated, 2-3 sentences in first person. Cached 6h. May be null on Gemini failure — fall back to `summary`.
  },
  "service": {
    "lastServiceDate": "2026-06-25",
    "lastServiceOdometer": null,              // null if invoice didn't stamp odometer
    "nextServiceDueKm": null,
    "nextServiceDueDate": null,
    "kmUntilNextService": null,               // positive = km to go, negative = overdue
    "intervalKm": 10000,
    "intervalProgressPct": null,              // 0-100+, null when data missing
    "overdueKm": null,
    "overdueDays": null
  },
  "recommendations": {
    "urgent": 2,
    "important": 3,
    "recommended": 18,
    "advisory": 4,
    "total": 27,
    "top": [                                  // up to 5, ordered by urgency then due-date
      { "id": 818, "title": "Brake Fluid Flush", "urgency": "urgent",
        "estimatedDueOdometer": 240000, "estimatedDueDate": null,
        "estimatedCostMin": 100, "estimatedCostMax": 150 }
    ]
  },
  "financial": {
    "totalSpendMtd": 251.4,
    "totalSpendYtd": 323.5,
    "fuelSpendYtd": 294.5,
    "serviceSpendYtd": 0,
    "otherSpendYtd": 29,
    "costPerKm": null,                        // null when we don't have enough odometer data to compute
    "spendByCategory": [
      { "category": "fuel", "aud": 294.5 },
      { "category": "other", "aud": 29 }
    ],
    "monthlySpend": [                         // last 12 months, oldest first
      { "month": "2026-06", "aud": 72.1 },
      { "month": "2026-07", "aud": 251.4 }
    ]
  },
  "fuel": {
    "avgLitresPer100km": null,                // null until >= 2 fills with odometer + litres
    "lastFillDate": "2026-07-13",
    "lastFillLitres": 32.5,
    "lastFillPricePerL": 210.9,               // in c/L (yes, cents per litre)
    "totalFuelSpendYtd": 294.5,
    "totalLitresYtd": 144.2,
    "fillCountYtd": 4
  },
  "rego": {
    "expiryDate": null,
    "daysUntilExpiry": null,                  // negative if expired
    "status": "unknown"                       // 'current' | 'expiring_soon' (≤30 days) | 'expired' | 'unknown'
  },
  "history": {
    "totalServices": 3,
    "totalSpendAllTime": 1277.1,
    "recent": [                               // last 5 Rodz workshop services
      { "date": "2026-06-25", "workshop": "Somerville", "tech": "N. Rodda",
        "odometer": null, "cost": 231,
        "summary": "AI-written service description…",
        "invoiceNumber": "INV-2606-004" }
    ]
  }
}
```

**Nullability notes** — a lot of fields can be null when the underlying data isn't there yet (new vehicle, no service history, no rego expiry stamped, etc.). Design for gracefully-missing data with friendly empty states, not blanks.

---

## Suggested page structure

### 1. Hero card — "Rodz's read" (full width)

Tone-coloured background, big and unmissable.

**Content:**
- `vehicle.label` + `vehicle.rego` on the header.
- Big quote text: prefer `verdict.aiSummary`, fall back to `verdict.summary` if null.
- Small "at 85,005 km" line under it.
- Two CTAs:
  - Primary: **"Book me in"** — opens the chat with the top recommendation pre-filled as a message ("I'd like to book the brake fluid flush").
  - Secondary: **"Chat about this"** — opens a new chat session; the health snapshot can be injected as context via the existing `session-send` handler if desired.

**Colour scheme:**

| `verdict.tone` | Background | Accent |
|---|---|---|
| `good` | Soft teal gradient | `#3fd0d6` |
| `warn` | Warm amber | `#f59e0b` |
| `alert` | Deep red-orange | `#dc2626` |

Text stays readable against the background — use a subtle gradient / low-opacity fill rather than fully-saturated colour.

### 2. Grid below hero

Mobile: single column stack. Desktop: 2-column (Tailwind `md:grid-cols-2 lg:grid-cols-3`).

#### Card A — Next service

- Radial progress ring (Chart.js doughnut with a huge cutout %, or a dedicated gauge lib).
- Ring shows `intervalProgressPct`. Cap the visual at 110% so overdue still looks distinct.
- Centre: big number = `kmUntilNextService` (positive) or `overdueKm` (label as "km overdue").
- Sub-line: "Due at 195,000 km" or "Was due 2026-05-01".
- If both `nextServiceDueKm` and `nextServiceDueDate` are null: replace the whole card with a soft prompt:
  > "I don't have my next-service target set yet — book me in for an inspection and it'll be set automatically."

#### Card B — Recommendations

- Four pill counts across the top: `urgent 2 · important 3 · recommended 18 · advisory 4`.
- Each pill is coloured (red → amber → blue → grey) and tappable to filter.
- Below the pills: list the `top` array (up to 5). Each row: title, urgency chip, est. cost range.
- Tap a row → open detail modal or navigate to a `/vehicles/:id/recommendations/:recId` page.
- Footer link: **"See all 27 recommendations →"**.

#### Card C — This year's spend

- Two rows inside one card:
  - Top: donut chart from `financial.spendByCategory`. Legend inline (fuel / workshop / other).
  - Bottom: sparkline from `financial.monthlySpend` (last 12 months). Y-axis hidden.
- Big number: `$323.50` (YTD). Sub: `$251.40 this month`.
- If `costPerKm` present, show it as a small pill: `$0.28/km`.

#### Card D — Fuel

- Big number: `avgLitresPer100km` with "L/100km" unit. Emphasise if it's non-null.
- Small sparkline of consumption trend (would need extra endpoint data — could ship later).
- Sub-line: "Last fill: 32.5L @ $2.11/L on 13 Jul".
- If `avgLitresPer100km` is null: "Log 2+ fuel fills with odometer readings to unlock efficiency tracking."

#### Card E — Rego

- Countdown chip. Colour by `rego.status`:
  - `current` → green: "Rego current — 305 days to go".
  - `expiring_soon` → amber: "Rego expires in 18 days".
  - `expired` → red: "Rego expired 12 days ago".
  - `unknown` → grey: "Add your rego expiry to get reminders" (link to vehicle profile settings).

#### Card F — Service history

- Timeline strip: horizontal axis of dates, dots for each service.
- Below the strip: `history.recent` rendered as a compact 5-row list with date, workshop, cost, and truncated summary.
- Footer link: **"View full logbook →"** (existing `/account/vehicles/:id/logbook` page).

### 3. Optional — value estimate (not on load)

Separate card at the bottom, initially blank with a **"Refresh valuation"** button. Clicking:
1. Calls the existing chat tool `getVehicleValue` via a small dedicated endpoint OR calls the paperwork chat with an intent to value.
2. Result caches 48h client-side.
3. Card renders: mid estimate + low/high range + 2-line rationale.

This is deliberately opt-in because it triggers a Gemini web-search per call (~2-4s + cost).

---

## Interactions

- **Book from a recommendation:** clicking a recommendation row (or the hero CTA) should open the chat with a pre-filled message like `"I'd like to book the ${top.title.toLowerCase()}"`. The chat's booking agent will then run its normal service-type → date → time flow.
- **Chat about this vehicle's health:** hero secondary CTA opens a new chat session on this vehicle. Optional enhancement: pass a `?context=health` query param so `session-send` can inject the health snapshot as an initial system context.
- **Refresh:** pull-to-refresh on mobile, refresh button on desktop. Redis cache means most refreshes are cheap.

---

## Chart library

Suggest **Chart.js 4** — matches your existing bundle, works offline, easy to theme. Alternatives if you want something more animated: `visx` or `Recharts`.

For the radial progress ring specifically, Chart.js doughnut with `cutout: '80%'` works and is dependency-free. Or use `svelte`-style raw SVG paths for tighter control.

---

## Loading + error states

- **Loading:** skeletons for each card (match your existing `UiSkeleton` pattern from the Paperwork page).
- **Error:** if the endpoint fails, show a single retry card. No per-card errors — one call, one state.
- **AI summary in flight:** the `aiSummary` field is already cached server-side (6h TTL) so it's usually available on first paint. On cache-miss the endpoint waits for Gemini (~1-2s) — if you want to keep the page snappy, you could add an "async summary" mode later (return rule-based summary immediately, poll for AI). For MVP the sync flow is fine.

---

## What we're deliberately NOT showing

- **"Overall health score" (a single 0-100 number).** Discussed — invented numbers contradict the brand. The tone-coloured hero + honest individual metrics does the same job without the fake precision.
- **Tyre / brake / battery health as percentages.** We don't measure these directly. If we ever want to surface them, use "months since last work" instead of a fake percentage. Room for later expansion.
- **Real-time telemetry.** No live data feeds. Everything comes from stamped service records + customer-logged expenses + odometer readings the customer enters.
