# Customer Purge — Frontend Brief

Permanently deletes a customer and every record tied to them across the entire system. This is a hard delete — there is no undo, no recovery, and no soft-delete fallback.

**Base URL:** `https://fzzrkscwd7.execute-api.ap-southeast-2.amazonaws.com`

---

## Endpoint

```
DELETE /customers/{id}/purge
Authorization: Bearer <accessToken>
```

No request body.

**Super admin only.** Any other role returns `403`.

---

## What gets deleted

Everything runs inside a single database transaction. If anything fails, the entire operation rolls back — nothing is touched. The customer row is deleted last, after all related data has been removed.

### Customer account
- Customer record
- Auth credentials, sessions, OAuth providers (Apple / Google login)

### Activity & communications
- Tags (`New`, `Regular`, `VIP`)
- Communications log (calls, emails, notes)
- Notifications sent to the customer
- Loyalty points and transaction history
- Reviews

### AI & reminders
- All AI-generated maintenance recommendations
- All service reminders

### Financial records
- All invoices, line items, and payments
- All quotes and quote line items
- Vehicle service log entries (linked to invoices)

### Jobs & bookings
- All service jobs
- Job line items, parts ordered, staff assignments
- Job card checklist items
- Job inspection results
- Job documents
- All bookings and booking service records
- Pickup notification records

### Warranty
- All warranty claims

### Vehicle (if exclusively owned)
If this customer is the **sole ever owner** of a vehicle, the vehicle itself is also deleted along with:
- Vehicle service history
- AI vehicle chats and all chat messages
- All photos attached to the vehicle

> If a vehicle has had more than one owner across its lifetime, it is **not** deleted. Only this customer's ownership record is removed. Chats on shared vehicles are also left — they have no customer link so cannot be attributed to one owner.

### Photos (Cloudflare Images)
All photos attached to this customer's invoices, quotes, and exclusive vehicles are deleted from Cloudflare Images storage after the database transaction commits.

### What is NOT deleted
| Item | Reason |
|------|--------|
| Purchase orders | Belong to the workshop, not the customer. The link to the job is cleared but the PO stays. |
| Vehicle model profiles | Shared AI profiles for a make/model/year — not customer-specific. |
| Chats on shared vehicles | No customer ID on the chat record — cannot be attributed to one person. |
| Audit log | Kept for compliance and traceability. |

---

## Request

```
DELETE /customers/42/purge
Authorization: Bearer <accessToken>
```

No body.

---

## Response `200`

```json
{
  "deleted": true,
  "customerId": 42,
  "imagesDeleted": 6,
  "imagesFailed": 0
}
```

| Field | Type | Notes |
|-------|------|-------|
| `deleted` | boolean | Always `true` on success |
| `customerId` | number | The ID that was purged |
| `imagesDeleted` | number | Cloudflare images successfully removed |
| `imagesFailed` | number | Cloudflare deletions that failed — see notes below |

---

## Errors

| Status | Code | When |
|--------|------|------|
| `403` | `FORBIDDEN` | Not super admin |
| `404` | `NOT_FOUND` | Customer ID does not exist |
| `500` | — | Database error — transaction rolled back, nothing was deleted |

---

## Image cleanup behaviour

Cloudflare image deletion runs **after** the database transaction commits — never before. This means:

- If the DB transaction fails → nothing is deleted anywhere (DB or Cloudflare)
- If the DB succeeds but Cloudflare fails → `imagesFailed` will be non-zero. The customer data is gone but those specific images may still exist in Cloudflare storage and would need manual cleanup via the Cloudflare dashboard.

---

## UI guidance

### Show the button
Only render the purge option for `super_admin` users. Do not show it at all for `store_manager` or `technician`.

### Confirmation dialog
Always require explicit confirmation before calling the endpoint. Suggested copy:

> **Permanently delete [Customer Name]?**
>
> This will delete their account, all vehicles they solely own, every invoice, quote, job, booking, photo, AI recommendation, and service history record. This cannot be undone.
>
> [Cancel] [Delete permanently]

### On success
- Redirect away from the customer page immediately
- Show a success toast: **"[Name] and all their data has been permanently deleted"**
- If `imagesFailed > 0`: show an additional warning toast: **"[n] photo(s) could not be removed from storage — contact support to clean these up manually"**

### On error
| Status | UI |
|--------|----|
| `403` | Should not be reachable — hide the button for non super_admin |
| `404` | Show error: "Customer not found" |
| `500` | Show error: "Something went wrong — no data was deleted. Please try again." |
