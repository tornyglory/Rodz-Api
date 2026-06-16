# Job Card — Frontend Brief

**Base URL:** `https://fzzrkscwd7.execute-api.ap-southeast-2.amazonaws.com`

All requests require `Authorization: Bearer <accessToken>`.

---

## Overview

When a customer approves a quote, the quote line items are automatically converted into a job card — a checklist the technician ticks off as they complete each task. When all items are ticked, the job is marked complete and the customer is automatically notified to collect their vehicle.

---

## Workflow

```
Customer approves quote
        ↓
Job card created automatically (one item per quote line)
        ↓
Tech ticks off each task as work is done
        ↓
All tasks complete → job status → "completed" → pickup email sent to customer
```

---

## GET /jobs/{id}/card

Returns the job card with current completion state.

Returns `404` if the quote hasn't been approved yet — use this to decide whether to show the card tab.

### Request

```
GET /jobs/42/card
Authorization: Bearer <accessToken>
```

### Response `200`

```json
{
  "jobId": 42,
  "allComplete": false,
  "items": [
    {
      "id": 1,
      "description": "Medium Service (small + air & cabin filter)",
      "qty": 1,
      "sortOrder": 0,
      "completed": true,
      "completedAt": "2026-06-16T09:14:00.000Z",
      "completedBy": "J. Smith",
      "notes": null
    },
    {
      "id": 2,
      "description": "Brake Pad Replace — Front",
      "qty": 1,
      "sortOrder": 1,
      "completed": false,
      "completedAt": null,
      "completedBy": null,
      "notes": null
    }
  ]
}
```

### Error responses

| Status | When |
|--------|------|
| `404` | Job not found, or quote not yet approved (no card exists) |
| `401` | Missing or invalid token |
| `403` | Staff member doesn't have access to this store |

---

## PATCH /jobs/{id}/card/{itemId}

Marks a task complete or incomplete. Returns the full updated job card.

When the last item is ticked, the job status is automatically set to `completed` and a pickup-ready email is sent to the customer.

If a completed item is later unticked (e.g. rework needed), the job status reverts to `in_progress`.

### Request

```
PATCH /jobs/42/card/2
Authorization: Bearer <accessToken>
Content-Type: application/json
```

```json
{
  "completed": true,
  "notes": "Done — test drove ok, brakes feel good"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `completed` | Yes | `true` to tick off, `false` to untick |
| `notes` | No | Optional note from the tech |

### Response `200`

Same shape as `GET /jobs/{id}/card` — full updated card:

```json
{
  "jobId": 42,
  "allComplete": true,
  "items": [
    {
      "id": 1,
      "description": "Medium Service (small + air & cabin filter)",
      "qty": 1,
      "sortOrder": 0,
      "completed": true,
      "completedAt": "2026-06-16T09:14:00.000Z",
      "completedBy": "J. Smith",
      "notes": null
    },
    {
      "id": 2,
      "description": "Brake Pad Replace — Front",
      "qty": 1,
      "sortOrder": 1,
      "completed": true,
      "completedAt": "2026-06-16T10:32:00.000Z",
      "completedBy": "J. Smith",
      "notes": "Done — test drove ok, brakes feel good"
    }
  ]
}
```

When `allComplete` becomes `true`, show a success state — the job is done and the customer has been notified.

---

## POST /jobs/{id}/notify-pickup

Manually resends the pickup notification email to the customer. For use when the customer needs a reminder or the automatic send failed.

**Minimum role: store_manager**

### Request

```
POST /jobs/42/notify-pickup
Authorization: Bearer <accessToken>
```

No body required.

### Response `200`

```json
{
  "sent": true,
  "recipient": "customer@example.com"
}
```

### Error responses

| Status | When |
|--------|------|
| `400` | Customer has no email address on file |
| `403` | Technician role (store_manager or above only) |

---

## Suggested UI

### Where to show it

Add a **"Job Card"** tab on the job detail screen, alongside the existing tabs. Show the tab only once `GET /jobs/{id}/card` returns a `200` — if it returns `404`, hide the tab (the quote isn't approved yet).

Show a badge on the tab with the count of incomplete items.

### Checklist layout

```
┌─────────────────────────────────────────────────┐
│ JOB CARD                        2 / 3 complete  │
├─────────────────────────────────────────────────┤
│ ✅  Medium Service                               │
│     Completed by J. Smith · 9:14 AM             │
├─────────────────────────────────────────────────┤
│ ✅  Brake Pad Replace — Front                    │
│     Done — test drove ok, brakes feel good      │
│     Completed by J. Smith · 10:32 AM            │
├─────────────────────────────────────────────────┤
│ ☐   Wheel Alignment                             │
│     [ Add a note... ]                           │
└─────────────────────────────────────────────────┘
```

### Ticking off

Each item should have a checkbox or tap-to-complete interaction. On tap:
1. Optimistically mark the item complete in the UI
2. Call `PATCH /jobs/{id}/card/{itemId}` with `{ "completed": true }`
3. Replace the local state with the returned card

Unticking works the same way with `{ "completed": false }`.

### All complete state

When `allComplete` is `true`, show a banner:

```
🎉 All tasks complete — customer has been notified to collect their vehicle.
```

If the manager wants to resend the notification, surface a **"Resend pickup notification"** button (store_manager+ only) that calls `POST /jobs/{id}/notify-pickup`.

### Notes field

Show a collapsible or inline text field per item when ticking off — optional. If `notes` is already set on a completed item, always show it.

---

## Permissions summary

| Action | Minimum role |
|--------|-------------|
| View job card | technician |
| Tick / untick items | technician |
| Resend pickup notification | store_manager |
