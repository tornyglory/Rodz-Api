# Vehicle Profile — Frontend Brief

**Base URL:** `https://fzzrkscwd7.execute-api.ap-southeast-2.amazonaws.com`

All requests require `Authorization: Bearer <accessToken>`.

---

## Overview

Every vehicle in the system has an AI-generated reference profile covering engine specs, fluid types, tyre pressures, known issues, and common repairs for that make/model/year. Profiles are generated automatically — no staff action required.

**When it's generated:** On the customer's first booking (either via the public booking form or the staff portal). If a booking was already made before this feature existed, the profile generates on the first time a staff member opens the profile tab.

**Shared across vehicles:** All vehicles of the same make/model/year share one profile. If you have five 2019 Toyota Corollas, the profile is generated once and reused for all five.

---

## GET /customers/{customerId}/vehicles/{vehicleId}/profile

```
GET /customers/12/vehicles/34/profile
Authorization: Bearer <accessToken>
```

### Response `200` — profile ready

```json
{
  "status": "ready",
  "make": "Toyota",
  "model": "Corolla",
  "year": 2019,
  "generatedAt": "2026-06-17T12:00:00.000Z",
  "overview": "The ZRE182R Corolla is a reliable, low-maintenance vehicle well suited to high-km fleet use. The 2ZR-FAE engine uses Toyota's Valvematic variable valve lift system which requires clean oil to operate correctly. Generally trouble-free but sensitive to oil service intervals.",
  "engineSpecs": {
    "oilType": "0W-20 full synthetic",
    "oilCapacityL": 4.2,
    "coolantType": "Toyota Super Long Life Coolant (pink/red) — do not mix with green",
    "transmissionFluid": "Toyota ATF WS (sealed unit, no dipstick)",
    "brakeFluid": "DOT 3",
    "powerSteeringFluid": null,
    "sparkPlugType": "NGK ILZKR7B11",
    "sparkPlugIntervalKm": 100000,
    "timingDrive": "chain",
    "timingBeltIntervalKm": null
  },
  "tyreSpecs": {
    "front": { "size": "195/65R15", "pressureCold": "230 kPa / 33 psi" },
    "rear":  { "size": "195/65R15", "pressureCold": "230 kPa / 33 psi" },
    "spare": "space saver"
  },
  "serviceNotes": [
    "The Valvematic system is sensitive to dirty oil — emphasise oil change intervals to the customer",
    "Drain plug is aluminium thread into aluminium sump — 40 Nm max, use a new washer each time",
    "Timing chain requires no scheduled replacement but noisy start-up on cold engine can indicate wear"
  ],
  "knownIssues": [
    {
      "title": "Valvematic carbon build-up",
      "description": "Direct injection models can accumulate carbon on intake valves. Symptoms: rough idle, hesitation on acceleration.",
      "severity": "medium"
    },
    {
      "title": "CVT shudder",
      "description": "CVT variants may exhibit shudder at low speed. Usually resolved by ATF flush with Toyota WS fluid.",
      "severity": "low"
    }
  ],
  "commonRepairs": [
    { "name": "Oil & filter service",     "intervalKm": 10000, "typicalCostAud": 120 },
    { "name": "Brake fluid flush",        "intervalKm": 40000, "typicalCostAud": 95  },
    { "name": "Spark plug replacement",   "intervalKm": 100000, "typicalCostAud": 180 },
    { "name": "Coolant flush",            "intervalKm": 160000, "typicalCostAud": 150 },
    { "name": "CVT fluid flush",          "intervalKm": 80000, "typicalCostAud": 220 }
  ]
}
```

### Response `202` — profile is being generated

Returned on the first call for a vehicle that has no profile yet. The engine has been triggered — poll again in a few seconds.

```json
{
  "status": "generating"
}
```

### Error responses

| Status | When |
|--------|------|
| `404` | Vehicle not found or doesn't belong to this customer |
| `403` | Staff member doesn't have access to this store |

---

## Field reference

### `engineSpecs`

| Field | Type | Notes |
|-------|------|-------|
| `oilType` | string | Full spec including viscosity grade |
| `oilCapacityL` | number | With filter |
| `coolantType` | string | Includes mixing warnings where relevant |
| `transmissionFluid` | string \| null | null for manual without a service interval |
| `brakeFluid` | string | DOT rating |
| `powerSteeringFluid` | string \| null | null for EPS (electric) systems |
| `sparkPlugType` | string \| null | OEM part number or equivalent |
| `sparkPlugIntervalKm` | number \| null | |
| `timingDrive` | `"chain"` \| `"belt"` \| `"gear"` | |
| `timingBeltIntervalKm` | number \| null | null when chain or gear drive |

### `tyreSpecs`

`front` and `rear` each have `size` and `pressureCold` (shown in both kPa and psi). `spare` is a string describing the spare type.

### `knownIssues`

| Field | Type |
|-------|------|
| `title` | string |
| `description` | string — max 120 chars |
| `severity` | `"low"` \| `"medium"` \| `"high"` |

### `commonRepairs`

| Field | Type |
|-------|------|
| `name` | string |
| `intervalKm` | number \| null |
| `typicalCostAud` | number |

---

## Suggested UI

### Tab placement

Add a **"Vehicle Info"** tab on the vehicle detail screen (alongside service history, recommendations, etc.). Always render the tab — use the `status` field to decide what to show inside it.

### Loading state (`status: "generating"`)

Show a subtle loading indicator:

```
┌─────────────────────────────────────────────┐
│  Generating vehicle profile...              │
│  This usually takes under 30 seconds.       │
└─────────────────────────────────────────────┘
```

Poll `GET .../profile` every 5 seconds until `status` is `"ready"`. Stop polling after 2 minutes and show a retry button.

### Ready state layout

```
┌─────────────────────────────────────────────┐
│ 2019 Toyota Corolla                         │
│ The ZRE182R Corolla is a reliable...        │
├──────────────┬──────────────────────────────┤
│ ENGINE       │ OIL                          │
│              │ 0W-20 full synthetic · 4.2 L │
│              │ COOLANT                      │
│              │ Toyota SLLC (pink/red)       │
│              │ TIMING                       │
│              │ Chain — no replacement       │
│              │ SPARK PLUGS                  │
│              │ NGK ILZKR7B11 · 100,000 km   │
├──────────────┴──────────────────────────────┤
│ TYRES                                       │
│ 195/65R15 · F 230 kPa / R 230 kPa          │
│ Spare: space saver                          │
├─────────────────────────────────────────────┤
│ SERVICE NOTES                               │
│ • Valvematic sensitive to dirty oil         │
│ • Drain plug aluminium — 40 Nm max         │
│ • Timing chain — no scheduled replacement  │
├─────────────────────────────────────────────┤
│ KNOWN ISSUES                               │
│ ⚠ Valvematic carbon build-up  [medium]    │
│ ⚠ CVT shudder                 [low]       │
├─────────────────────────────────────────────┤
│ COMMON REPAIRS                              │
│ Oil & filter service    10,000 km   ~$120  │
│ Spark plug replacement 100,000 km   ~$180  │
│ Coolant flush          160,000 km   ~$150  │
└─────────────────────────────────────────────┘
```

Colour-code severity badges: `low` → grey, `medium` → amber, `high` → red.

---

## Permissions

| Action | Minimum role |
|--------|-------------|
| View profile | Any authenticated staff |
