# Customer unlock — workshop app frontend brief

Staff-side rescue when a customer has hit the 5-strike login lockout on their app. One button clears the counter + lockout so they can try again with their existing password. Backend deployed.

## Endpoint

```
POST /customers/{id}/unlock
Authorization: Bearer <staff_jwt>
```

No request body needed. `{id}` is the customer id from the customer list / profile.

**Response — success:**
```json
{ "id": 42, "unlocked": true }
```

**Response — customer has no auth row (e.g. magic-link-only signup):**
```json
{ "id": 42, "unlocked": false, "reason": "no_auth_row" }
```
Still `200` — nothing to unlock. Show a "this customer doesn't have a password set" hint in the UI.

**Errors:**
| Code | When |
|---|---|
| `403 FORBIDDEN` | Caller is a technician. |
| `404 NOT_FOUND` | No customer with that id. |
| `422 VALIDATION_ERROR` | Missing / zero id. |

## Where in the workshop UI

The natural home is the customer profile / detail drawer, alongside other admin actions (change tier, delete, etc.). Two placements to consider:

1. **Always visible** in a "Security" card — shows the current lockout state ("Locked until 09:15") when active and dims out to a small "Unlock" button when clear. Requires a `GET` for the state (see below).
2. **Contextual toast** — when a customer calls in about being locked out, staff open the profile and see a red banner "Account locked · 4 failed login attempts. [Unlock]". Only appears when locked.

Either works. Option 2 is lighter and hides the button until needed.

## How to tell if a customer is currently locked

There's no dedicated `GET /customers/{id}/auth-state` yet. Two options:

- **Cheapest**: don't show any state, always allow clicking Unlock. Idempotent — safe even when the customer isn't locked (returns `unlocked: true` because the UPDATE still touches the row).
- **Better UX**: add `failed_login_attempts` and `locked_until` to the existing `GET /customers/{id}` response. Small backend change; say the word and I'll wire it.

## Frontend flow

```ts
async function unlockCustomer(customerId: number) {
  const res = await api.post(`/customers/${customerId}/unlock`)
  if (res.unlocked) {
    toast.success(`Unlocked. Ask ${customer.firstName} to try logging in again.`)
  } else if (res.reason === 'no_auth_row') {
    toast.info(`${customer.firstName} hasn't set a password on their account.`)
  }
}
```

That's the whole client-side integration.

## Audit trail

Every unlock writes a row to `customer_auth_log` with `event_type = 'account_unlocked'` and `metadata = { unlocked_by_staff_id, role }`. Support can trace who unlocked whom, and when.

## Role guard

- **`super_admin`** — can unlock anyone.
- **`store_manager`** — can unlock anyone (customers aren't store-scoped).
- **`technician`** — `403 FORBIDDEN`. Show the button only for the two allowed roles, or let the API return the guard.

## What this doesn't do

- **Doesn't rotate the customer's password.** Most lockouts are fat-finger, not forgotten passwords — the customer knows their password fine, they just want to try again. If they've *actually* forgotten it, direct them to the "Forgot password" flow in the customer app (email reset).
- **Doesn't send a notification.** No push, no email. The customer likely already knows because they're on the phone.

## Testing checklist

- [ ] Locked customer → click Unlock → success toast, customer can log in on their next attempt.
- [ ] Already-unlocked customer → click Unlock anyway → same success response (idempotent).
- [ ] Customer with no password (magic-link signup) → `unlocked: false, reason: no_auth_row`, softer toast.
- [ ] Log in as a technician → button hidden OR API returns 403.
- [ ] `customer_auth_log` shows one `account_unlocked` row per click, with the acting staff id in metadata.
