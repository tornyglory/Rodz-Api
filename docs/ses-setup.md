# SES Email Setup — Operations Guide

One-time setup required before transactional emails will be sent. Takes about 30 minutes end to end; production access approval can take a few hours.

---

## Overview

The API sends email via AWS SES in `ap-southeast-2` (Sydney). The Lambda functions that trigger emails (`BookingCreate`, `BookingUpdate`, `JobUpdate`) already have `ses:SendEmail` IAM permission granted by CDK. The only things left to do are:

1. Verify your sending domain (or email address) in SES
2. Request production access to send to unverified recipients
3. Configure templates and `fromAddress` via the API

---

## Step 1 — Verify your sending identity

Go to: **AWS Console → SES → ap-southeast-2 → Configuration → Verified identities → Create identity**

### Option A: Verify a domain (recommended for production)

Use this if you want to send from any address at your domain (e.g. `bookings@rodz.com.au`, `noreply@rodz.com.au`).

1. Select **Domain** → enter `rodz.com.au`
2. Leave DKIM signing enabled (default)
3. Click **Create identity**
4. AWS will show you DNS records to add — copy them to your domain registrar:
   - 3× CNAME records for DKIM (`xxxx._domainkey.rodz.com.au`)
   - Optionally a TXT record for custom MAIL FROM
5. Wait 10–30 minutes for DNS propagation
6. Refresh the SES console — status should change to **Verified**

### Option B: Verify a single email address (quick for testing)

1. Select **Email address** → enter the address you want to send from
2. Click **Create identity**
3. AWS sends a verification email — click the link inside it
4. Status becomes **Verified** immediately

---

## Step 2 — Request production access

By default SES is in **sandbox mode** — you can only send to verified email addresses. To send to real customers you must request production access.

Go to: **AWS Console → SES → ap-southeast-2 → Account dashboard → Request production access**

Fill in the form:
- **Mail type:** Transactional
- **Website URL:** your app URL
- **Use case description:** Something like: *"We send transactional emails to customers of Rodz Auto — booking confirmations, job commencement notices, and job completion notices. Emails are triggered by customer actions (booking a service) and by staff actions (confirming bookings, updating job status). We do not send marketing or bulk email."*
- **Additional contacts:** your email

Submit and wait. Approval is usually within a few hours. You'll get an email from AWS when it's done.

> You can continue with Step 3 before production access is approved — emails will just silently fail until it's active. This won't break any API responses.

---

## Step 3 — Configure templates via the API

Call `PUT /settings/email-templates` as a `super_admin` to store your `fromAddress` and template content. This only needs to be done once (or whenever you want to update the copy).

```
PUT /settings/email-templates
Authorization: Bearer <super_admin_token>
Content-Type: application/json
```

The `fromAddress` must be the verified address or a domain address at your verified domain. Example:

```json
{
  "fromAddress": "bookings@rodz.com.au",
  "replyTo": "bookings@rodz.com.au",
  "bookingReceivedTemplate": {
    "subject": "Booking received — {{bookingRef}}",
    "body": "Hi {{firstName}},\n\nThanks for booking with us. We've received your request and will confirm it shortly.\n\nVehicle: {{vehicle}} ({{rego}})\nServices: {{services}}\nDate: {{date}} — {{slot}}\nStore: Rodz {{store}}\n\nYour booking reference is {{bookingRef}}.\n\nThanks,\nRodz Auto"
  },
  "bookingConfirmedTemplate": {
    "subject": "Booking confirmed — {{date}}",
    "body": "Hi {{firstName}},\n\nYour booking is confirmed.\n\nVehicle: {{vehicle}} ({{rego}})\nServices: {{services}}\nDate: {{date}} — {{slot}}\nDrop-off: {{dropOffTime}}\nTech: {{techName}}\nStore: Rodz {{store}}\n\nSee you then!\nRodz Auto"
  },
  "workCommencedTemplate": {
    "subject": "Work has started on your {{vehicle}}",
    "body": "Hi {{firstName}},\n\nJust letting you know that work has started on your {{vehicle}} ({{rego}}).\n\nJob: {{jobNumber}}\nTechnician: {{techName}}\nStore: Rodz {{store}}\n\nWe'll let you know as soon as it's ready.\n\nRodz Auto"
  },
  "workCompleteTemplate": {
    "subject": "Your {{vehicle}} is ready for pickup",
    "body": "Hi {{firstName}},\n\nGreat news — your {{vehicle}} ({{rego}}) is ready for collection from Rodz {{store}}.\n\nJob: {{jobNumber}}\nServices completed: {{services}}\n\nThanks for choosing Rodz Auto!"
  },
  "quoteTemplate": {
    "subject": "Your quote from Rodz Auto",
    "body": "Hi {{firstName}},\n\nPlease find your quote attached.\n\nVehicle: {{vehicle}} ({{rego}})\nStore: Rodz {{store}}\n\nThanks,\nRodz Auto"
  }
}
```

A `200` response means it's saved. Emails will fire on the next qualifying event.

---

## Verification checklist

Before going live, test end to end:

- [ ] SES identity status is **Verified** in the ap-southeast-2 console
- [ ] Production access has been approved (check Account dashboard — sandbox badge gone)
- [ ] `PUT /settings/email-templates` returned `200`
- [ ] Create a test booking → customer receives booking received email
- [ ] Confirm the booking → customer receives booking confirmed email
- [ ] Set a job to `in_progress` → customer receives work commenced email
- [ ] Set a job to `completed` → customer receives work complete email

---

## Troubleshooting

**Emails not sending but no API errors**
- Email failure is intentionally silent — the API never returns an error for a failed send.
- Check CloudWatch logs for the Lambda that triggered the send (`BookingCreate`, `BookingUpdate`, or `JobUpdate`). Look for any SES-related error in the log stream.

**`MessageRejected: Email address is not verified`**
- You're in sandbox mode and the recipient address hasn't been verified. Either request production access or temporarily verify the test recipient address in SES.

**`InvalidClientTokenId` or credential errors**
- The Lambda's IAM role is missing `ses:SendEmail`. Run `npx cdk deploy` — the CDK stack grants this automatically via `needsSes: true`.

**Templates not rendering variables**
- Unrecognised `{{variables}}` are left as-is. Check the variable names against the table in `docs/email-templates.md`.

**Wrong region**
- SES must be set up in `ap-southeast-2`. Verifying a domain in `us-east-1` won't help — the Lambda sends from Sydney.

---

## Future: adding new email triggers

To add a new email type (e.g. quote sent, appointment reminder):

1. Add a new template key to `src/settings/email-templates/update.ts` (`REQUIRED_TEMPLATES` array)
2. Add a new export to `src/shared/emailTemplates.ts` following the existing pattern
3. Call it from the relevant handler
4. Update `PUT /settings/email-templates` call to include the new template key
5. Document new variables in `docs/email-templates.md`
