# Public Profile Visibility — Frontend Brief

Let customers control which tabs are visible to anonymous visitors on their vehicle's public profile (`/logbook/:token` or `/vehicle/:token`).

- Setting lives in the customer's own portal (Settings tab on the vehicle profile).
- Enforcement is both frontend (hide tabs) and backend (403 the data endpoints).
- Applies immediately — no publish step.

---

## Base URL

```
https://fzzrkscwd7.execute-api.ap-southeast-2.amazonaws.com
```

Customer-side endpoints require a customer JWT. Public logbook endpoints are open.

---

## What's toggleable

| Setting key | Public tab / section | Default |
|-------------|----------------------|---------|
| `history` | Service history (workshop invoices + external logbook entries) | ✅ visible |
| `photos` | Gallery photos | ✅ visible |
| `chat` | Ask AI chat about the vehicle | ✅ visible |
| `maintenance` | AI-generated maintenance schedule (`ai_recommendations`) | ✅ visible |
| `modifications` | Modifications section — aftermarket parts / tunes the owner has declared | ✅ visible |

Individual mods also carry a per-row `isPublic` flag (see `customer-modifications-frontend-brief.md`). Both gates apply:
- **`publicProfileSettings.modifications === false`** hides the whole section on the public profile.
- **Per-mod `isPublic === false`** hides that specific mod even when the section is on.
- The AI chat on the public profile only mentions mods when the section is public AND the specific mod is public.

**Not toggleable:**
- **Specs** — always visible (it's the identity of the profile)
- **For-sale banner** — controlled by the existing `forSale` boolean
- **Ownership / SOLD badge** — driven by transfer state, not this setting

---

## API surface

### Reading the current settings

**Customer's own vehicle:** `GET /c/vehicles/:id`

Response now includes:
```json
{
  "id": 10,
  "rego": "LWF251",
  ...
  "publicProfileSettings": {
    "history":       true,
    "photos":        true,
    "chat":          true,
    "maintenance":   true,
    "modifications": true
  }
}
```

If never toggled, all five default to `true`. Always populated — no null.

**Public profile page:** `GET /logbook/:token/vehicle`

Response now includes:
```json
{
  "rego": "LWF251",
  ...
  "publicSettings": {
    "history":       true,
    "photos":        true,
    "chat":          true,
    "maintenance":   true,
    "modifications": true
  },
  "images": [ ... ]
}
```

Note the different key name (`publicSettings` vs `publicProfileSettings`) — this is intentional so the two response shapes are clearly distinguishable in the type system.

`images` is `[]` when `photos === false` — server enforces this even if the frontend forgets to hide the tab. Same enforcement applies to modifications: the public modifications endpoint returns `[]` when the section is toggled off (or when no individual mod is public).

### Writing settings

**`PATCH /c/vehicles/:id/profile`**

The existing profile PATCH endpoint accepts a `publicProfileSettings` object. Partial patches — send only the keys you're changing. Everything else is preserved.

**Request**
```json
{
  "publicProfileSettings": {
    "chat": false
  }
}
```

Can be sent alongside the other profile fields (`forSale`, `askingPrice`, etc.) in the same call.

**Response — 200**
```json
{
  "forSale":               false,
  "askingPrice":           null,
  "city":                  null,
  "country":               null,
  "contactName":           "John Smith",
  "contactPhone":          "+61400000000",
  "contactEmail":          "john@example.com",
  "publicProfileSettings": {
    "history":       true,
    "photos":        true,
    "chat":          false,
    "maintenance":   true,
    "modifications": true
  }
}
```

**Errors**

| Status | Code | When |
|--------|------|------|
| `403` | `FORBIDDEN` | Vehicle doesn't belong to this customer |
| `422` | `VALIDATION_ERROR` | `publicProfileSettings` sent but not an object with boolean keys |

---

## Server-side enforcement

The frontend must hide tabs based on `publicSettings`, but even if it doesn't the data endpoints will reject:

| Setting off | Endpoint | Returns |
|-------------|----------|---------|
| `photos: false` | `GET /logbook/:token/vehicle` | `images: []` (never leaks the array) |
| `history: false` | `GET /logbook/:token` (service history) | `403 HISTORY_HIDDEN` |
| `chat: false` | `POST /logbook/:token/chat` | `403 CHAT_DISABLED` |
| `maintenance: false` | `GET /logbook/:token/recommendations` | `403 RECOMMENDATIONS_HIDDEN` |
| `modifications: false` | `GET /logbook/:token/modifications` | `[]` (returned empty when section is off, or when every mod has `isPublic: false`). Public chat context also excludes mods in this case. |

Handle those 403s as "tab shouldn't have been shown" — quietly redirect the user to the Specs tab if they somehow land there.

---

## Type additions

```ts
// src/api/customer.ts or wherever your types live
export interface PublicProfileSettings {
  history:       boolean
  photos:        boolean
  chat:          boolean
  maintenance:   boolean
  modifications: boolean
}

// Add to CustomerVehicle
export interface CustomerVehicle {
  // ... existing fields
  publicProfileSettings: PublicProfileSettings
}

// Add to PublicVehicleProfile
export interface PublicVehicleProfile {
  // ... existing fields
  publicSettings: PublicProfileSettings
}
```

---

## API client additions

```ts
// src/api/customer.ts
export const customerApi = {
  // ... existing methods

  updatePublicSettings: async (
    vehicleId: number,
    settings: Partial<PublicProfileSettings>,
  ): Promise<{ publicProfileSettings: PublicProfileSettings }> => {
    const res = await fetch(`${API_BASE}/c/vehicles/${vehicleId}/profile`, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body:    JSON.stringify({ publicProfileSettings: settings }),
    })
    if (!res.ok) throw new Error(`${res.status}`)
    return res.json()
  },
}
```

---

## UI — Settings tab on the customer's own vehicle profile

Add a new "Public profile visibility" card below "Public Profile Link" (or above "For Sale", wherever it reads well in the flow):

```
┌────────────────────────────────────────────────────────┐
│  🔒 Public Profile Visibility                          │
│                                                        │
│  Choose what people see when you share your vehicle's  │
│  public profile link.                                  │
│                                                        │
│  ┌──────────────────────────────────────────┐          │
│  │ Service history                    [ ● ] │  ← on   │
│  │ Shows what Rodz has serviced             │          │
│  └──────────────────────────────────────────┘          │
│  ┌──────────────────────────────────────────┐          │
│  │ Photos                             [ ● ] │  ← on   │
│  │ Photos you've uploaded to the gallery    │          │
│  └──────────────────────────────────────────┘          │
│  ┌──────────────────────────────────────────┐          │
│  │ Ask AI                             [ ○ ] │  ← off  │
│  │ Let visitors chat with an AI about       │          │
│  │ this vehicle                             │          │
│  └──────────────────────────────────────────┘          │
│  ┌──────────────────────────────────────────┐          │
│  │ Maintenance schedule               [ ● ] │  ← on   │
│  │ AI-generated upcoming service items      │          │
│  └──────────────────────────────────────────┘          │
│  ┌──────────────────────────────────────────┐          │
│  │ Modifications                      [ ● ] │  ← on   │
│  │ Aftermarket parts + tunes you've         │          │
│  │ declared on this vehicle                 │          │
│  └──────────────────────────────────────────┘          │
│                                                        │
│  [ View public profile → ]                             │
└────────────────────────────────────────────────────────┘
```

### Toggle behaviour

- Each toggle fires an immediate PATCH with just the one changed key.
- Optimistic UI: flip the visual state instantly, roll back on error.
- Show a small spinner or subtle opacity change on the toggle while the request is in flight.
- On error → toast: "Couldn't save — please try again." Roll back the visual state.
- Debounce isn't necessary since each toggle is one boolean change.

### Component structure (suggestion)

- `PublicProfileVisibilityCard.vue` — new component on the Settings tab.
- Loads state from the vehicle object passed as a prop (already fetched on mount by the parent `VehicleProfileTab`).
- Emits `updated` when settings change so the parent can update its local vehicle state.

### Empty / initial state

Not needed — `publicProfileSettings` is always populated (defaults on the server).

---

## UI — public profile page

The vehicle profile page (`VehiclePublicProfileView.vue`) can host up to five tabs beyond Specs: **Specs · History · Photos · Ask AI · Maintenance · Modifications** — each shown or hidden per the owner's settings.

### Tab filtering

On mount, after `GET /logbook/:token/vehicle` returns, filter the tab list:

```ts
const tabs = computed(() => {
  const s = profile.value?.publicSettings ?? {
    history: true, photos: true, chat: true, maintenance: true, modifications: true,
  }
  return [
    { key: 'specs',         label: 'Specs'         },  // always
    s.history       && { key: 'history',       label: 'History'       },
    s.photos        && { key: 'photos',        label: 'Photos'        },
    s.chat          && { key: 'chat',          label: 'Ask AI'        },
    s.maintenance   && { key: 'maintenance',   label: 'Maintenance'   },
    s.modifications && { key: 'modifications', label: 'Modifications' },
  ].filter(Boolean)
})
```

If the currently-active tab is filtered out (edge case — settings changed while the page was open), fall back to `specs`.

### Handling the data-side 403s (defence-in-depth)

If the tab list is filtered correctly, these should never fire. But in case they do (e.g. race condition, cached page):

- `GET /logbook/:token` → `403 HISTORY_HIDDEN`: log it, hide the History tab, redirect to Specs.
- `POST /logbook/:token/chat` → `403 CHAT_DISABLED`: hide the Ask AI tab, show a "This assistant is disabled" note.
- `GET /logbook/:token/recommendations` → `403 RECOMMENDATIONS_HIDDEN`: hide the Maintenance tab, redirect to Specs.
- `GET /logbook/:token/modifications` → `[]`: silently show the tab as empty, or hide it (see behaviour matrix).
- `images: []` — nothing to do; the Photos tab will already be hidden by the filter.

---

## Behaviour matrix

| Situation | What the owner sees | What a visitor sees |
|-----------|---------------------|---------------------|
| Default (never toggled) | All toggles on | All tabs visible |
| Owner turns `chat` off | Toggle off in Settings | Ask AI tab hidden; direct POST to chat returns 403 |
| Owner turns `history` off | Toggle off in Settings | History tab hidden; direct GET returns 403 |
| Owner turns `photos` off | Toggle off in Settings | Photos tab hidden; `images: []` in vehicle response |
| Owner turns `maintenance` off | Toggle off in Settings | Maintenance tab hidden; recommendations endpoint returns 403 |
| Owner turns `modifications` off | Toggle off in Settings | Modifications tab hidden; public mods endpoint returns `[]`; AI chat context omits mods |
| Owner turns all five off | All toggles off | Only Specs tab visible |
| Visitor lands on old URL with `?tab=chat` after chat was disabled | — | Silently redirect to Specs |
| Two different browsers both open the profile then owner toggles | — | Older browser hits 403 next request; falls back to Specs |

---

## Testing checklist

- [ ] Default state — public profile shows all five toggleable tabs; toggles are all on in Settings
- [ ] Turn `photos` off in Settings → Photos tab disappears from the public profile within one page reload
- [ ] Turn `history` off in Settings → History tab disappears; direct navigation to `?tab=history` falls back to Specs
- [ ] Turn `chat` off in Settings → Ask AI tab disappears; if someone sends a chat POST directly, they get `403 CHAT_DISABLED`
- [ ] Turn `maintenance` off in Settings → Maintenance tab disappears; direct GET returns `403 RECOMMENDATIONS_HIDDEN`
- [ ] Turn `modifications` off in Settings → Modifications tab disappears; direct GET returns `[]`; AI chat no longer mentions mods
- [ ] With `modifications: true` at the settings level AND at least one mod with `isPublic: false` → that mod is filtered from the public list; the others still show
- [ ] Toggle a single setting (partial PATCH) — the other four are unaffected
- [ ] Owner's own vehicle detail page always shows full data regardless of these toggles (settings only affect public profile)
- [ ] The "View public profile" link on Settings opens in a new tab and reflects the current visibility state
- [ ] Failed PATCH (simulate 500) — toggle rolls back, toast shown
- [ ] Two-window test — toggling in one window is reflected in the public profile on the next fetch in the other window

---

## Out of scope for v1

- Per-tab granular controls beyond the three listed (e.g. hide specific invoices from history)
- Bulk "make my whole profile private" master toggle — customers can just delist by turning off all three
- Password/access-code protection for the public URL
- Per-viewer allowlisting (e.g. only visitors with an account can see photos)
- Preview mode ("show me what my public profile looks like right now") — visiting the logbook URL in an incognito tab is the workaround
