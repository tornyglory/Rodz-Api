# Vehicle Recommendations — Frontend Brief

**Base URL:** `https://fzzrkscwd7.execute-api.ap-southeast-2.amazonaws.com`

All requests require `Authorization: Bearer <accessToken>`.

---

## GET /customers/{customerId}/vehicles/{vehicleId}/recommendations

Returns the AI-generated maintenance schedule for a vehicle, ordered by km ascending. Designed to be displayed as a "Maintenance" tab on the vehicle detail screen.

### Request

```
GET /customers/6/vehicles/8/recommendations
Authorization: Bearer <accessToken>
```

No body or query parameters.

### Response `200`

```json
{
  "recommendations": [
    {
      "id": 14,
      "title": "Oil & Filter Change",
      "body": "Your M15A engine needs clean oil to protect its variable valve timing system. Dirty oil causes VVT sludge build-up leading to rough idle and expensive head work. This engine is also known to use a little oil between services — check the dipstick monthly. Use 5W-30 semi-synthetic.",
      "urgency": "recommended",
      "status": "active",
      "triggeredAtOdometer": 45000,
      "triggeredAtDate": "2026-06-16",
      "estimatedDueOdometer": 60000,
      "estimatedDueDate": null,
      "estimatedCostMin": 120,
      "estimatedCostMax": 180,
      "sentAt": null,
      "acknowledgedAt": null,
      "dismissedAt": null,
      "completedAt": null,
      "completedByJobId": null,
      "createdAt": "2026-06-16T01:55:00.000Z"
    },
    {
      "id": 15,
      "title": "Tyre Rotation",
      "body": "Rotating tyres every 10,000 km evens out wear across all four corners, extending tyre life significantly. Australian heat accelerates uneven wear — skipping rotations can halve tyre lifespan and compromise wet weather handling.",
      "urgency": "advisory",
      "status": "active",
      "triggeredAtOdometer": 45000,
      "triggeredAtDate": "2026-06-16",
      "estimatedDueOdometer": 60000,
      "estimatedDueDate": null,
      "estimatedCostMin": 40,
      "estimatedCostMax": 70,
      "sentAt": null,
      "acknowledgedAt": null,
      "dismissedAt": null,
      "completedAt": null,
      "completedByJobId": null,
      "createdAt": "2026-06-16T01:55:00.000Z"
    }
  ]
}
```

### Error responses

| Status | When |
|--------|------|
| `404` | Vehicle not found, doesn't belong to this customer, or belongs to a different store |
| `401` | Missing or invalid token |
| `200` with empty array | Vehicle exists but no recommendations generated yet |

---

## Field reference

| Field | Type | Description |
|-------|------|-------------|
| `id` | number | Recommendation ID |
| `title` | string | Short service name — use as the card heading |
| `body` | string | Educational explanation written by AI — the main card content |
| `urgency` | string | `advisory` \| `recommended` \| `important` \| `urgent` |
| `status` | string | `active` \| `sent` \| `acknowledged` \| `dismissed` \| `completed` \| `expired` |
| `triggeredAtOdometer` | number \| null | Odometer when this recommendation was generated |
| `estimatedDueOdometer` | number \| null | Km when this service is due — null for age-based items |
| `estimatedDueDate` | string \| null | Date-based due date in `YYYY-MM-DD` — usually null |
| `estimatedCostMin` | number \| null | Lower AUD cost estimate |
| `estimatedCostMax` | number \| null | Upper AUD cost estimate |
| `sentAt` | string \| null | ISO timestamp — set when the reminder email was sent |
| `completedAt` | string \| null | ISO timestamp — set when marked done |
| `completedByJobId` | number \| null | Links to the job that completed this service |

---

## Suggested UI

### Tab layout
Add a **"Maintenance"** tab alongside the existing vehicle tabs. Show a badge with the count of `urgent` + `important` items to draw attention.

### Urgency colours
| Value | Suggested colour |
|-------|-----------------|
| `urgent` | Red |
| `important` | Orange |
| `recommended` | Blue |
| `advisory` | Green |

### Card layout
Each recommendation renders as a card:

```
┌─────────────────────────────────────────────┐
│ [RECOMMENDED]              Due at 60,000 km │
│                                             │
│ Oil & Filter Change                         │
│                                             │
│ Your M15A engine needs clean oil to protect │
│ its variable valve timing system. Dirty oil │
│ causes VVT sludge build-up leading to rough │
│ idle and expensive head work...             │
│                                             │
│ Est. cost: $120 – $180                      │
└─────────────────────────────────────────────┘
```

### Ordering & filtering
- Results are already ordered by `estimatedDueOdometer` ascending — render them in the order returned
- Age-based items (null `estimatedDueOdometer`) appear at the end
- Hide `dismissed` and `expired` status items by default
- `completed` items can be shown in a collapsed "Done" section at the bottom

### Empty state
If the array is empty, show: *"Maintenance schedule is being generated — check back shortly."* (The AI engine runs async after booking and takes ~30 seconds.)

### Distance to due
If the vehicle has a current odometer reading, show how far away each service is:

```js
const kmToGo = rec.estimatedDueOdometer - vehicle.odometerCurrent
// "3,200 km to go" or "Overdue by 800 km"
```
