# Workshop app — surfacing booking attribution + submission context

Two new nested objects landed on every booking row returned by the
existing `GET /bookings` endpoint. This brief covers what they look
like and how to render them on the booking drawer.

No new endpoint — same list call the workshop app already uses.

---

## Base URL

Unchanged — same shared HttpApi the workshop app already hits:

```
https://fzzrkscwd7.execute-api.ap-southeast-2.amazonaws.com
```

Endpoint: `GET /bookings` (existing, staff-authed).

---

## What changed in the response

Each booking row on the response now includes **two additional
optional objects** at the top level:

```jsonc
{
  "id": 60,
  "bookingRef": "AR34HHPA",
  "customer": "Karen Walsh",
  // … all existing fields unchanged …

  // NEW ↓
  "attribution":       { … } | null,
  "submissionContext": { … } | null
}
```

Both are **`null`** for bookings that didn't come through the guest
form — walk-ins, phone bookings, staff-created rows. Frontend renders
nothing for those.

---

## `attribution` — where the booking came from

Populated when any UTM param or referer was on the URL when the
customer submitted.

```jsonc
"attribution": {
  "source":     "facebook",             // lowercased server-side
  "medium":     "paid_social",          // lowercased server-side
  "campaign":   "somerville-summer",    // case preserved
  "refererUrl": "https://rodz.com.au/services/logbook"
}
```

Any subfield can be `null` on its own (customer arrived with
partial UTM tagging). Only the top-level `attribution` object is
`null` when ALL four subfields would be null.

### Suggested render

```
Came from: Facebook (paid social) — campaign: somerville-summer
```

Pattern:
- Capitalise `source` for display (`facebook` → `Facebook`, `google` → `Google`).
- `medium` → replace underscores with spaces (`paid_social` → `paid social`).
- `campaign` render as-is.
- Show `refererUrl` as a subtle tooltip / secondary line if you want detail.

Fall back gracefully — e.g. only `source` present → `Came from: Facebook`.

### List-view filter

The list endpoint doesn't currently support `?utmSource=` filtering —
that's on the backlog. For now, filter client-side after fetching a
page. If marketing needs it soon, ask backend to add.

---

## `submissionContext` — device / network snapshot

Captured at submit time. Powers the "booked from iPhone Safari in
Melbourne" line, plus fraud triage (same IP hitting the form 50
times, etc.).

```jsonc
"submissionContext": {
  "ip":            "118.92.70.209",
  "submittedAt":   "2026-07-31T09:12:34.000Z",

  "userAgent":     "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 …",
  "browser":       { "name": "Safari",  "version": "17.5" },
  "os":            { "name": "iOS",     "version": "17.5" },
  "device":        { "vendor": "Apple", "model": "iPhone", "type": "mobile" },

  "language":      "en-AU",
  "timezone":      "Australia/Melbourne",
  "screen":        { "width": 390, "height": 844, "dpr": 3 },
  "viewport":      { "width": 390, "height": 760 },

  "referrer":      "https://www.google.com/",
  "pageUrl":       "https://workshop.rodz.com.au/book?utm_source=google",

  "country":       "AU",             // ← null until Cloudflare worker fronts the API
  "city":          "Melbourne",       // ← null "
  "region":        "Victoria",        // ← null "
  "regionCode":    "VIC",             // ← null "
  "postalCode":    "3199",            // ← null "
  "edgeTimezone":  "Australia/Melbourne", // ← null "
  "latitude":      "-38.148",         // ← null "
  "longitude":     "145.122"          // ← null "
}
```

- `ip`, `submittedAt`, `userAgent`, `browser`, `os`, `device` — always populated when `submissionContext` is present.
- Client-collected (`language`, `timezone`, `screen`, `viewport`, `referrer`, `pageUrl`) — depend on the frontend having collected them. Fine to render as "unknown" when null.
- Cloudflare geo fields — **all `null` today.** Populate automatically once the `rodz-ssr` Cloudflare worker fronts the API. Frontend should just check-and-skip.

### Suggested renders

**Compact one-liner on the booking-drawer header:**
```
📱 iPhone (Safari 17.5) · en-AU · 118.92.70.209
```

Pattern:
- `📱` for `device.type === 'mobile'`, `💻` for null / 'desktop', `📟` for `'tablet'`.
- `{device.model}` if present, else `{os.name}`.
- `({browser.name} {browser.version})` — omit if browser missing.
- `language` as-is.
- `ip` last, small text or tooltip.

**Expanded "Booking context" section (drawer collapsible):**

```
Came from     Facebook (paid social) — somerville-summer
              via https://www.google.com/
              on https://workshop.rodz.com.au/book?utm_source=google

Device        iPhone · iOS 17.5
Browser       Safari 17.5
Language      en-AU
Timezone      Australia/Melbourne
Viewport      390 × 760 · DPR 3

Location      Melbourne, VIC, AU · 3199   ← only when Cloudflare fields present
Coord         -38.148, 145.122            ← only when Cloudflare fields present

IP            118.92.70.209
Submitted     31 Jul 2026, 09:12 UTC
```

Bury behind an accordion / collapsible — staff will only look at this
when a booking is weird (looks like spam, wrong store, duplicate
customer flag, etc.).

---

## Filtering + reporting

`GET /bookings` already supports the following filters (existing +
recent additions):

- `?page=1&limit=50` (max 200)
- `?store=<name>` or `?store=all`
- `?status=<enum>` — all 7 workflow states
- `?date=YYYY-MM-DD` — exact day
- `?from=YYYY-MM-DD&to=YYYY-MM-DD` — inclusive range (both optional)
- `?search=<term>` — customer name OR rego

**Not yet supported (ask if you need them):**
- Filter by `utmSource` / `utmMedium` / `utmCampaign`
- Filter by `submissionContext.country` / `city`
- Filter by `submissionContext.device.type` ("show me mobile bookings")

If a dashboard needs any of the above, flag it and backend adds
in a follow-up.

---

## Null handling — critical UX detail

**Six situations produce different null patterns:**

| Scenario | `attribution` | `submissionContext` |
|----------|---|---|
| Guest form submit with UTM + full context | populated | populated |
| Guest form submit direct (no UTM) | `null` | populated |
| Guest form submit but customer refused to send `meta.context` | populated / null | mostly-null (only `ip`, `userAgent`, `submittedAt` filled) |
| Staff created via portal | `null` | `null` |
| Phone-in booking (`booking_source = 'phone'`) | `null` | `null` |
| Walk-in | `null` | `null` |

Render pattern:
- If both are `null` → don't render any "Booking context" section.
- If only `attribution` is `null` → render just the device/context.
- If only `submissionContext` is `null` → render just the attribution.
- Both present → render both.

---

## Rollout checklist

- [ ] Update the booking-drawer type interface (or however you type
      responses) to add the two new optional objects.
- [ ] Compact one-liner on the drawer header
- [ ] Expandable "Booking context" section with the full detail
- [ ] Handle all six null combinations above
- [ ] (Optional) Show a "🎯 from Facebook / Google" chip near the
      booking-list row when `attribution.source` present — helps
      staff eyeball attribution at a glance
- [ ] Test with a real guest booking (submit via
      `workshop.rodz.com.au/book`) — verify both objects populate

---

## Related briefs

- [`guest-booking-form-frontend-brief.md`](./guest-booking-form-frontend-brief.md) — the customer-facing form that produces these two objects
- [`service-slugs.md`](./service-slugs.md) — service codes marketing uses in campaigns
