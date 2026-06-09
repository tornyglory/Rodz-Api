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
    "subject": "Your quote from Rodz Auto {{store}} — {{quoteNumber}}",
    "body": "Hi {{firstName}},\n\nWe've prepared a quote for your {{vehicle}} ({{rego}}).\n\nQuote #{{quoteNumber}}\n\nView and approve your quote here:\n{{approvalLink}}\n\nIf you have any questions, feel free to reply to this email.\n\nRodz Auto {{store}}"
  },
  "bookingReceivedTemplate": {
    "subject": "Booking received — {{services}} at Rodz Auto {{store}}",
    "body": "Hi {{firstName}},\n\nThanks for booking with us! We've received your booking request and will confirm shortly.\n\nVehicle: {{vehicle}} ({{rego}})\nService: {{services}}\nRequested date: {{date}}\nTime slot: {{slot}}\n\nRodz Auto {{store}}"
  },
  "bookingConfirmedTemplate": {
    "subject": "Booking confirmed — {{services}} on {{date}}",
    "body": "Hi {{firstName}},\n\nGreat news — your booking is confirmed!\n\nVehicle: {{vehicle}} ({{rego}})\nService: {{services}}\nDate: {{date}}\nTime slot: {{slot}}\nTechnician: {{techName}}\n\nRodz Auto {{store}}"
  },
  "workCommencedTemplate": {
    "subject": "Work has commenced on your {{vehicle}}",
    "body": "Hi {{firstName}},\n\nJust letting you know that work has started on your {{vehicle}} ({{rego}}).\n\nJob: {{jobNumber}}\nTechnician: {{techName}}\nService: {{services}}\nStore: {{store}}\n\nWe'll be in touch when your vehicle is ready.\n\nRodz Auto"
  },
  "workCompleteTemplate": {
    "subject": "Your {{vehicle}} is ready for pickup",
    "body": "Hi {{firstName}},\n\nGreat news — your {{vehicle}} ({{rego}}) is ready for pickup!\n\nJob: {{jobNumber}}\nService: {{services}}\n\nRodz Auto {{store}}"
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

| Variable | Available in | Example |
|----------|-------------|---------|
| `{{firstName}}` | All | `Brett` |
| `{{customerName}}` | All | `Brett Legend` |
| `{{vehicle}}` | All | `2026 Toyota Corolla` |
| `{{rego}}` | All | `HUT665` |
| `{{store}}` | All | `Rodz Auto Somerville` *(quote template strips the "Rodz " prefix)* |
| `{{date}}` | All booking + job templates | `Wed, 10 Jun 2026` |
| `{{services}}` | All booking + job templates | `Medium Service, Cabin Filter` |
| `{{bookingRef}}` | Booking + job templates | `EC3FL2BV` |
| `{{slot}}` | `bookingReceivedTemplate`, `bookingConfirmedTemplate` | `Morning` or `Afternoon` |
| `{{dropOffTime}}` | `bookingReceivedTemplate`, `bookingConfirmedTemplate` | `09:00` *(empty string if not set)* |
| `{{techName}}` | `bookingConfirmedTemplate`, `workCommencedTemplate`, `workCompleteTemplate` | `Howard R.` *(or `TBA` if unassigned)* |
| `{{jobNumber}}` | `workCommencedTemplate`, `workCompleteTemplate` | `J00005` |
| `{{quoteNumber}}` | `quoteTemplate` | `Q00009` |
| `{{approvalLink}}` | `quoteTemplate` | `https://workshop.rodz.com.au/q/abc123` |

> **Note:** Use `{{services}}` (plural). The variable `{{service}}` does not exist — any unrecognised variable is left as literal text in the sent email.

---

## UI notes

- Load settings on mount with `GET /settings/email-templates`. No empty state to handle — defaults always come back.
- Show `fromAddress` and `replyTo` as top-level fields above the template list.
- Each template gets its own section with a `subject` text input and a `body` textarea.
- The save button should PUT the full object assembled from all five sections plus `fromAddress`/`replyTo`. There is no partial save — always send everything.
- Consider highlighting `{{variable}}` tokens in the body textarea so editors can see which variables are in use.
- On success, update local state with the response — do not re-fetch.

---

## Sender settings

| Field | Value |
|-------|-------|
| **From address** | `Rodz Smart Auto <bookings@rodz.com.au>` |
| **Reply-to** | Optional — leave blank or set to a monitored inbox |

---

## Correct template content

Copy-paste ready. All variable names are verified against the backend.

---

### Quote sent

> Sent when a quote is sent to a customer via the Quotes screen.

**Subject**
```
Your quote from Rodz Smart Auto {{store}} — {{quoteNumber}}
```

**Body**
```
Hi {{firstName}},

We've prepared a quote for your {{vehicle}} ({{rego}}).

Quote #{{quoteNumber}}

View and approve your quote here:
{{approvalLink}}

If you have any questions, feel free to reply to this email.

Rodz Smart Auto {{store}}
```

---

### Booking received

> Sent immediately when a new booking is created (status: pending).

**Subject**
```
Booking received — {{services}} at Rodz Smart Auto {{store}}
```

**Body**
```
Hi {{firstName}},

Thanks for booking with us! We've received your booking request and will confirm shortly.

Vehicle: {{vehicle}} ({{rego}})
Service: {{services}}
Requested date: {{date}}
Time slot: {{slot}}

Rodz Smart Auto {{store}}
```

---

### Booking confirmed

> Sent when a booking is moved to confirmed status.

**Subject**
```
Booking confirmed — {{services}} on {{date}}
```

**Body**
```
Hi {{firstName}},

Great news — your booking is confirmed!

Vehicle: {{vehicle}} ({{rego}})
Service: {{services}}
Date: {{date}}
Time slot: {{slot}}
Technician: {{techName}}

Rodz Smart Auto {{store}}
```

---

### Work commenced

> Sent when a job is moved to In Progress on the Kanban board.

**Subject**
```
Work has commenced on your {{vehicle}}
```

**Body**
```
Hi {{firstName}},

Just letting you know that work has started on your {{vehicle}} ({{rego}}).

Job: {{jobNumber}}
Technician: {{techName}}
Service: {{services}}
Store: {{store}}

We'll be in touch when your vehicle is ready.

Rodz Smart Auto
```

---

### Ready for pickup

> Sent when a job is moved to Completed on the Kanban board.

**Subject**
```
Your {{vehicle}} is ready for pickup
```

**Body**
```
Hi {{firstName}},

Great news — your {{vehicle}} ({{rego}}) is ready for pickup!

Job: {{jobNumber}}
Service: {{services}}

Rodz Smart Auto {{store}}
```
