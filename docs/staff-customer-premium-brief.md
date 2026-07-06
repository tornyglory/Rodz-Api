# Staff Portal — Customer Premium Toggle

A single UI control on the customer profile page that lets staff manually grant or revoke Rodz Premium access for any customer.

---

## Context

Premium is currently gated by an `is_premium` flag on the customer record. Staff set this manually — there's no Stripe integration yet. This is the primary (and only) way to upgrade customers until the self-serve subscription flow is built.

---

## Where it lives

**Customer detail page / profile drawer** — wherever the customer's contact info, notes, and vehicle list already appear. Add a "Premium" section or row alongside the existing customer fields.

---

## API

### Toggle premium status

```
PATCH /customers/{id}/premium
Authorization: Bearer <staff JWT>
Content-Type: application/json

{ "isPremium": true }   // or false to revoke
```

**Response — 200**
```json
{ "id": 42, "isPremium": true }
```

**Auth:** Staff only. Technicians receive `403 Forbidden` — hide the control from technician role users entirely.

---

## UI

### Premium status display

Show a badge on the customer profile indicating current status:

- **Premium** — gold/amber badge: `★ Premium`
- **Free** — no badge, or a subtle grey label: `Free plan`

### Toggle control

A simple toggle or button — not a dropdown, not a modal. Premium status should be a single tap/click with a confirmation step only on revoke.

**Grant premium:**
- Button: `Upgrade to Premium` (or toggle switch)
- No confirmation required — granting is low-risk
- On success: badge updates to `★ Premium`, show a brief toast: *"Customer upgraded to Premium"*

**Revoke premium:**
- Button or toggle off: `Remove Premium`
- Show a small confirmation: *"Remove Premium access for [Customer Name]? They will immediately lose access to premium features."*
- Confirm → call API → badge reverts to `Free`, toast: *"Premium access removed"*

### Error states

- API error → toast: *"Failed to update — please try again"*
- `403` (technician trying to use it) → this should not appear; hide the control for technician role

---

## TypeScript

```ts
interface CustomerPremiumStatus {
  isPremium: boolean
}

async function setCustomerPremium(customerId: number, isPremium: boolean): Promise<void> {
  const res = await api.patch(`/customers/${customerId}/premium`, { isPremium })
  if (!res.ok) throw new Error('Failed to update premium status')
}
```

---

## Roles & visibility

| Role | Can see badge | Can toggle |
|------|--------------|-----------|
| `super_admin` | Yes | Yes |
| `store_manager` | Yes | Yes |
| `technician` | Yes (read-only) | No — hide the button |

---

## What premium unlocks (for staff awareness)

When a customer is marked Premium, they gain access to in the Rodz customer app:

- Expense tracker (scan receipts, fuel logs, annual cost reports)
- External invoice import into logbook
- Fuel & EV price intelligence
- CSV tax export

Staff don't need to explain this in detail — if a customer asks why they can't access a feature, staff can check the profile and toggle it on.

---

## Notes

- The flag takes effect immediately — no cache delay, no webhook
- Revoking premium does not delete any of the customer's expense or logbook data; it just blocks further access to those endpoints
- When Stripe self-serve is eventually built, the `is_premium` flag will be set automatically by the Stripe webhook — this manual toggle becomes an override/admin tool for comping customers, fixing payment issues, etc.
