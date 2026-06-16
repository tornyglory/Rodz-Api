# Get Vehicle — Frontend Brief

**Base URL:** `https://fzzrkscwd7.execute-api.ap-southeast-2.amazonaws.com`

All requests require `Authorization: Bearer <accessToken>`.

---

## GET /customers/{customerId}/vehicles/{vehicleId}

Returns the full record for a single vehicle belonging to a customer.

**Access:** All roles. Store managers and technicians are scoped to their own store — a vehicle from another store returns 404.

### Request

```
GET /customers/42/vehicles/7
Authorization: Bearer <accessToken>
```

No request body or query parameters.

### Response `200`

```json
{
  "vehicle": {
    "id": 7,
    "rego": "ABC123",
    "regoState": "VIC",
    "regoExpiry": "2025-11-30",
    "vin": null,
    "make": "Suzuki",
    "model": "Swift",
    "series": "EZ",
    "year": 2008,
    "colour": "Silver",
    "bodyType": "hatch",
    "fuelType": "petrol",
    "transmission": "automatic",
    "driveType": "fwd",
    "engineCode": "M15A",
    "engineSizeCC": 1490,
    "cylinders": 4,
    "tyreSizeFront": "185/60R15",
    "tyreSizeRear": "185/60R15",
    "spareTyreSize": "T115/70R15",
    "odometerUnit": "km",
    "odometerCurrent": 86000,
    "odometerAtPurchase": null,
    "serviceIntervalKm": 10000,
    "serviceIntervalMonths": 6,
    "nextServiceDueKm": null,
    "nextServiceDueDate": null,
    "fleetUnitNumber": null,
    "internalNotes": null
  }
}
```

### Error responses

| Status | Code | When |
|--------|------|------|
| `404` | — | Vehicle not found, doesn't belong to this customer, or belongs to a different store |
| `401` | — | Missing or invalid token |

### Notes

- `regoExpiry`, `nextServiceDueDate` are returned as `YYYY-MM-DD` strings or `null`
- `bodyType` is one of: `sedan` `hatch` `wagon` `ute` `van` `suv` `coupe` `convertible` `truck` `other`
- `fuelType` is one of: `petrol` `diesel` `hybrid` `electric` `lpg` `other`
- `transmission` is one of: `manual` `automatic` `cvt` `dct` `other`
- `driveType` is one of: `fwd` `rwd` `awd` `4wd` or `null`
- Nullable fields return `null` rather than being omitted
