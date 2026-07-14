# Customer Self-Service Tier Change — Frontend Brief

Lets a signed-in customer change their own membership tier (Free / Silver / Gold) from the Settings page. No payment gate during beta — endpoint updates the tier immediately.

**Live in production as of 2026-07-15.** No feature flag — silently additive.

---

## Base URL

```
https://fzzrkscwd7.execute-api.ap-southeast-2.amazonaws.com
```

Bearer JWT required.

---

## Endpoint — `PATCH /c/me/tier`

### Request body

```json
{ "tier": "silver" }   // "free" | "silver" | "gold"
```

### Response — 200

```json
{
  "tier":      "silver",
  "isPremium": true       // derived: tier !== 'free'
}
```

Return shape matches the two fields you'd update locally on `auth.customer`. No need to refetch `GET /c/me` — patch these two fields directly and the reactive tree does the rest.

### Errors

| Status | Body `error` | When |
|--------|--------------|------|
| 401 | `UNAUTHORIZED` | Missing / invalid JWT |
| 400 | `INVALID_TIER` | `tier` not one of `'free'` / `'silver'` / `'gold'` |

---

## Cache behaviour

Two backend caches invalidate on every PATCH:

- `subscription:{customerId}` — checked by every tier-gated endpoint (voice, hints, etc.)
- `customer:{customerId}:profile` — the `GET /c/me` response

So the next tier-gated call (e.g. `POST /c/vehicles/:id/voice/token` if that were still live) sees the new tier immediately — no propagation delay.

---

## Suggested UX

### Settings → Membership section

Three tier cards (Free / Silver / Gold). Current tier is highlighted / disabled. Non-current tiers show a "Switch to X" button.

### Upgrade (Free → Silver → Gold)

Immediate call. Optimistic update is fine — the endpoint is fast (~50ms typical):

```ts
async function upgradeTo(next: 'silver' | 'gold') {
  const prev = auth.customer.tier
  auth.customer.tier      = next          // optimistic
  auth.customer.isPremium = next !== 'free'
  try {
    const res = await customerApi.setTier({ tier: next })
    auth.customer.tier      = res.tier     // authoritative
    auth.customer.isPremium = res.isPremium
    toast.success(`You're now on ${next.charAt(0).toUpperCase() + next.slice(1)}!`)
  } catch (err) {
    auth.customer.tier      = prev         // rollback
    auth.customer.isPremium = prev !== 'free'
    toast.error('Could not update tier — try again')
  }
}
```

### Downgrade (Gold → Silver → Free)

Show a confirmation modal first — the customer's losing features:

```
Switching to Silver will end your access to:
  · Voice mode
  · [Any other Gold-only features]

You can upgrade back anytime. Continue?
[Cancel]  [Switch to Silver]
```

Then the same immediate call. No refund logic here (nothing's paid yet).

### Tier-gated UI re-evaluation

The instant `auth.customer.tier` updates, any `v-if="isGold"` blocks should re-render:
- Voice mic button appears/disappears
- Chat hints panel appears/disappears
- Any "Upgrade to Gold" prompts hide themselves

If you're using a computed getter (`const isGold = computed(() => auth.customer.tier === 'gold')`) this happens automatically. If you're caching the tier in a local variable, refresh it after `setTier` resolves.

---

## What happens later (Stripe)

When real billing lands:

- **Upgrade flow**: frontend opens Stripe checkout → on `checkout.session.completed` webhook the backend calls the same DB update → frontend either gets a push notification, refetches `/c/me`, or listens to a subscription-updated event.
- **Downgrade flow**: either immediate (like now) or scheduled for end-of-billing-period. Product decision at that point.

This endpoint stays the source of truth for the mutation. Payment is layered on top.

---

## Smoke test

- [ ] Free customer PATCHes `{ tier: 'gold' }` → 200 `{ tier: 'gold', isPremium: true }`
- [ ] `GET /c/me` reflects the new tier immediately (no stale cache)
- [ ] Gold customer PATCHes `{ tier: 'free' }` → 200 `{ tier: 'free', isPremium: false }`
- [ ] Tier-gated UI updates without a page refresh
- [ ] `PATCH { tier: 'platinum' }` → 400 `INVALID_TIER`
- [ ] Unauthenticated PATCH → 401
- [ ] Optimistic-update rollback works on network failure

---

## What NOT to do

- Don't call `PATCH /c/me/tier` from a Free customer's "Upgrade" CTA if you haven't shown them the tier picker yet — it'll instantly upgrade them with no confirmation. Use it as the mutation target from the Membership card, not a shortcut button.
- Don't skip the downgrade confirmation modal — losing voice access mid-conversation would be a bad surprise.
- Don't refetch `GET /c/me` after every PATCH — the response body has the two fields you need. Refetch only if other profile fields might be stale for unrelated reasons.
