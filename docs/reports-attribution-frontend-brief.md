# Reports — attribution / geo / device — frontend brief

Marketing + operations report. Aggregates guest-form bookings by any
of 7 dimensions (channel, campaign, geography, device) with confirmed
vs. rejected splits and a conversion rate. Powers the "which channels
actually convert" question.

Live now — no schema or infra work outstanding.

---

## Endpoint

```
GET https://lukck5txvh.execute-api.ap-southeast-2.amazonaws.com/reports/attribution
```

Same base URL the workshop app uses for the admin catalog. Same
staff JWT auth. `technician` role is rejected with 403; `store_manager`
and `super_admin` both work.

---

## Query params

All optional.

| Param | Values | Default | Notes |
|-------|--------|---------|-------|
| `from` | `YYYY-MM-DD` | 1st of current month | Inclusive lower bound on `booking_date` |
| `to`   | `YYYY-MM-DD` | Today | Inclusive upper bound |
| `groupBy` | `source \| medium \| campaign \| country \| city \| region \| device` | `source` | Dimension to aggregate on |

Errors:
- `400 BAD_REQUEST` — bad date format, `from > to`, or unknown `groupBy`
- `403 FORBIDDEN` — technician role

---

## Response shape

```jsonc
{
  "from":    "2026-07-01",
  "to":      "2026-07-31",
  "groupBy": "source",

  "totals": {
    "bookings":       54,
    "confirmed":      21,
    "rejected":       10,
    "pending":        23,
    "conversionRate": 0.6774    // confirmed / (confirmed + rejected), null when both are 0
  },

  "breakdown": [
    { "key": "facebook", "bookings": 20, "confirmed": 18, "rejected":  1, "pending":  1, "conversionRate": 0.9474 },
    { "key": "google",   "bookings": 15, "confirmed": 12, "rejected":  2, "pending":  1, "conversionRate": 0.8571 },
    { "key": null,       "bookings": 12, "confirmed":  9, "rejected":  2, "pending":  1, "conversionRate": 0.8182 }
  ]
}
```

Sort: `bookings DESC, key ASC` — biggest bucket first.

### Field semantics

- **`bookings`** — total in the group, EXCLUDING soft-deleted rows (`cancelled_at IS NULL`).
- **`confirmed`** — status in `confirmed | in_progress | completed`. Staff accepted the booking.
- **`rejected`** — status in `cancelled | rejected | no_show`. Staff declined or the customer didn't show.
- **`pending`** — status = `pending`. Staff hasn't decided yet.
- **`conversionRate`** — `confirmed / (confirmed + rejected)`. Deliberately excludes pending — reflects staff decisions, not the full funnel. `null` when both are 0.
- **`key`** — the value of the group dimension. `null` means "no data captured for this dimension" (walk-ins, phone, staff-created rows, or geo fields before the CF worker is live).

### If you want the raw funnel rate

That's `confirmed / bookings` — trivial to compute client-side. `conversionRate` here is the more marketing-honest number (what percent of decided bookings turned into work).

---

## The 7 groupBy dimensions

### `source`
`utm_source` — where the customer came from. Lowercased on write, so `Facebook` / `facebook` don't split. Common values: `facebook`, `google`, `tiktok`, `linkedin`, `direct` (when tagged), or `null` (no UTM).

### `medium`
`utm_medium` — the traffic type. Common: `paid_social`, `cpc`, `email`, `organic`, `referral`. Also lowercased.

### `campaign`
`utm_campaign` — the specific campaign / ad set. Case preserved (`Somerville-Summer-2026` won't collapse into `somerville-summer-2026`). Best paired with a source / medium filter mentally when reading — the same campaign name across `source=facebook` and `source=google` will pool.

### `country` / `city` / `region`
Cloudflare geo. **Sparse today** — populates only for bookings submitted after the Cloudflare worker fronts the API. Until then, every booking's country is `null`. Show the dimension in the UI regardless — it becomes useful automatically.

### `device`
`submission_context.device.type` — `mobile`, `tablet`, `desktop-like` (null / undefined for old browsers). Works today via server-side `ua-parser-js`; independent of the CF worker.

---

## Suggested UX

### Overview card (top of the reports view)

Use `totals` — one big line summing across all dimensions:

```
Jul 2026: 54 bookings — 21 confirmed, 10 rejected, 23 pending — 68% conversion (of decided)
```

### Channel breakdown chart

`groupBy=source` → bar chart, sort by `bookings` DESC. Colour by conversion rate — high converters green, low red. `null` bucket rendered as "Direct / untagged" — that's your baseline.

### Campaign leaderboard

`groupBy=campaign` → table with columns: Campaign, Bookings, Confirmed, Rejection %, Conversion %. Sort default by Bookings DESC, staff can re-sort by Conversion. Small tooltip on the label showing the source + medium context (fetch a separate `groupBy=source` filtered to `?campaign=<x>` if you want the pair — or accept that the campaign name alone is usually enough context).

### Geo pins (once CF worker is live)

`groupBy=city` → simple table. Later, map view keyed on the lat/lng in each booking's `submissionContext`.

### Device split

`groupBy=device` → pie chart. Immediately tells you what proportion of guest bookings come from mobile.

### Date range picker

Presets: "Last 7 days", "Last 30 days", "This month", "Last month", "This year". Compute the from/to client-side and pass. No server-side preset helper — server just takes ISO dates.

---

## Common queries the workshop app should surface

```bash
# "Which channels are converting best this month?"
GET /reports/attribution?groupBy=source

# "How is our Facebook campaign performing?"
GET /reports/attribution?groupBy=campaign
# ...then filter client-side to campaigns that likely came from FB
# (proper filter param would be a follow-up backend feature)

# "Mobile vs desktop conversion rate"
GET /reports/attribution?groupBy=device

# "Are people from Victoria more likely to book?"
# (once CF worker is live)
GET /reports/attribution?groupBy=region
```

---

## Not in scope (backlog)

- **Filter by dimension** — e.g. `?utmSource=facebook&groupBy=campaign` to see all Facebook campaigns. Ask if this becomes a real workflow.
- **Time-bucketed series** — e.g. weekly breakdown of Facebook conversion across a quarter. Would need a new endpoint or a `?bucket=day|week|month` param.
- **Cross-tab** — e.g. source × device to see if mobile-Facebook converts differently to desktop-Facebook. Nested breakdown, roughly `?groupBy=source,device`. Doable, ask if useful.

Related briefs:
- [`workshop-booking-drawer-context-frontend-brief.md`](./workshop-booking-drawer-context-frontend-brief.md) — the same attribution + submissionContext data at the per-booking level
- [`service-slugs.md`](./service-slugs.md) — service codes marketing uses in campaigns
