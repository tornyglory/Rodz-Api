# Job Notes + Card Empty-State — Frontend Brief

Fixes for two errors coming out of the workshop app's job detail page:

```
CORS error → GET https://fzzrkscwd7.execute-api.ap-southeast-2.amazonaws.com/jobs/30/notes
404        → GET https://fzzrkscwd7.execute-api.ap-southeast-2.amazonaws.com/jobs/30/card
```

Backend deployed 2026-08-07. Both fixed at source rather than asking
the frontend to change its calls.

---

## Fix 1 — `/jobs/{id}/notes` now exists

**New endpoint, lives on the admin API** (Stack 4, not the shared API):

```
GET https://lukck5txvh.execute-api.ap-southeast-2.amazonaws.com/jobs/{id}/notes
Authorization: Bearer <staff_jwt>
```

Response:
```jsonc
{
  "jobId":           30,
  "customerNotes":   "Customer asked us to check the aircon while it's in",
  "technicianNotes": "Suspension mounts noisy on left rear — flag on next visit"
}
```

Both fields nullable. Store-scoped (super_admin any, others must be on the job's store).

### ⚠ Base URL change

Your app is calling `fzzrkscwd7` (the shared API). The `/jobs/{id}/notes` endpoint is registered on the **admin API** (`lukck5txvh`) because the shared API hit its 300-route cap.

**Action:** update the fetch URL:
- **Before:** `https://fzzrkscwd7.execute-api.ap-southeast-2.amazonaws.com/jobs/30/notes`
- **After:** `https://lukck5txvh.execute-api.ap-southeast-2.amazonaws.com/jobs/30/notes`

Same JWT works on both APIs — no auth changes needed.

### Why the CORS error, not a 404?

When a route doesn't exist on API Gateway, its built-in 404 response
has no CORS headers on it — so the browser blocks the response and
surfaces it as a CORS error. It's confusing, but the real problem was
the missing endpoint, not CORS config.

### Writing notes

There isn't a POST/PATCH on this endpoint yet. Notes get written today
via `PATCH /jobs/{id}` with the `notes` field (updates `customer_notes`).
For technician notes edits from the app, tell me and I'll add
`PATCH /jobs/{id}/notes { customerNotes?, technicianNotes? }`.

---

## Fix 2 — `/jobs/{id}/card` no longer 404s on empty jobs

**Same URL, same base, same JWT** — the handler now returns an empty
card structure instead of 404 when a job has no line items yet.

### Before

```
GET /jobs/30/card
→ 404 Job card not found
```

Happened when:
- Job has no `job_card_items` yet, AND
- No approved quote exists to seed items from

Test bookings without a quote flow (like the ones we've been smoking against) always hit this.

### After

```jsonc
{
  "jobId":       30,
  "allComplete": false,
  "items":       []
}
```

Frontend can render a `"No card items yet — a quote needs to be approved before the mechanic checklist appears"` empty state.

### Note on the checklist

The `job_card_items` table is the OLD checklist model — populated from
approved quote items. **The new step-based checklist** we built for
`service_type_steps` uses a different endpoint:

```
GET /service-jobs/{id}/steps
```

Details in `docs/job-card-checklist-frontend-brief.md`. If the parts
tab was expecting the mechanic's checklist, that's the endpoint you
want — not `/card`.

---

## Summary of what changed

| Change | Backend | Frontend action |
|---|---|---|
| `GET /jobs/{id}/notes` exists | New endpoint on Stack 4 admin API | Change base URL to `lukck5txvh…` for this call |
| `GET /jobs/{id}/card` returns empty when nothing to seed | Handler change | None — 200 responses now handled naturally |

Both live in prod as of 2026-08-07. Give the CORS/404 errors another go — they should be gone.
