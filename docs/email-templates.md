# Email Templates — Frontend Brief

**Base URL:** `https://fzzrkscwd7.execute-api.ap-southeast-2.amazonaws.com`

`super_admin` only. All other roles receive `403 FORBIDDEN`.

---

## Fetch current settings

```
GET /settings/email-templates
Authorization: Bearer <accessToken>
```

No body. Returns the saved settings, or built-in defaults if nothing has been saved yet. The response shape is always the same — the frontend never needs to handle a missing/empty state.

**Response 200**
```json
{
  "fromAddress": "bookings@rodz.com.au",
  "replyTo": "",
  "quoteTemplate": {
    "subject": "Your quote from Rodz Auto — {{quoteNumber}}",
    "body": "Hi {{customerName}},\n\nWe've prepared a quote for your {{vehicle}} ({{rego}}).\n\nQuote #{{quoteNumber}} — Total: {{total}}\n\nView your quote here: {{quoteLink}}\n\nIf you have any questions, feel free to reply to this email.\n\nRodz Auto {{store}}"
  },
  "bookingReceivedTemplate": {
    "subject": "Booking received — {{service}} at Rodz Auto {{store}}",
    "body": "Hi {{customerName}},\n\nThanks for booking with us! We've received your booking request and will confirm shortly.\n\nVehicle: {{vehicle}} ({{rego}})\nService: {{service}}\nRequested date: {{date}}\nTime slot: {{slot}}\n\nRodz Auto {{store}}"
  },
  "bookingConfirmedTemplate": {
    "subject": "Booking confirmed — {{service}} on {{date}}",
    "body": "Hi {{customerName}},\n\nGreat news — your booking is confirmed!\n\nVehicle: {{vehicle}} ({{rego}})\nService: {{service}}\nDate: {{date}}\nTime slot: {{slot}}\nHoist: {{hoist}}\n\nRodz Auto {{store}}"
  },
  "workCommencedTemplate": {
    "subject": "Work has commenced on your {{vehicle}}",
    "body": "Hi {{customerName}},\n\nJust letting you know that work has started on your {{vehicle}} ({{rego}}).\n\nTechnician: {{tech}}\nService: {{service}}\nStore: {{store}}\n\nWe'll be in touch when your vehicle is ready.\n\nRodz Auto"
  },
  "workCompleteTemplate": {
    "subject": "Your {{vehicle}} is ready for pickup",
    "body": "Hi {{customerName}},\n\nGreat news — your {{vehicle}} ({{rego}}) is ready for pickup!\n\nYou can collect your vehicle from:\n{{storeAddress}}\n\nRodz Auto {{store}}"
  }
}
```

---

## Save settings

```
PUT /settings/email-templates
Authorization: Bearer <accessToken>
Content-Type: application/json
```

Send the complete settings object — all five templates must be included. This replaces the entire saved config.

**Body** — same shape as the GET response. All `subject` and `body` fields are required. `fromAddress` is required. `replyTo` is optional (send `""` to clear it).

**Response 200** — returns the saved object (same shape as GET).

**Errors**

| Status | Code | When |
|--------|------|------|
| `422` | `VALIDATION_ERROR` | Missing `fromAddress`, or any template missing `subject` or `body` |
| `403` | `FORBIDDEN` | Not `super_admin` |

---

## Template keys

| Key | When it is sent |
|-----|----------------|
| `quoteTemplate` | When a quote is issued to a customer |
| `bookingReceivedTemplate` | When a booking request is submitted (unconfirmed) |
| `bookingConfirmedTemplate` | When a booking is confirmed with a date/hoist |
| `workCommencedTemplate` | When a technician starts work |
| `workCompleteTemplate` | When the job is marked done and vehicle is ready |

---

## Template variables

Variables use `{{variableName}}` syntax in both `subject` and `body`. The backend substitutes real values at send time. Unrecognised variables are left unchanged, so the UI can safely display them as-is.

| Variable | Available in |
|----------|-------------|
| `{{customerName}}` | All |
| `{{vehicle}}` | All |
| `{{rego}}` | All |
| `{{store}}` | All |
| `{{storeAddress}}` | `workCompleteTemplate` |
| `{{quoteNumber}}` | `quoteTemplate` |
| `{{quoteLink}}` | `quoteTemplate` |
| `{{total}}` | `quoteTemplate` |
| `{{service}}` | Booking templates, `workCommencedTemplate` |
| `{{date}}` | `bookingReceivedTemplate`, `bookingConfirmedTemplate` |
| `{{slot}}` | `bookingReceivedTemplate`, `bookingConfirmedTemplate` |
| `{{hoist}}` | `bookingConfirmedTemplate` |
| `{{tech}}` | `workCommencedTemplate` |

---

## UI notes

- Load settings on mount with `GET /settings/email-templates`. No empty state to handle — defaults always come back.
- Show `fromAddress` and `replyTo` as top-level fields above the template list.
- Each template gets its own section with a `subject` text input and a `body` textarea.
- The save button should PUT the full object assembled from all five sections plus `fromAddress`/`replyTo`. There is no partial save — always send everything.
- Consider highlighting `{{variable}}` tokens in the body textarea so editors can see which variables are in use.
- On success, update local state with the response — do not re-fetch.
