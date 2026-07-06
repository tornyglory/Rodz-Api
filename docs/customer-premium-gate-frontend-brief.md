# Customer Portal — Premium Feature Gating

## How it works

`GET /c/me` now returns `isPremium: true | false` on the customer profile object. Read it once on login, store it in your auth/user context, and use it everywhere to show or hide premium features.

---

## The field

```json
{
  "id": 42,
  "firstName": "Sarah",
  "lastName": "Jones",
  "email": "sarah@example.com",
  "isPremium": true,
  ...
}
```

---

## What to gate

| Feature | Gate |
|---------|------|
| Expense tracker (scan receipts, list, summary, CSV export) | `isPremium` |
| External invoice import into logbook | `isPremium` |
| Fuel & EV price intelligence | `isPremium` |

Free users still get: AI chat, booking, digital logbook (Rodz jobs only).

---

## UI pattern

**Premium user** — show the feature normally.

**Free user** — replace the feature with an upsell prompt. Don't hide it entirely; let them see what they're missing.

Suggested upsell copy:
> **Unlock with Rodz Premium**
> Track every dollar your vehicle costs — fuel, servicing, rego, insurance — and get the full picture at tax time.
> *$29/year*

CTA: `Learn more` or `Get Premium` — link to wherever the upgrade flow will live (TBD when Stripe is built).

---

## Implementation

Store `isPremium` in your user context/state when you load the profile on login. No need to re-fetch per screen — it only changes when staff toggle it, and that's rare enough that a re-login picks it up.

```ts
// In your auth context / user store
const { data } = await api.get('/c/me')
setUser({
  ...data,
  isPremium: data.isPremium,
})

// In a component
if (!user.isPremium) return <PremiumUpsell />
```

---

## Notes

- The flag is set by staff via `PATCH /customers/{id}/premium` — no Stripe integration yet
- Takes effect immediately on the next profile fetch
- All premium API endpoints also enforce the gate server-side — a free user who somehow reaches the screen will get a `403`, so the UI gate is just UX, not security
