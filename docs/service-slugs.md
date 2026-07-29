# Service slugs — shared reference

Single source of truth for the service codes used across:

- **Marketing site** — landing pages, ad campaigns, deep links (`?service=<slug>`)
- **Booking form** at `workshop.rodz.com.au/book` — pre-selects step 6 from the same slug
- **Backend API** (`GET /public/service-types` returns them; `service_types.slug` column persists them)

Slugs are **stable** — set by
[`docs/migrations/service_types_public_fields.sql`](./migrations/service_types_public_fields.sql).
They won't change under marketing's feet unless we deliberately
rename, which requires a coordinated update across all three
surfaces above.

---

## Bookable services

**★ Popular** = renders as a quick-pick chip at the top of the picker.
Others appear in the searchable list below.

| Slug | Name | Popular chip? |
|---|---|---|
| `small-service` | Small Service (oil + filter + safety check) | ★ |
| `medium-service` | Medium Service (small + air + cabin filter) | ★ |
| `large-service` | Large Service / 4WD Service | ★ |
| `brake-inspection` | Brake Inspection (full) | ★ |
| `battery-test` | Battery Test & Report | ★ |
| `other` | Something else | ★ |
| `tyre-rotation` | Tyre Rotation | |
| `tyre-supply-fit` | Tyre Supply & Fit | |
| `wheel-alignment-2-wheel` | Wheel Alignment (2-wheel) | |
| `brake-fluid-flush` | Brake Fluid Flush | |
| `battery-replace` | Battery Replace | |
| `air-con-service` | Air Con Service (regas) | |
| `air-con-check` | Air Con System Check | |
| `pre-purchase-inspection` | Pre-Purchase Inspection (full) | |
| `timing-belt-service` | Timing Belt / Chain Service | |

Query the live list at any time:

```bash
curl -sS https://lukck5txvh.execute-api.ap-southeast-2.amazonaws.com/public/service-types | jq
```

---

## Hidden services (workshop-internal, NOT for marketing)

These exist in the catalog but `is_bookable = false` — they're only
used internally when staff builds a job from an existing booking.
**Don't link to them from marketing** — the picker won't recognise
the slug and won't pre-select anything.

`air-filter-replace`, `cabin-filter-replace`, `coolant-flush`,
`fuel-filter-replace`, `power-steering-fluid-replace`,
`wiper-blade-replace`, `wheel-alignment-4-wheel`, `wheel-balance`,
`brake-pad-replace`, `brake-rotor-replace`, `shock-absorber-replace`,
`suspension-inspection`, `clutch-replace`.

---

## Deep-link pattern

Marketing pages link to the booking form with the pre-select query
param:

```
https://workshop.rodz.com.au/book?service=brake-inspection
https://workshop.rodz.com.au/book?service=air-con-service
https://workshop.rodz.com.au/book?service=pre-purchase-inspection
```

Frontend matches `?service=` against the bookable slug list and
pre-selects step 6 (service picker). If the slug doesn't match a
bookable service, the picker just loads unfilled — no error.

---

## `?service=` vs `utm_*` — different axes

These are frequently conflated. They're not the same thing:

| Param | Purpose | Varies with… |
|---|---|---|
| `?service=<slug>` | Pre-select the service on the form | The landing page (fixed per page) |
| `?utm_source=<x>` | Which platform referred them (facebook, google, tiktok…) | The channel |
| `?utm_medium=<x>` | Traffic type (paid_social, cpc, email, organic…) | The channel's format |
| `?utm_campaign=<name>` | Which specific campaign / ad set / creative | Per campaign |

**Both `?service=` and `utm_*` can and should coexist on the same
URL.** Full example:

```
https://workshop.rodz.com.au/book
  ?service=brake-inspection
  &utm_source=facebook
  &utm_medium=paid_social
  &utm_campaign=somerville-brakes-jul26
```

- Backend persists `utm_source`, `utm_medium`, `utm_campaign`
  (and `referer_url`) on the booking row so reports can slice by
  channel + campaign later.
- `?service=` doesn't hit the backend — it's a purely front-end
  UX hint.

### UTM normalisation the backend applies

- `utm_source` and `utm_medium` — trimmed + **lowercased**
  (`"Facebook"` and `"facebook"` land in the same bucket).
- `utm_campaign` — trimmed but **case preserved** (campaign names
  carry meaningful capitalisation).
- `referer_url` — trimmed + capped at 500 characters.

So capitalise however the campaign spec reads — backend will
canonicalise `utm_source` / `utm_medium` for you.

---

## Common questions

### "Marketing wants to link to 'logbook service' — what slug?"

There isn't a `logbook-service` slug — the three "logbook-shaped"
services are `small-service`, `medium-service`, and `large-service`.
Recommended calls:

- **Generic "book me a logbook service" ads** → link to `?service=small-service` (customer up-sells at drop-off).
- **Landing page that lets the customer pick** → link to the form with **no** `?service=` param and let the picker guide them.
- **If marketing insists on a `logbook-service` alias**, add it as a real row in `service_types` with `is_bookable=1` and the appropriate defaults. That's a coordinated change — talk to backend before doing it.

### "How do I add a new service to the catalog?"

Two options:

1. **Via the admin catalog UI** (once the workshop app ships that
   screen) — pick "New service", fill in slug + name + description +
   popular flag, save. Slug must be lowercase kebab-case.
2. **Via a migration** for bulk / server-side additions. Follow the
   pattern in
   [`docs/migrations/service_types_public_fields.sql`](./migrations/service_types_public_fields.sql).

Marketing can start using a new slug the moment it's added.

### "How do I check what a customer's incoming UTM looked like?"

Staff booking detail (via `GET /bookings` list on the shared HttpApi)
returns an `attribution` object on each booking row:

```json
{
  "id": 59,
  "bookingRef": "VWFAT9AR",
  ...,
  "attribution": {
    "source":     "facebook",
    "medium":     "paid_social",
    "campaign":   "somerville-brakes-jul26",
    "refererUrl": "https://rodz.com.au/services/brakes"
  }
}
```

`attribution` is `null` for walk-ins, phone bookings, or anything the
staff created themselves.

---

## Related docs

- [`guest-booking-form-frontend-brief.md`](./guest-booking-form-frontend-brief.md) — the booking form's full endpoint reference
- [`public-booking-flow-frontend-brief.md`](./public-booking-flow-frontend-brief.md) — the public-side endpoints in detail
- [`migrations/service_types_public_fields.sql`](./migrations/service_types_public_fields.sql) — where the slugs are set
- [`migrations/bookings_utm_flat_columns.sql`](./migrations/bookings_utm_flat_columns.sql) — where UTM columns are set up
