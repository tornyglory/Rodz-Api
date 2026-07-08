# Public Vehicle Recommendations — Frontend Brief

The public sanitised mirror of `GET /c/vehicles/:id/recommendations` is now **live** at `GET /logbook/:token/recommendations`. The frontend is already largely wired — this doc is the API reference so you can verify the integration and know exactly what fields to expect.

---

## Endpoint

```
GET /logbook/:token/recommendations
```

Base URL: `https://fzzrkscwd7.execute-api.ap-southeast-2.amazonaws.com`

**No auth.** The token is the sole access control (same model as the other `/logbook/:token/*` routes).

---

## Response — 200

```json
{
  "recommendations": [
    {
      "id":                    51,
      "title":                 "Oil & Filter Change",
      "body":                  "Your engine needs clean oil to protect internal components...",
      "urgency":               "recommended",
      "status":                "active",
      "triggeredAtOdometer":   45000,
      "triggeredAtDate":       "2026-07-01",
      "estimatedDueOdometer":  60000,
      "estimatedDueDate":      null,
      "estimatedCostMin":      120,
      "estimatedCostMax":      180,
      "completedAt":           null
    }
  ]
}
```

Ordering: `estimated_due_odometer ASC` (age-based items without a km trigger sort to the end), then `id ASC`. Dismissed and expired items are filtered server-side.

---

## Fields that are OMITTED vs. the customer endpoint

The public response **does not include** these four fields (they leak owner engagement or internal identifiers):

| Field | Why removed |
|-------|-------------|
| `sentAt` | Reveals when the customer was emailed |
| `acknowledgedAt` | Reveals customer engagement pattern |
| `completedByJobId` | Internal workshop job id |
| `createdAt` | Not needed for display; leaks generation timestamp |

`completedAt` is kept so you can still render the "Completed" bucket in date order.

### Type note

The existing `Recommendation` type in `src/api/customer.ts` declares all these fields as present. In the public response they'll be `undefined`. Two ways to handle:

**Option A (least churn)**: keep the current `Recommendation` type — TypeScript will treat the missing keys as `undefined` at runtime. The component only reads the shared fields anyway, so no behaviour changes.

**Option B (stricter typing)**: split into `Recommendation` (customer) and `PublicRecommendation` (public), where the public one omits the four fields. Then narrow the type based on mode in `VehicleProfileMaintenanceTab`.

Option A is fine for v1. Option B is worth doing later if you want the compiler to catch accidental reads of `sentAt` in public-only paths.

---

## Errors

| Status | Code | When | UI |
|--------|------|------|----|
| `403` | `RECOMMENDATIONS_HIDDEN` | Owner has set `publicProfileSettings.history = false` on their vehicle | Hide the Maintenance tab from the public profile (mirrors History tab behaviour) |
| `404` | `NOT_FOUND` | Token invalid / revoked | Falls back to empty state (existing handling) |
| `410` | `GONE` | Vehicle has been soft-deleted | Falls back to empty state |

Existing component behaviour (from `VehicleProfileMaintenanceTab.vue:80-89`) already collapses both 403 and 404 into the empty state, which is correct behaviour — a hidden schedule looks the same as no schedule to the visitor.

---

## What's already wired

Grepping the frontend repo confirms:

- `src/api/vehicles.ts:223` — `vehiclesApi.logbookRecommendations(token)` returns `{ recommendations: Recommendation[] }`
- `src/components/ui/VehicleProfileMaintenanceTab.vue:77` — the component picks between customer + public mode based on which prop was passed (`vehicleId` vs. `token`)
- Error handling — 403 and 404 both fall to the empty state, not the error state

So there is **no new frontend code required** for this endpoint to start working end-to-end. Ship a build and the tab will start returning real data on public profiles that have `history` visible.

---

## Visibility flag interaction

The frontend already reads `publicSettings` from `GET /logbook/:token/vehicle` and hides tabs based on it (see `docs/public-profile-visibility-frontend-brief.md`). Recommend the Maintenance tab follow the same rule the History tab already uses:

```ts
const tabs = computed(() => [
  { key: 'specs',    label: 'Specs'   },  // always
  s.history && { key: 'history',      label: 'History'     },
  s.photos  && { key: 'photos',       label: 'Photos'      },
  s.history && { key: 'maintenance',  label: 'Maintenance' },  // gate on history
  s.chat    && { key: 'chat',         label: 'Ask AI'      },
].filter(Boolean))
```

Rationale: maintenance items reference `completedAt` and cost estimates, which are effectively part of the service history story. Backend enforces the same rule via `403 RECOMMENDATIONS_HIDDEN`.

---

## Testing checklist

- [ ] Vehicle with default visibility → Maintenance tab renders with the recommendation list on the public profile
- [ ] Owner toggles history off → Maintenance tab disappears; direct API call returns `403 RECOMMENDATIONS_HIDDEN`
- [ ] Vehicle without any recommendations yet → tab renders empty state (not an error)
- [ ] Vehicle with items in `completed` status → those show in the "Completed" bucket with the completion date
- [ ] Filter chips + search work the same in public mode as customer mode (same component)
- [ ] No owner PII in the DevTools network response (no `sentAt`, no `completedByJobId`, etc.)
