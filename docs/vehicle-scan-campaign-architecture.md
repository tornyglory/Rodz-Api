# Vehicle Scan Campaign — Architecture & Implementation Plan

Guerrilla marketing tool. Staff walk a car park or street and photograph vehicles. For each one they print two things: a small sticker with the car's rego and QR code, and an accompanying card. Both are left under the windscreen wiper — nothing is adhered to the car.

The card does the selling. The sticker is the product.

The owner returns to their car, finds the card and sticker under their wiper, reads the card, and understands immediately what they're being offered. The sticker goes in the glovebox — where they already keep their rego papers and insurance. Every time they visit any mechanic from that day forward, the sticker is right there.

Zero interaction with the prospect required at the time of placement.

---

## Flow overview

```
Staff (in car park / street)         Portal / Mobile              API / AI
────────────────────────────         ────────────────             ────────
Open Scan screen
Photograph vehicle front      →      Upload to Cloudflare
                                     Send imageId to API    →    Create scan record (status: processing)
                                                                  Fire VehicleScanEngine async Lambda
                              ←      Return claimToken + QR URL
[move to next car, repeat]

Back at printer
Open batch print view
Select scans to print         →      Render sticker sheet
Print sticker sheet                  (rego + QR per sticker)

Return to car park
Place sticker on windscreen

                                                                      [VehicleScanEngine running]
                                                                        Fetch image from Cloudflare
                                                                        Gemini Vision → rego, make,
                                                                          model, year, colour, condition
                                                                        Gemini → profile, service recs,
                                                                          resale estimate, similar vehicles
                                                                        Update scan record (status: ready)

Customer scans QR
                                     Landing page loads        →      GET /c/scan/:token
                              ←                                       Vehicle profile, recs, resale, similar
Customer fills claim form
  name / email / phone        →      POST /c/scan/:token/claim
                                                                      Create customer record
                                                                      Create vehicle record (if new)
                                                                      Link vehicle → customer
                                                                      Generate logbook_token
                                                                      Send welcome email with login link
                              ←      { success, logbookUrl }
```

---

## Database — one new table

### `campaign_scans`

```sql
CREATE TABLE campaign_scans (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  store_id        INT UNSIGNED    NOT NULL,
  staff_id        BIGINT UNSIGNED NOT NULL,
  image_id        VARCHAR(100)    NOT NULL,   -- Cloudflare Images ID
  claim_token     VARCHAR(64)     NOT NULL UNIQUE,
  status          ENUM('processing','ready','claimed') NOT NULL DEFAULT 'processing',

  -- Extracted from image by Gemini Vision
  rego            VARCHAR(10)     NULL,
  rego_state      VARCHAR(3)      NULL,
  make            VARCHAR(80)     NULL,
  model           VARCHAR(80)     NULL,
  year            SMALLINT        NULL,
  colour          VARCHAR(40)     NULL,
  condition_grade ENUM('excellent','good','fair','poor') NULL,
  condition_notes TEXT            NULL,

  -- AI-generated content (stored as JSON, served to landing page)
  vehicle_profile        JSON NULL,   -- { overview, engineSpecs, tyreSpecs, knownIssues }
  service_recommendations JSON NULL,  -- [{ title, description, urgency, estimatedCostMin, estimatedCostMax }]
  resale_estimate        JSON NULL,   -- { low, mid, high, currency: 'AUD', note }
  similar_vehicles       JSON NULL,   -- [{ make, model, year, priceRangeAUD }]

  -- After customer claims
  customer_id     BIGINT UNSIGNED NULL,
  vehicle_id      BIGINT UNSIGNED NULL,
  claimed_at      DATETIME        NULL,

  -- Card lifecycle
  qr_printed_at   DATETIME        NULL,
  created_at      DATETIME        NOT NULL DEFAULT NOW(),

  FOREIGN KEY (store_id) REFERENCES stores(id),
  FOREIGN KEY (staff_id) REFERENCES staff(id)
);
```

No other schema changes needed. When a scan is claimed, the vehicle is created in the main `vehicles` table and linked via `vehicle_owners` exactly as a normal booking does — so the logbook and AI recommendation engines work immediately.

---

## Staff-side API endpoints (authenticated)

### `POST /campaigns/scans` — create a scan

Staff uploads the photo via the existing Cloudflare direct-upload pattern (same as quote photos), then calls this endpoint with the resulting `imageId`.

**Request:**
```json
{
  "imageId": "abc123-cloudflare-id",
  "storeId": 1
}
```

**Logic:**
1. Verify `imageId` exists in Cloudflare (`verifyImage` helper — already built)
2. Insert `campaign_scans` row with `status = 'processing'`, generate `claim_token` (64 random hex chars)
3. Fire `VehicleScanEngine` Lambda asynchronously with `{ scanId }`
4. Return immediately — staff doesn't wait for AI

**Response — 201:**
```json
{
  "scan": {
    "id":         12,
    "status":     "processing",
    "imageUrl":   "https://imagedelivery.net/.../public",
    "claimToken": "a3f9c2...",
    "qrUrl":      "https://logbook.rodz.com.au/scan/a3f9c2...",
    "createdAt":  "2026-07-01T10:00:00Z"
  }
}
```

The frontend renders the QR code from `qrUrl` using a client-side library (e.g. `qrcode.js`) — no server-side QR generation needed. Staff print the card directly from the browser.

---

### `GET /campaigns/scans/:id` — poll for processing status

Staff can refresh to see when the AI is done (usually 5–10 seconds).

**Response when ready:**
```json
{
  "scan": {
    "id":      12,
    "status":  "ready",
    "rego":    "ABC123",
    "make":    "Toyota",
    "model":   "Camry",
    "year":    2019,
    "colour":  "Silver",
    "conditionGrade": "good",
    "imageUrl": "https://imagedelivery.net/.../public",
    "claimToken": "a3f9c2...",
    "qrUrl":   "https://logbook.rodz.com.au/scan/a3f9c2...",
    "claimed": false
  }
}
```

---

### `GET /campaigns/scans` — list all scans for a store

Paginated list. Supports `?status=ready&status=claimed&store=1`.

Shows staff which cars have QR cards placed, which have been claimed, and how many prospects have engaged.

---

### `PATCH /campaigns/scans/:id` — mark card as printed

```json
{ "qrPrinted": true }
```

Sets `qr_printed_at = NOW()`. Used to track the card lifecycle.

---

## AI engine — `VehicleScanEngine` Lambda

A new async-only Lambda (no HTTP route). Invoked by `CampaignScanCreate` with `{ scanId }`.

### Step 1 — Fetch image

Fetch the photo from Cloudflare Images as a binary buffer, convert to base64. The image URL is `https://imagedelivery.net/{accountHash}/{imageId}/public`.

### Step 2 — Gemini Vision: extract vehicle identity

Send the image + prompt to `gemini-2.5-flash` (multimodal — already in the project via `@google/generative-ai`).

```
You are an Australian automotive expert reviewing a photograph of a vehicle taken from the front.

From this image extract:
1. The Australian number plate text and state (if visible)
2. Make, model, approximate year, colour
3. Visible condition: excellent / good / fair / poor
4. Any visible issues (damage, rust, worn condition)

Return JSON only:
{
  "rego": string or null,
  "regoState": "VIC"|"NSW"|"QLD"|"SA"|"WA"|"TAS"|"NT"|"ACT"|null,
  "make": string,
  "model": string,
  "year": integer or null,
  "colour": string or null,
  "conditionGrade": "excellent"|"good"|"fair"|"poor",
  "conditionNotes": string
}
```

### Step 3 — Gemini text: generate content

A second Gemini call (text only, faster) using the extracted make/model/year to generate the landing page content:

```
You are an Australian automotive expert. Generate a detailed profile for a {year} {make} {model}.

Return JSON only:
{
  "vehicleProfile": {
    "overview": string (2-3 sentences about this model),
    "engineSpecs": string,
    "tyreSpecs": string,
    "knownIssues": string (common problems owners report),
    "ownershipCost": string (annual running cost estimate in AUD)
  },
  "serviceRecommendations": [
    {
      "title": string,
      "description": string,
      "urgency": "overdue"|"due_soon"|"upcoming",
      "estimatedCostMin": integer (AUD),
      "estimatedCostMax": integer (AUD)
    }
  ],
  "resaleEstimate": {
    "low":  integer (AUD),
    "mid":  integer (AUD),
    "high": integer (AUD),
    "note": string (e.g. "Based on current Australian market data for this condition grade")
  },
  "similarVehicles": [
    {
      "make":  string,
      "model": string,
      "year":  integer,
      "priceRangeAUD": string (e.g. "$18,000 – $24,000")
    }
  ]
}

Condition grade for this vehicle: {conditionGrade}
Tailor service recommendations to Australian conditions and this vehicle's age.
Return 3–5 service recommendations, ordered by urgency.
Return 3 similar vehicles the customer might also consider.
```

### Step 4 — Update the scan record

```sql
UPDATE campaign_scans
SET status = 'ready',
    rego = ?, rego_state = ?, make = ?, model = ?, year = ?, colour = ?,
    condition_grade = ?, condition_notes = ?,
    vehicle_profile = ?, service_recommendations = ?,
    resale_estimate = ?, similar_vehicles = ?
WHERE id = ?
```

If Gemini fails (bad image, no plate visible), set `status = 'ready'` with whatever was extracted — the landing page degrades gracefully.

---

## Public API endpoints (no auth — token only)

### `GET /c/scan/:token` — landing page data

Called when the customer scans the QR code.

**Response:**
```json
{
  "scan": {
    "make":   "Toyota",
    "model":  "Camry",
    "year":   2019,
    "colour": "Silver",
    "imageUrl": "https://imagedelivery.net/.../public",
    "conditionGrade": "good",
    "vehicleProfile": {
      "overview": "The Toyota Camry is one of Australia's most reliable family sedans...",
      "engineSpecs": "2.5L 4-cylinder, 135kW, CVT automatic",
      "tyreSpecs": "215/55R17",
      "knownIssues": "Minor oil consumption on higher-mileage examples...",
      "ownershipCost": "Approximately $2,800/year in running costs"
    },
    "serviceRecommendations": [
      {
        "title": "Log Book Service",
        "description": "Toyota recommends servicing every 15,000km or 12 months",
        "urgency": "due_soon",
        "estimatedCostMin": 220,
        "estimatedCostMax": 320
      },
      {
        "title": "Brake Inspection",
        "description": "Brake pads typically need attention at 60,000–80,000km",
        "urgency": "upcoming",
        "estimatedCostMin": 180,
        "estimatedCostMax": 350
      }
    ],
    "resaleEstimate": {
      "low":  18000,
      "mid":  22000,
      "high": 26000,
      "note": "Based on current Australian market data for good condition"
    },
    "similarVehicles": [
      { "make": "Mazda",  "model": "6",     "year": 2019, "priceRangeAUD": "$18,000 – $25,000" },
      { "make": "Honda",  "model": "Accord","year": 2019, "priceRangeAUD": "$20,000 – $27,000" },
      { "make": "Subaru", "model": "Liberty","year": 2019,"priceRangeAUD": "$17,000 – $23,000" }
    ],
    "claimed": false,
    "store": "Rodz Somerville"
  }
}
```

If `status = 'processing'`, return `{ "status": "processing" }` — landing page shows a loading state.

If `claimed = true`, return the same data but suppress the claim form (show "You've already claimed this logbook — check your email").

---

### `POST /c/scan/:token/claim` — customer claims the vehicle

**Request:**
```json
{
  "firstName": "Jane",
  "lastName":  "Smith",
  "email":     "jane@example.com",
  "mobile":    "0412 345 678"
}
```

**Logic:**
1. Fetch scan by token — must be `status = 'ready'` (not already `claimed`)
2. Find or create customer in `customers` table by email
3. If scan has a rego, check `vehicles` table for existing match. If found, use it. If not, create a new vehicle record from the scan's make/model/year/colour
4. Insert `vehicle_owners` row linking vehicle → customer
5. Generate `logbook_token` on the vehicle (64 hex chars) if not already set
6. Update scan: `status = 'claimed'`, `customer_id`, `vehicle_id`, `claimed_at = NOW()`
7. Send welcome email to customer with:
   - Logbook link (`https://logbook.rodz.com.au/l/{logbook_token}`)
   - "Set your password" magic link so they can create a full account
   - The vehicle profile summary
8. Notify the store (staff notification) that the campaign vehicle was claimed

**Response — 200:**
```json
{
  "message": "Welcome Jane — your logbook is ready.",
  "logbookUrl": "https://logbook.rodz.com.au/l/a3f9c2..."
}
```

---

## Portal UI — what needs to be built

### Scan screen (Campaigns → Vehicle Scans)

**Capture flow (designed for speed — staff are in a car park):**
1. Large camera button → Cloudflare direct upload (same flow as quote photos)
2. Immediately moves to next capture — no waiting. Processing runs in background.
3. Scans queue up in a list below, status updates in real time (processing → ready)

**Batch print (back at the printer):**
1. Scan list shows all ready scans with checkboxes
2. Staff select a batch (or "select all ready")
3. **Print Pack** button renders a combined print sheet — stickers on one page, cards on another
4. On print: batch-marks those scans as `qr_printed_at = NOW()`

---

### The sticker

Credit card size or slightly larger. Designed to sit on the inside of a glovebox lid or tucked in with registration papers.

Contains:
- Rego plate text (large, prominent)
- QR code linking to `https://logbook.rodz.com.au/scan/{claimToken}`
- "rodz.com.au" in small text
- Rodz logo

The QR code is permanent — it links to this specific vehicle's logbook for life, not just the initial claim flow. After the customer claims their logbook the same QR still works, taking them straight to their vehicle profile.

Printed on standard Avery credit card label sheets — no special hardware needed.

---

### The card

Business card or postcard size. Left under the wiper alongside the sticker. This is what gets read first.

**Front:**
```
This is your vehicle's digital logbook.

Like a Facebook profile for your car — every service,
every part, your full history in one place.

Stick the sticker in your glovebox.
Scan it anytime to see your vehicle profile,
service reminders, and record new services.

It's free.
```

**Back:**
- Rodz logo, address, phone
- "Powered by Rodz Workshop" — establishes who left it and why

The card answers the question "what is this and why is it on my car?" before the person even touches the sticker. The tone is helpful, not salesy. They're being given something, not sold to.

Printed on standard business card stock — same Avery sheet approach, 10 per A4.

**Scan list:**
- Columns: photo thumbnail, vehicle (make/model/year), rego, date, status, printed, claimed
- Filter by status, date range, store
- Claimed scans show customer name — tap to open their customer profile in the portal

---

## New Lambdas

| Lambda | Route | Notes |
|--------|-------|-------|
| `CampaignScanCreate` | `POST /campaigns/scans` | Staff endpoint, fires async engine |
| `CampaignScanGet` | `GET /campaigns/scans/:id` | Staff poll endpoint |
| `CampaignScanList` | `GET /campaigns/scans` | Staff list endpoint |
| `CampaignScanUpdate` | `PATCH /campaigns/scans/:id` | Mark printed etc. |
| `VehicleScanEngine` | *(no route — async only)* | Gemini Vision + profile generation |
| `PublicScanGet` | `GET /c/scan/:token` | Public landing page data |
| `PublicScanClaim` | `POST /c/scan/:token/claim` | Customer claim form |

All staff routes go in `RodzApiStack2` with the existing `authorizer`. Public routes go in `RodzApiStack2` with no authorizer. `VehicleScanEngine` is registered as a Lambda only (no API Gateway route), invoked async from `CampaignScanCreate`.

---

## Integration with existing systems

| Existing system | How it connects |
|-----------------|-----------------|
| Cloudflare Images | Photo stored via existing `getDirectUploadUrl` + `verifyImage` helpers |
| Gemini (`gemini-2.5-flash`) | Already in project — extend to multimodal image input |
| `customers` table | Claim creates/finds customer exactly as `POST /book` does |
| `vehicles` + `vehicle_owners` | Claim creates vehicle + link exactly as `POST /book` does |
| `logbook_token` on vehicles | Generated on claim — customer gets immediate logbook access |
| `VehicleProfileEngine` Lambda | Can optionally be fired after claim to backfill the `vehicle_model_profiles` table (powers the in-app logbook profile) |
| `AIRecommendationEngine` Lambda | Fired after claim — populates `ai_recommendations` for the customer's logbook |
| Staff notifications | Store gets a notification when their campaign vehicle is claimed |
| Welcome email | SES — same infrastructure as booking confirmation emails |

---

## Implementation sequence

### Phase 1 — Scan creation + QR card
1. DB migration: `campaign_scans` table
2. `VehicleScanEngine` Lambda — Gemini Vision identity extraction + profile generation
3. `CampaignScanCreate` Lambda — `POST /campaigns/scans`
4. `CampaignScanGet` Lambda — `GET /campaigns/scans/:id` (poll)
5. Portal: upload → spinner → QR card print UI

### Phase 2 — Public landing page
6. `PublicScanGet` Lambda — `GET /c/scan/:token`
7. Customer-facing landing page (separate frontend, or same frontend at `/scan/:token`)

### Phase 3 — Customer claim
8. `PublicScanClaim` Lambda — `POST /c/scan/:token/claim`
9. Welcome email template with logbook link + set-password link
10. Staff notification on claim

### Phase 4 — Campaign management
11. `CampaignScanList` + `CampaignScanUpdate` Lambdas
12. Portal scan list table with stats (scanned, printed, claimed conversion rate)

---

## Notes

**Plate visibility:** if the plate is not readable in the image (angle, glare, obscured), Gemini returns `rego: null` and the landing page still works — it just shows make/model/year without a specific rego. Staff can manually enter the rego on the scan record via the portal.

**Resale value accuracy:** Gemini's estimate is based on training data and is good enough for a marketing tool. For production accuracy, RedBook has an Australian API (`redbook.com.au/api`) that returns exact valuations by make/model/year/badge/odometer. Can be swapped in as a later enhancement.

**Privacy:** the vehicle photo and AI-generated data are stored but the customer's personal details are only collected at the claim step — no personal data is held for unclaimed vehicles.

**QR card design:** entirely client-side — the portal renders a print-ready card using CSS `@media print`. No server involvement needed for the physical card.
