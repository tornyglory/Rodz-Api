# Two API base URLs — where each route lives

There are now **two API Gateway HttpApis** in front of the Rodz backend. The frontend needs one env var per base. Getting the wrong base is the most common cause of "CORS error" reports on new endpoints — see § Diagnosing the CORS mirage below.

## The two bases

| Env var | Base URL | Serves |
|---------|----------|--------|
| `API_BASE` | `https://fzzrkscwd7.execute-api.ap-southeast-2.amazonaws.com` | Everything customer-facing: `/c/…`, `/logbook/…`, `/vehicles/…`, `/quotes/…`, `/bookings/…`, `/customers/…`, `/staff/…` (staff CRUD), `/photos/…`, etc. |
| `ADMIN_API_BASE` | `https://lukck5txvh.execute-api.ap-southeast-2.amazonaws.com` | Admin-only surfaces: `/reports/…`, `/admin/…`. Currently: attribution report + vehicle-catalog admin. |

`ADMIN_API_BASE` matches the CloudFormation output name (`RodzApiStack4.AdminApiUrl`) — pull it from there in your deploy pipeline if you have one.

## Why two

The shared API hit AWS's 300-route quota on that HttpApi. Instead of asking for a quota bump or reshuffling existing routes, admin surfaces get their own API Gateway with its own 300-route budget and stricter CORS (locked to workshop-app origins only, no wildcard).

## Route inventory (as of 2026-08-03)

### Admin API (`ADMIN_API_BASE`)

- `GET /reports/attribution`
- `GET /admin/vehicle-catalog/makes` etc. (see `docs/vehicle-catalog-admin-frontend-brief.md`)

If a route is under `/reports/…` or `/admin/…`, it's on the admin API. Everything else is on the shared API.

### Shared API (`API_BASE`)

Everything documented in `docs/API.md` and every other frontend brief in this repo — customer portal, logbook, workshop, catalog reads, etc.

## CORS setup (already correct)

Both APIs have their own preflight config:

- Shared API — `allowOrigins: ['*', 'https://workshop.rodz.com.au', 'http://localhost:5173', … 5177, 3000]`. Wildcard included as a fallback for the customer app + magic-link viewers.
- Admin API — `allowOrigins: ['https://workshop.rodz.com.au', 'http://localhost:5173', 'http://localhost:5177', 'http://localhost:3000']`. No wildcard — admin surfaces should never be embedded elsewhere.

Both include `GET, POST, PUT, PATCH, DELETE, OPTIONS` and `Content-Type, Authorization, x-api-key`. No new headers to add on the frontend.

## Diagnosing the CORS mirage

The browser will report every wrong-host request as a **CORS error** even when the actual issue is "route doesn't exist on this API." That's because API Gateway's built-in 404 for an unregistered route doesn't emit CORS headers — the browser sees "no `Access-Control-Allow-Origin`" and blames CORS.

Symptom:
```
Access to fetch at 'https://<base>/reports/attribution?...' from origin 'http://localhost:5173'
has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present on the requested resource.
```

Diagnosis:
1. Run a `curl` GET against the same URL — no browser CORS in play. If it returns `404`, the route doesn't exist on that base.
2. Run a `curl -X OPTIONS` preflight — if that returns `204` with proper CORS headers **for a path that doesn't exist**, that's confirmation the HttpApi's global preflight is fine and the real problem is the missing route.
3. Try the request against the other base. Nine times out of ten that fixes it.

Only if the OPTIONS preflight itself is failing is there a real CORS problem to fix (e.g. missing origin, missing method, missing header). Both APIs are currently set up correctly, so any new "CORS" report on a working endpoint is almost certainly a wrong-base issue.

## What to change in the frontend

- Add `ADMIN_API_BASE` alongside the existing `API_BASE` env var.
- Any client / SDK method that hits `/reports/…` or `/admin/…` should use `ADMIN_API_BASE`.
- Send the same `Authorization: Bearer <staffJwt>` header — admin API reuses the staff authorizer Lambda from Stack 1.

That's it. No new tokens, no new headers, no code changes beyond the base URL.
