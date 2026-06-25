# Send Digital Logbook Email — Frontend Brief

Sends the customer their digital logbook link via email. Staff-triggered, one-off action.

---

## Endpoint

```
POST /vehicles/{rego}/send-logbook
```

Auth required (`Authorization: Bearer <token>`). No request body.

**Path param:** `rego` — vehicle registration plate (case-insensitive, normalised to uppercase server-side)

---

## Response

**`200 OK`**
```json
{ "sent": true }
```

**`404 Not Found`** — vehicle not found or inactive

**`422 Unprocessable Entity`** — one of:
- `"No email address on file for this customer."` — customer has no email, can't send
- `"Email settings not configured."` — fromAddress missing in settings
- `"Logbook email template not configured."` — `logbookTemplate` not saved in Settings → Email

---

## Where to surface this

Recommended placement: vehicle detail page or customer profile, next to the vehicle. A simple button labelled **"Send Logbook"** or **"Email Logbook Link"**.

### Suggested UX flow

1. Staff clicks "Send Logbook"
2. Button shows loading state
3. On `200` → show success toast: *"Logbook sent to [customer name]"*
4. On `422` with no email → show inline error: *"No email address on file for this customer"*
5. On `422` with template not configured → show inline error: *"Logbook email template not set up — check Settings → Email"*

---

## Notes

- Safe to call multiple times — the logbook link never changes for a vehicle once generated
- The email is also sent automatically 60 seconds after any job on this vehicle is marked completed — this endpoint is for on-demand sends only
- The `logbookTemplate` must be saved in Settings → Email before this will work (same place as invoice and booking templates)
