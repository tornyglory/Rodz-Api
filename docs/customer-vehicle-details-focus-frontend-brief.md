# Rego expiry — collect at signup + deep-link from health dashboard

**Status:** frontend-only change. No backend work.
**Scope:** small — add one field to the onboarding wizard, plus a query-param deep-link for the Details tab.

---

## Part 0 — Surface Rego expiry on the Profile tab (currently hidden)

**Problem:** On `/account/vehicles/:id` the customer sees the **Profile** tab by default (renders `VehicleProfileTab.vue`). Rego expiry does NOT appear there. It only appears on the **Details** tab (`VehicleDetailsTab.vue`), and even then only shows as an input *after* clicking the "Edit" button on the Registration card. Result: customers can't find where to enter rego expiry, and the health dashboard's Rego card is empty for everyone.

**Fix:** add a Rego expiry field to the Profile tab as an inline-editable row. Keep the Details tab as-is.

### What the row looks like

Small card or row on the Profile tab, near the top (below the vehicle hero, alongside odometer and other quick-glance stats):

```
Rego expiry
─────────────
[  2027-05-15 (365 days) ●  ]   <- green/amber/red status dot
                                    inline "Edit" affordance (pencil icon)
```

If null:
```
Rego expiry
─────────────
Not set — add it to get reminders    [ + Add expiry ]
```

Clicking either the Edit affordance or "Add expiry" opens an inline `<input type="date">`; save calls `PATCH /c/vehicles/:id` with `{ regoExpiry: 'YYYY-MM-DD' }` and updates the local vehicle ref via the existing `update:vehicle` emit.

### Colour coding (mirror the health dashboard rego card)

- ≥30 days to go → green dot, plain text.
- ≤30 days → amber background: "Due in 12 days".
- Expired → red: "Expired 8 days ago".

### Also do the same for VIN and Odometer if they're missing

Same inline-editable pattern. Both are already gated behind Edit on the Details tab. Surfacing them on the Profile tab closes the same discoverability gap.

---

## Part 1 — Add Rego expiry to the onboarding wizard

Right now the Onboarding Wizard Step 3 ("Add your first vehicle" in `CustomerOnboardingWizard.vue`) collects Rego plate, State, and a free-text vehicle description — but **not rego expiry**. That's the only self-service place a customer creates their vehicle, so rego expiry ends up unset for every new signup. The health dashboard's Rego card then shows the empty "add your rego expiry" state on day one for every new customer.

### What to change

In `CustomerOnboardingWizard.vue`, add a **Rego expiry** field to Step 3, alongside the existing Rego plate / State / Vehicle description inputs. Something like:

```html
<div class="cow__field cow__field--full">
  <label class="cow__label">Rego expiry (optional)</label>
  <input
    v-model="vehicleForm.regoExpiry"
    type="date"
    class="cow__input"
    :disabled="vehicleSaving"
  />
  <p class="cow__hint">You can add this later — we use it to remind you before your rego runs out.</p>
</div>
```

Wire the value into `vehicleForm` (`regoExpiry: ''`) and pass it to whichever API call adds the vehicle. The backend `POST /c/vehicles` handler already accepts `regoExpiry` (same shape as `PATCH /c/vehicles/:id`).

Keep it **optional** — don't block the wizard if the customer doesn't have the date handy. The health dashboard will nudge them later if it's still empty.

### Also consider

- Once we add a "Add another vehicle" flow for existing customers (currently missing on the customer side), include the same field there.
- Prefill an educated guess if we ever add rego-lookup (VIC PPSR / registration checks are cheap) — for now, blank + optional is fine.

---

## Part 2 — Show rego status on the public shareable profile

**Why:** the public logbook page (`/logbook/:token`) is what a potential buyer sees. Rego status is a huge trust signal for buyers — "rego current, 305 days to go" reassures them the seller isn't offloading a vehicle with a hidden compliance headache. This ties directly into the "documented history = more resale value" pitch the brain already talks about.

**Backend change: already deployed.** `GET /vehicles/logbook/:token` (Lambda: `LogbookVehicle`) now returns `regoExpiry` (ISO date `YYYY-MM-DD` or `null`) and `regoState` alongside the existing `rego` field.

**Frontend change:**

1. **`src/views/VehicleLogbookView.vue`** — update the `adaptedVehicle` computed (currently around line 235). Replace `regoExpiry: null` with the value from the public payload:

   ```ts
   regoExpiry: p.regoExpiry,      // was: null
   regoState:  p.regoState,       // was: null
   ```

2. **`src/api/customer.ts`** (or wherever `PublicVehicleProfile` is typed) — add the two optional fields:

   ```ts
   regoExpiry?: string | null   // ISO YYYY-MM-DD
   regoState?:  string | null
   ```

3. **`VehicleProfileTab.vue`** — render a **Rego status chip** near the top of the vehicle info block (near where you already show rego / year / make / model). Same colour rules as the health dashboard and the owner-facing profile:

   - `regoExpiry` set + ≥30 days to go → green chip: **"Rego current"** (small text: "365 days to go").
   - `regoExpiry` set + ≤30 days → amber chip: **"Rego expires in 12 days"**.
   - `regoExpiry` set + past → red chip: **"Rego expired 8 days ago"**.
   - `regoExpiry` null and `is-owner === false` → hide (don't broadcast that the owner hasn't set it publicly; too easy to misread as "expired").
   - `regoExpiry` null and `is-owner === true` → soft prompt: "Add rego expiry to show buyers you're up to date" with a link into the Details tab focus flow (Part 3 below).

### Buyer trust framing

If the vehicle is `forSale === true`, put the rego chip prominently next to the asking price so it's the first thing the buyer sees. Consider a small tooltip on hover:
> "Rego expiry pulled directly from the vehicle owner's records — updated {DD MMM YYYY}."

That's what makes it a trust signal: it's not marketing copy, it's the same data the workshop and the AI brain use.

### Privacy

Rego expiry is low-sensitivity — it's on the number plate in the real world. Ship it visible by default. If we later want a "hide rego status" toggle, it lives alongside the other Public Profile Settings on the vehicle Settings tab (history, photos, chat, maintenance — a fifth switch).

---

## Part 3 — Deep-link to Details tab with a focused field

## Why

The Vehicle Health Dashboard (`/account/vehicles/:id/health`) has cards that surface missing data — most obviously the **Rego** card, which shows "Add your rego expiry to get reminders" when `rego_expiry` is null. The `PATCH /c/vehicles/:id` endpoint already accepts `regoExpiry`, and the input already exists on the Details tab (`VehicleDetailsTab.vue`) — but only appears after the user clicks the "Edit" button on the Rego section. That's a discoverability gap: the health dashboard tells the customer *what* to do, but doesn't take them to the *exact* form field.

Same story for a couple of other empty states (VIN, odometer, description), so build this generically rather than one-off for rego expiry.

## What to build

### 1. Accept a `focus` query param on `/account/vehicles/:id`

Support these values (extend as needed):

| `focus` | Section | Auto-open edit mode? | Field to focus |
|---|---|---|---|
| `regoExpiry` | Rego | yes | `<input type="date">` for regoExpiry |
| `vin` | Rego | yes | VIN input |
| `odometer` | Vehicle Specs | yes | Odometer input |
| `description` | About | yes | Description textarea |

### 2. Auto-scroll + auto-open behaviour

On mount, if `route.query.focus` matches a known key:

1. Switch to the Details tab if we're not already there.
2. Set the relevant `editing*` ref to `true` (e.g. `editingRego.value = true`).
3. `nextTick(() => document.getElementById('vdt-input-regoExpiry')?.focus())`.
4. Scroll the section into view: `scrollIntoView({ behavior: 'smooth', block: 'center' })`.
5. Clear the query param after focusing (`router.replace({ query: { ...route.query, focus: undefined } })`) so a page refresh doesn't re-trigger.

### 3. IDs to add to inputs in `VehicleDetailsTab.vue`

Currently the inputs are unnamed. Add stable ids:

```html
<input id="vdt-input-regoExpiry" v-model="regoForm.regoExpiry" type="date" ... />
<input id="vdt-input-vin"         v-model="regoForm.vin"        type="text" ... />
<input id="vdt-input-odometer"    v-model="specsForm.odometer"  type="number" ... />
<textarea id="vdt-input-description" v-model="descForm.description" ... />
```

### 4. Wire from the Health dashboard

Rego card empty state (in `AccountVehicleHealthView.vue` when `rego.status === 'unknown'`):

```html
<router-link
  :to="{ path: `/account/vehicles/${vehicleId}`, query: { tab: 'details', focus: 'regoExpiry' } }"
  class="pw-empty-cta"
>
  Add rego expiry →
</router-link>
```

Same pattern when we surface an empty VIN or missing odometer.

## Nice-to-haves (skip for v1)

- **Highlight pulse:** briefly flash a soft outline around the focused field so the customer sees where they landed. Tailwind `ring` classes + a `setTimeout` to remove.
- **Success bounce:** on save, animate the field back to read-mode with a green tick, then optionally route back to the health dashboard.
- **Extend to other views:** the same `?focus=` param could work on the Settings page for customer profile fields (e.g. missing suburb).

## What NOT to build

- **A whole new "quick edit" modal.** The Details tab already has a nice edit form; deep-linking to it is cheaper and keeps one source of truth.
- **A separate "fix your data" wizard.** Empty-state CTAs in the dashboard are the funnel — no need to wrap them in a wizard.

## Test plan

- Visit `/account/vehicles/4?tab=details&focus=regoExpiry` — the Rego section should open in edit mode with the date input focused.
- Type a date, save. Confirm `PATCH /c/vehicles/4` fires with `{ regoExpiry: 'YYYY-MM-DD' }`.
- Refresh the page — the URL query param should be cleared (no infinite focus loop).
- Go back to `/account/vehicles/4/health` — the Rego card should now show a green countdown chip.
