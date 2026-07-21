# Public logbook — tier badge + modifications tab wiring

Two fixes for the anonymous vehicle profile page (`/logbook/:token` or `/vehicle/:token`). Backend is deployed.

## What changed

### 1. Membership tier now on the vehicle response

`GET /logbook/{token}/vehicle` now includes a `tier` field on the top-level response.

```jsonc
{
  "rego": "HUT665",
  // …
  "isPremium": true,               // unchanged — derived boolean
  "tier": "gold",                  // NEW — 'free' | 'silver' | 'gold'
  "publicSettings": { "history": true, "photos": true, "chat": true, "maintenance": true, "modifications": true }
}
```

### 2. Public modifications endpoint

Brand new endpoint. No auth. Serves the mods that the owner has toggled public on a vehicle whose profile has modifications enabled.

```
GET https://fzzrkscwd7.execute-api.ap-southeast-2.amazonaws.com/logbook/{token}/modifications
```

**Response shape:**
```jsonc
{
  "modifications": [
    {
      "id":                 2,
      "vehicleId":          4,
      "category":           "exhaust",
      "name":               "Milltek cat-back",
      "brand":              "Milltek",
      "description":        "…",
      "installedAt":        "2026-05-14",
      "installedBy":        "APEX Automotive",
      "costAud":            3200,
      "status":             "installed",           // 'installed' | 'removed' | 'planned'
      "removedAt":          null,
      "keptWithSale":       true,
      "isPublic":           true,                  // always true on this endpoint
      "coverImageId":       "abc-123",
      "coverUrl":           "https://imagedelivery.net/…/public",
      "coverThumbUrl":      "https://imagedelivery.net/…/thumbnail",
      "createdAt":          "2026-05-14T…",
      "updatedAt":          "2026-05-14T…",
      "media": [
        {
          "id":            41,
          "kind":          "photo",                // photos only — receipts are stripped
          "imageId":       "def-456",
          "imageUrl":      "https://imagedelivery.net/…/public",
          "imageThumbUrl": "https://imagedelivery.net/…/thumbnail",
          "caption":       null,
          "sortOrder":     0,
          "amountAud":     null,
          "supplier":      null,
          "purchasedAt":   null,
          "expenseEventId": null,
          "createdAt":     "2026-05-14T…"
        }
      ],
      "receiptCount":       3,                     // aggregate — no receipt rows exposed
      "totalReceiptSpend":  4180                   // sum over receipts, for the trust banner
    }
  ]
}
```

**Response codes:**
| Code | Meaning |
|---|---|
| `200 { modifications: [] }` | Vehicle exists but has no visible mods (either the vehicle-level toggle is off, no mods are `isPublic: true`, or none exist). |
| `404` | Bad `token`. |
| `410` | Vehicle exists but is inactive. |

Both gates that produce an empty list are collapsed into `200 []` — the tab treats "no mods to show" the same regardless of why.

### Why receipts aren't in `media`

Receipts stay private. But the aggregate signals (`receiptCount`, `totalReceiptSpend`) are still returned so the "$X in aftermarket parts, receipts attached" resale banner from the mods brief still works.

---

## Frontend changes

### Bug 1 — Silver badge on a Gold account

Where you currently do:

```ts
const badge = vehicle.isPremium ? 'Silver Member' : null
```

Read the `tier` field instead:

```ts
const badge =
  vehicle.tier === 'gold'   ? 'Gold Member'   :
  vehicle.tier === 'silver' ? 'Silver Member' :
  null
```

Keep the `isPremium` fallback for one release if you're worried about older backend deploys, but the field is live now:

```ts
const badge =
  vehicle.tier === 'gold'      ? 'Gold Member'
: vehicle.tier === 'silver'    ? 'Silver Member'
: vehicle.isPremium            ? 'Silver Member'   // safety net; can remove later
:                                null
```

### Bug 2 — Modifications tab

Two gates on the tab visibility:

```ts
const showModsTab =
  vehicle.publicSettings.modifications !== false   // owner has it on
  && modifications.length > 0                      // there's at least one public mod
```

**Data fetch:**

```ts
async function loadPublicMods(token: string): Promise<Modification[]> {
  const res = await fetch(`${API_BASE}/logbook/${token}/modifications`)
  if (!res.ok) return []          // 404/410 → hide the tab
  const { modifications } = await res.json()
  return modifications
}
```

No auth header. Fire it in parallel with the other logbook fetches — same lifecycle as `/logbook/{token}/vehicle` and `/logbook/{token}/expenses`.

**Rendering:** same card shape as the owner's own mods tab (`customer-modifications-frontend-brief.md`), minus:
- No edit / delete controls (anonymous visitor).
- Media lightbox only cycles photos (`media[]` already contains just photos).
- Show `totalReceiptSpend` inline as "$4,180 in receipts" text but no click-through to receipts.

**Aggregate banner** (same idea as the owner view — "trust-building for resale conversations"):

```ts
const totalInvested = modifications
  .map(m => (m.costAud ?? 0) + (m.totalReceiptSpend ?? 0))
  .reduce((a, b) => a + b, 0)
```

Render at the top of the tab as "$18,400 invested in aftermarket parts, receipts attached" when > 0.

---

## Testing checklist

- [ ] Load `/logbook/{token}` on a Gold-tier account → badge reads "Gold Member".
- [ ] Load same on a Silver account → "Silver Member".
- [ ] Load on a Free account → no badge (existing behaviour, `tier: 'free'` now sent).
- [ ] Owner toggles Modifications OFF in settings → refresh public page → Modifications tab hidden.
- [ ] Owner toggles Modifications ON, has 1 mod with `isPublic: true` → tab visible with that mod.
- [ ] Owner toggles Modifications ON, no mods exist → tab hidden (empty list, don't show empty tab).
- [ ] Owner toggles Modifications ON, all mods are `isPublic: false` → tab hidden.
- [ ] Mod has both photos and receipts attached → tab shows photos; `receiptCount` and `totalReceiptSpend` reflect the receipts but no receipt rows appear in `media[]`.
- [ ] Vehicle 4 (`HUT665`, Nev's Corolla) → tab appears with the Milltek cat-back, and badge shows "Gold Member".

---

## Endpoints touched, quick reference

| Method + Path | Change |
|---|---|
| `GET /logbook/{token}/vehicle` | Response gains `tier: 'free' \| 'silver' \| 'gold'` |
| `GET /logbook/{token}/modifications` | **NEW** — no auth, honors both public-profile gates |
