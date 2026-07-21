# Public logbook — swap the mods request

Fix for the "Couldn't load modifications — Request failed (401)" on `/logbook/:token`. Root cause: the page is calling the customer-authed endpoint. Backend already ships a public equivalent — just swap the request.

## The swap

**Wrong (what's happening now on the public page):**
```
GET /c/vehicles/{id}/modifications
Authorization: Bearer <customerJwt>
```
Fails with `401` because the anonymous visitor doesn't have a customer JWT.

**Right:**
```
GET /logbook/{token}/modifications
```
No auth header. `{token}` is the logbook token already in the URL.

## What to change

- Route the public logbook screen's mods request to `/logbook/${token}/modifications`.
- Strip the `Authorization` header on this request only. Every other public logbook request (`/vehicle`, `/expenses`, `/recommendations`) already runs without one — mirror that.
- No id lookup needed. The endpoint resolves the vehicle from the token.

## Response

Same shape as the customer endpoint minus receipt-kind media (photos still included; receipt scans stay private). `receiptCount` and `totalReceiptSpend` are still returned for the trust banner.

Full contract + testing checklist: `docs/logbook-tier-and-modifications-frontend-brief.md`.

## While you're in there

Same page still renders **"Silver Member"** on a Gold account. Fix by reading the new `tier` field on the `/logbook/{token}/vehicle` response instead of switching on `isPremium`:

```ts
const badge =
  vehicle.tier === 'gold'   ? 'Gold Member'   :
  vehicle.tier === 'silver' ? 'Silver Member' :
  null
```

## Details tab

The logged-in Details tab does its own fetch of `/c/vehicles/{id}/modifications` — mods aren't embedded on the vehicle GET. Once the public page has the array from `/logbook/{token}/modifications`, render a preview slice on Details from the same array. No new endpoint needed.

## Test

- [ ] Load `/logbook/{token}` on vehicle 4 (`HUT665`) → badge says "Gold Member", Mods tab loads the Milltek cat-back.
- [ ] Network tab: only one modifications request, going to `/logbook/{token}/modifications`, no `Authorization` header, `200`.
- [ ] Details tab shows a preview of the same mods list.
