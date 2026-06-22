# Vehicle Digital Logbook — Frontend Brief

**Base URL:** `https://fzzrkscwd7.execute-api.ap-southeast-2.amazonaws.com`

All three logbook endpoints are **public** — no `Authorization` header required.

---

## Overview

The Digital Logbook gives customers a shareable URL showing their vehicle's full service history and AI-generated vehicle profile. The flow:

1. Staff opens a vehicle in the portal and generates a logbook token (idempotent — safe to call every time)
2. A shareable link is constructed: `https://<your-frontend>/logbook/<token>`
3. The public logbook page makes two parallel fetches — service history + vehicle profile — no auth needed

---

## Staff endpoint (requires auth)

---

### POST /vehicles/{rego}/logbook-token

Generates a logbook token for the vehicle, or returns the existing one. Safe to call on every page load — always returns the same token once set.

**Requires:** `Authorization: Bearer <accessToken>`

```
POST /vehicles/HAPPYD/logbook-token
Authorization: Bearer <accessToken>
```

**Response `200`**

```json
{
  "token": "551b525887d00f7d81b15ae350e8b4454d91f31b055556ce0e80c22c76e2a33b"
}
```

Construct the shareable URL as `https://<your-frontend>/logbook/<token>` and show it with a copy button and/or QR code.

| Status | Code | When |
|--------|------|------|
| `404` | `NOT_FOUND` | Vehicle not found or inactive |

---

## Public endpoints (no auth)

---

### GET /logbook/{token}

Returns the vehicle header and paginated service history.

```
GET /logbook/551b525887d00f7d81b15ae350e8b4454d91f31b055556ce0e80c22c76e2a33b
```

#### Pagination

Sorted by odometer descending, then service date descending. Default page size 25, max 100.

| Param | Type | Notes |
|-------|------|-------|
| `limit` | number | Records per page. Default `25`, max `100`. |
| `beforeOdometer` | number | Cursor — pass `nextCursor` from the previous response. |

**Response `200`**

```json
{
  "vehicle": {
    "rego": "HAPPYD",
    "label": "2026 Porsche 911",
    "odometerCurrent": null
  },
  "lifetimeTotal": 2103.20,
  "history": [
    {
      "invoiceId": 3,
      "invoiceNumber": "INV-2606-001",
      "invoiceUrl": "https://workshop.rodz.com.au/invoice/93bf8765986ce661058f1de95ff04242447b59040e16e5cd9d1abeaf8a97f0de",
      "serviceDate": "2026-06-18",
      "odometer": 92000,
      "store": "Frankston",
      "tech": "N. Rodda",
      "total": 2103.20,
      "status": "sent",
      "aiSummary": "Your 2026 Porsche 911 received a service today at Frankston, where we fitted four new tyres and precisely balanced all your wheels to ensure a smooth and enjoyable drive. A thorough test was also conducted as part of the service, and we've documented everything with 7 photos for your records.",
      "items": [
        { "description": "Tyre", "type": "part", "qty": 4, "unitPrice": 200 },
        { "description": "Wheel Balance (per wheel)", "type": "labour", "qty": 4, "unitPrice": 28 },
        { "description": "test", "type": "other", "qty": 2, "unitPrice": 500 }
      ],
      "photos": [
        {
          "id": 42,
          "imageId": "f72abd6a-1507-44b8-ba5a-42537eedb400",
          "caption": null,
          "urls": {
            "thumbnail": "https://imagedelivery.net/_T7yYgco6vMbVyuhQfz9eg/f72abd6a-1507-44b8-ba5a-42537eedb400/thumbnail",
            "public": "https://imagedelivery.net/_T7yYgco6vMbVyuhQfz9eg/f72abd6a-1507-44b8-ba5a-42537eedb400/public"
          }
        }
      ]
    }
  ],
  "hasMore": false,
  "nextCursor": null
}
```

| Status | Code | When |
|--------|------|------|
| `404` | `NOT_FOUND` | Token not found or vehicle inactive |

#### Field reference

**`vehicle`**

| Field | Type | Notes |
|-------|------|-------|
| `rego` | string | Registration plate |
| `label` | string \| null | `"YYYY Make Model"` |
| `odometerCurrent` | number \| null | Latest recorded odometer |

**`history[]`**

| Field | Type | Notes |
|-------|------|-------|
| `invoiceId` | number | |
| `invoiceNumber` | string | e.g. `"INV-2606-001"` |
| `invoiceUrl` | string \| null | Deep link to customer invoice page |
| `serviceDate` | string | `YYYY-MM-DD` |
| `odometer` | number \| null | Odometer at time of service |
| `store` | string \| null | Store name |
| `tech` | string \| null | Technician name |
| `total` | number | Invoice total inc. GST |
| `status` | string | `sent` \| `paid` |
| `aiSummary` | string \| null | AI-generated plain-English service summary |
| `items` | array | Line items |
| `photos` | array | All photos attached to the invoice |

**`history[].items[]`**

| Field | Type | Notes |
|-------|------|-------|
| `description` | string | |
| `type` | string | `part` \| `labour` \| `other` |
| `qty` | number | |
| `unitPrice` | number | Retail price — safe to show to customer |

**`history[].photos[]`**

| Field | Type | Notes |
|-------|------|-------|
| `id` | number | |
| `imageId` | string | Cloudflare image ID |
| `caption` | string \| null | |
| `urls.thumbnail` | string | Small preview — use in grid/list |
| `urls.public` | string | Full-size — use in lightbox |

**Pagination**

| Field | Type | Notes |
|-------|------|-------|
| `lifetimeTotal` | number | Sum of all sent/paid invoices for this vehicle |
| `hasMore` | boolean | `true` if another page exists |
| `nextCursor` | number \| null | Pass as `?beforeOdometer=<value>` to load the next page |

---

### GET /logbook/{token}/profile

Returns the AI-generated vehicle model profile. **No auth required.**

```
GET /logbook/551b525887d00f7d81b15ae350e8b4454d91f31b055556ce0e80c22c76e2a33b/profile
```

If no profile has been generated for this vehicle yet, returns `404` — hide the Profile tab or show a "not available" state. Do not poll; profile generation happens asynchronously via the staff portal.

**Response `200`**

```json
{
  "status": "ready",
  "make": "Porsche",
  "model": "911",
  "year": 2026,
  "generatedAt": "2026-06-17T05:52:35.000Z",
  "overview": "This is a high-performance, precision-engineered German sports car. Expect advanced electronics, tight tolerances, and a need for specialist tools and diagnostic equipment (Porsche PIWIS). Reliability is generally excellent when maintained correctly, but components are expensive and require specific, often meticulous, procedures.",
  "engineSpecs": {
    "oilType": "0W-40 full synthetic, Porsche A40 approved",
    "oilCapacityL": 9,
    "coolantType": "Porsche long-life (pink/purple), G40 equivalent – do not mix with other types",
    "transmissionFluid": "Porsche PDK specific fluid (sealed unit, no dipstick)",
    "brakeFluid": "DOT 4 LV (Low Viscosity)",
    "powerSteeringFluid": null,
    "sparkPlugType": "OEM specific iridium (e.g., Bosch/NGK)",
    "sparkPlugIntervalKm": 60000,
    "timingDrive": "chain",
    "timingBeltIntervalKm": null
  },
  "tyreSpecs": {
    "front": { "size": "245/35R20", "pressureCold": "240 kPa / 35 psi" },
    "rear":  { "size": "305/30R21", "pressureCold": "270 kPa / 39 psi" },
    "spare": "inflation kit / no spare"
  },
  "serviceNotes": [
    "Requires Porsche PIWIS diagnostic tool for most electronic system interactions, resets, and calibration.",
    "Specific jacking points must be used to avoid damage to chassis or sensitive aero panels."
  ],
  "knownIssues": [
    {
      "title": "PDK Shift Hesitation/Roughness",
      "severity": "medium",
      "description": "Can occur with hard use or high mileage. Check fluid level/condition, look for software updates, or potential clutch pack wear."
    },
    {
      "title": "Infotainment System Glitches",
      "severity": "low",
      "description": "Random screen freezes, Apple CarPlay/Android Auto dropouts. Check for available software updates from Porsche."
    }
  ],
  "commonRepairs": [
    { "name": "Brake Pad & Rotor Replacement (Full Set)", "intervalKm": null, "typicalCostAud": 5000 },
    { "name": "Major Service (incl. Spark Plugs/Filters)", "intervalKm": 60000, "typicalCostAud": 1800 },
    { "name": "PDK Fluid & Filter Service", "intervalKm": 120000, "typicalCostAud": 1200 }
  ]
}
```

| Status | Code | When |
|--------|------|------|
| `404` | `NOT_FOUND` | Token invalid, vehicle inactive, or no profile generated yet |

#### Field reference

| Field | Type | Notes |
|-------|------|-------|
| `status` | string | Always `"ready"` on a 200 response |
| `make` / `model` / `year` | string / string / number | Vehicle identity |
| `generatedAt` | string | ISO-8601 UTC — show as "last updated" if desired |
| `overview` | string | 2–4 sentence plain-English vehicle summary |
| `engineSpecs` | object | See below |
| `tyreSpecs` | object | See below |
| `serviceNotes` | string[] | Workshop tips — render as a bulleted list |
| `knownIssues` | object[] | See below |
| `commonRepairs` | object[] | See below |

**`engineSpecs`**

| Field | Type | Notes |
|-------|------|-------|
| `oilType` | string \| null | |
| `oilCapacityL` | number \| null | Litres |
| `coolantType` | string \| null | |
| `transmissionFluid` | string \| null | |
| `brakeFluid` | string \| null | |
| `powerSteeringFluid` | string \| null | `null` if EPS / not applicable |
| `sparkPlugType` | string \| null | |
| `sparkPlugIntervalKm` | number \| null | |
| `timingDrive` | string \| null | `"chain"` \| `"belt"` \| `"gear"` |
| `timingBeltIntervalKm` | number \| null | `null` if chain or not applicable |

**`tyreSpecs`**

| Field | Type | Notes |
|-------|------|-------|
| `front.size` | string | e.g. `"245/35R20"` |
| `front.pressureCold` | string | e.g. `"240 kPa / 35 psi"` |
| `rear.size` | string | |
| `rear.pressureCold` | string | |
| `spare` | string \| null | Description e.g. `"inflation kit / no spare"` |

**`knownIssues[]`**

| Field | Type | Notes |
|-------|------|-------|
| `title` | string | Short issue name |
| `description` | string | Plain-English detail |
| `severity` | string | `"low"` \| `"medium"` \| `"high"` — use for badge colour |

**`commonRepairs[]`**

| Field | Type | Notes |
|-------|------|-------|
| `name` | string | Repair name |
| `intervalKm` | number \| null | Service interval — `null` if condition-based |
| `typicalCostAud` | number \| null | Indicative cost in AUD |

---

## Frontend implementation guide

### Staff portal — sharing the logbook

```
POST /vehicles/{rego}/logbook-token
→ { token }
→ shareable URL = https://<frontend>/logbook/<token>
→ show copy button + optional QR code
```

Token is permanent once created — safe to call on every vehicle page load.

### Public logbook page (`/logbook/:token`)

On load, fire both requests in parallel:

```
GET /logbook/{token}          → service history + vehicle header
GET /logbook/{token}/profile  → AI vehicle profile (404 = hide tab)
```

**Suggested layout:**

- **Header** — vehicle label, rego, current odometer, lifetime spend (`lifetimeTotal`)
- **Tabs** — "Service History" | "Vehicle Profile" (hide Profile tab on 404)

**Service History tab:**
- One card per visit — date, odometer, store, tech
- `aiSummary` displayed prominently (if present)
- Line items collapsible
- Photos in a grid using `urls.thumbnail`; open full-size (`urls.public`) in a lightbox
- "View Invoice" link if `invoiceUrl` is set

**Vehicle Profile tab:**
- Overview paragraph
- Engine specs table
- Tyre specs (front/rear sizes + pressures, spare note)
- Known issues with severity badges (`low` = yellow, `medium` = orange, `high` = red)
- Common repairs with interval and typical cost
- Service notes as a bulleted list

### Infinite scroll / load more

```
GET /logbook/{token}                               // first page
→ if hasMore, show "Load more"
→ GET /logbook/{token}?beforeOdometer={nextCursor} // next page
→ append to list
```
