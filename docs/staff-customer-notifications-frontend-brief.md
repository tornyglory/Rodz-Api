# Staff Customer Notifications — Workshop Frontend Brief

Surface each customer's notification-reachability at a glance inside the workshop `CustomerProfileDrawer`. Answers "can we reach this customer via push?" without leaving the drawer, and tells staff what channels/topics they've opted out of before making a call.

No new endpoint — the data is now included on the existing `GET /customers/{id}` response.

---

## Base URL & auth

```
GET https://fzzrkscwd7.execute-api.ap-southeast-2.amazonaws.com/customers/{id}
Authorization: Bearer <staff_jwt>
```

Existing endpoint. Now returns a `notifications` block on the `customer` object.

---

## New response block

Every existing field on `customer` is unchanged. Added at the top level:

```json
{
  "customer": {
    "id": 24,
    "name": "…",
    "…": "…existing fields…",

    "notifications": {
      "pushDevices":      2,
      "pushLastSeenAt":   "2026-07-15T04:22:11.000Z",
      "topicsOptedOut":   ["quote", "invoice"],
      "quietHours":       { "start": "21:00", "end": "07:00" },
      "preferredContact": "mobile",
      "smsOptIn":         true,
      "marketingOptIn":   true,
      "pushOptIn":        true
    }
  }
}
```

### Field reference

| Field | Type | Notes |
|-------|------|-------|
| `pushDevices` | integer | Number of active mobile devices registered for push. `0` = customer has no push reachability. |
| `pushLastSeenAt` | ISO datetime \| `null` | Most recent `last_seen_at` across the customer's device tokens. `null` when `pushDevices === 0`. Useful for "last used the app 3 weeks ago" context. |
| `topicsOptedOut` | string[] | Camel-case topic keys the customer has explicitly opted out of. **Empty array = opted in to everything.** Values: `serviceDue`, `regoExpiring`, `booking`, `quote`, `invoice`, `urgentReco`, `workshopMessage`. |
| `quietHours` | `{ start: "HH:MM", end: "HH:MM" }` \| `null` | Local-time range where the customer has silenced pushes. `null` = no quiet hours set. |
| `preferredContact` | `"mobile"` \| `"email"` \| `"sms"` \| `"app"` | Customer's stated preference for how the workshop reaches them. |
| `smsOptIn` | boolean | Legacy channel flag — whether the customer has SMS enabled. |
| `marketingOptIn` | boolean | Legacy — marketing-comms consent. |
| `pushOptIn` | boolean | Legacy toggle — separate from `pushDevices`. `true` here + `0` devices = customer has never installed the app; `true` + `>0` devices = actively reachable; `false` = customer has muted push in-app. |

### What "notifications on" actually means

There are two independent signals — read them together:

1. **Can we reach them?** — `pushDevices > 0`. This is the ground truth. A device row exists, the app is installed, we have a token.
2. **Do they want us to?** — `pushOptIn === true` **and** the specific topic isn't in `topicsOptedOut` **and** the current time isn't within `quietHours`.

`pushDevices = 0` overrides everything — even if `pushOptIn = true`, we have no delivery channel. That's the case worth flagging in the drawer.

---

## UI recommendation

### Compact pill on the customer card header

Alongside the tier badge and Premium chip, add a notification-status pill:

| State | Condition | Pill |
|-------|-----------|------|
| Reachable | `pushDevices > 0` and `pushOptIn === true` | 🔔 **Push on** *(N device{s})* — green |
| Muted | `pushDevices > 0` and `pushOptIn === false` | 🔕 **Push muted** — amber |
| No app | `pushDevices === 0` | 📵 **No app** — grey |

Show device count when > 1. Click/hover opens the popover below.

### Popover / expanded panel

```
┌─────────────────────────────────────────────┐
│ Notification reachability                   │
│                                             │
│ Push:       ✅ 2 devices                    │
│             Last seen 3 days ago            │
│ Prefers:    Mobile                          │
│                                             │
│ Quiet hours: 21:00 – 07:00                  │
│                                             │
│ Opted out of:                               │
│   • Quotes                                  │
│   • Invoices                                │
│                                             │
│ Other channels:                             │
│   SMS:       On                             │
│   Marketing: On                             │
└─────────────────────────────────────────────┘
```

- Hide the "Opted out of" section when `topicsOptedOut.length === 0` (show a green "Opted in to everything" line instead).
- Hide "Quiet hours" when `quietHours === null`.
- Show a red **"Not reachable via push"** banner when `pushDevices === 0`, with hint: *"Ask the customer to install the Rodz app for real-time updates."*

### Topic labels

Map camelCase keys to friendly labels:

| Key | Label |
|-----|-------|
| `serviceDue` | Service reminders |
| `regoExpiring` | Rego expiry reminders |
| `booking` | Booking updates |
| `quote` | Quotes |
| `invoice` | Invoices |
| `urgentReco` | Urgent recommendations |
| `workshopMessage` | Direct messages from the workshop |

### "Last seen" formatting

Show `pushLastSeenAt` as a relative time (`"3 days ago"`, `"just now"`, `"6 weeks ago"`). Use `date-fns/formatDistanceToNow` or equivalent. Grey out if > 30 days — it's a hint that the customer may have uninstalled the app but we still hold a stale token.

---

## Types

```ts
export interface CustomerNotifications {
  pushDevices:      number
  pushLastSeenAt:   string | null
  topicsOptedOut:   NotificationTopic[]
  quietHours:       { start: string; end: string } | null
  preferredContact: 'mobile' | 'email' | 'sms' | 'app'
  smsOptIn:         boolean
  marketingOptIn:   boolean
  pushOptIn:        boolean
}

export type NotificationTopic =
  | 'serviceDue'
  | 'regoExpiring'
  | 'booking'
  | 'quote'
  | 'invoice'
  | 'urgentReco'
  | 'workshopMessage'

// Add to the existing Customer type
export interface Customer {
  // ... existing fields
  notifications: CustomerNotifications
}
```

---

## No writes in v1

This brief is **read-only** for the workshop. Staff cannot toggle notification prefs on the customer's behalf — customers do that themselves in the mobile app (`PATCH /c/me/notification-prefs`). If workshop staff need to change a preference (rare, usually a support call), they walk the customer through it in the app. Rationale: consent belongs to the customer.

If you need to give staff the ability to at least toggle the legacy `smsOptIn` / `marketingOptIn` flags — those are already writable via `PATCH /customers/{id}` today (existing endpoint, existing fields). No change here.

---

## Errors

Same as the existing `GET /customers/{id}` endpoint. No new failure modes.

| Status | Meaning |
|--------|---------|
| `404` | Customer doesn't exist or doesn't belong to this store |

If the customer has no `customer_notification_prefs` row yet (they've never toggled anything), the API still returns a valid `notifications` block — `topicsOptedOut: []`, `quietHours: null`. This is the correct "defaults on" state; don't render it as an error.

---

## Testing checklist

- [ ] Customer with app installed and no toggles → `pushDevices: 1+`, `topicsOptedOut: []`, `quietHours: null` → green **Push on** pill
- [ ] Customer with app installed, opted out of quotes + invoices → topic list shows both, popover renders the friendly labels
- [ ] Customer with app installed but `pushOptIn = false` → amber **Push muted** pill
- [ ] Customer with no app installed → `pushDevices: 0`, `pushLastSeenAt: null` → grey **No app** pill, red banner in popover
- [ ] Customer with quiet hours 21:00 – 07:00 → rendered as `"21:00 – 07:00"` (no seconds)
- [ ] Customer with quiet hours crossing midnight (start > end) still renders correctly
- [ ] `pushLastSeenAt` > 30 days ago → greyed / caveated
- [ ] Popover works on both hover and keyboard focus
- [ ] Technician login → sees the pill (read-only, no toggles anyway)
