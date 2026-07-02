# Rodz Digital Logbook — Product Strategy

## What it is

A digital service history product for vehicle owners. Every service, every part, every inspection — in one place, tied to the vehicle not the workshop.

Free for Rodz customers. Paid for everyone else.

---

## The problem it solves

There is no good consumer digital logbook product in Australia. When someone sells a car, they dig through a folder of paper receipts and hope they haven't lost any. When they buy a car, they take the seller's word for the service history. NRMA and RACV offer service reminders but not a real logbook. Apps like MyAutoRecords exist but have no workshop integration — the user enters everything manually.

The opportunity is a logbook that auto-populates from real workshop job data, with an AI profile layered on top, that follows the vehicle for its entire life regardless of where it gets serviced.

---

## Tier model

### Free — Rodz customers

Available to anyone who has a vehicle serviced at a Rodz workshop, or who signs up via the website or booking form.

| Feature | Included |
|---------|----------|
| Full Rodz service history (auto-populated from jobs) | ✓ |
| AI vehicle profile (specs, known issues, ownership costs) | ✓ |
| AI maintenance recommendations | ✓ |
| Service due reminders | ✓ |
| Shareable logbook link (read-only token) | ✓ |
| Manual entries from other workshops | ✗ |
| Receipt uploads | ✗ |
| PDF export | ✗ |

The free tier has genuine standalone value — it's not a crippled trial. Rodz service history auto-populates every time a job is completed. The customer doesn't have to do anything.

### Paid — Universal logbook

For customers who want a complete lifetime record regardless of which workshop they use.

| Feature | Included |
|---------|----------|
| Everything in Free | ✓ |
| Manual entries from any workshop | ✓ |
| Receipt photo uploads | ✓ |
| PDF export (for resale documentation) | ✓ |
| Multi-vehicle management | ✓ |

**Pricing model:** per-person, not per-vehicle. One subscription covers all their vehicles. This is better for families, fleet owners, and people who upgrade cars regularly — and it's simpler to explain.

**Suggested price point:** $8–12/month or $80–100/year. Positions it as a coffee-a-month product. At resale, a complete digital logbook can add hundreds to thousands to a vehicle's value — the paid tier pays for itself many times over on one sale.

---

## The data moat — why this is defensible

A competitor can copy the technology. They can build a booking system, an AI vehicle profile, a digital logbook. None of that is hard to replicate with enough money.

What they cannot copy is the history already inside a customer's logbook.

Once a customer has two years of service records in there — Rodz jobs auto-populated, invoices from other workshops uploaded, AI recommendations tracking their vehicle over time — that data belongs to them and lives in Rodz. A competitor launching a better-looking logbook app tomorrow offers them nothing but a blank page. Nobody starts over voluntarily.

This is the same reason people don't switch email providers, banks, or photo libraries. The switching cost isn't the product — it's the accumulated history inside it. Every month a customer stays on the logbook, that history gets deeper and the cost of leaving goes up.

The technology is the entry point. The data is the moat.

And if a direct competitor does copy the logbook product — good. Their customers will upload their invoices, build their history, and when a Rodz store opens near them, they already have an account. The competitor just did the customer acquisition for us.

---

## The "free with Rodz" mechanic is a retention tool

Once a customer's Rodz service history lives in their logbook, switching to another workshop means their history stops auto-populating. They'd have to manually enter future services on the paid tier. That friction is subtle but real — it rewards loyalty without punishing disloyalty explicitly.

The logbook becomes a reason to keep coming back to Rodz even if a competitor is slightly cheaper or more convenient. The accumulated history has personal value.

---

## Acquisition funnels

Multiple entry points, all leading to the same customer record in the workshop system.

### 1. Booking (existing)
When a customer books online, a logbook token is provisioned on their vehicle automatically. They receive a "view your logbook" link in their booking confirmation email. No signup required — they're already in.

### 2. Website signup
A standalone "Create your free logbook" page on the Rodz website. Collects name, email, mobile, rego, and vehicle description. Takes 60 seconds. No booking required. Immediately creates a customer record and vehicle in the workshop system.

This is the lightest-touch way to enter the ecosystem — the customer gets value (AI profile, maintenance recommendations) without committing to a booking.

### 3. Guerrilla campaign (sticker + card)
Staff photograph vehicles in car parks. For each one, a personalised sticker and an accompanying card are printed and left under the windscreen wiper — nothing is adhered to the car.

The card explains the product: *"Like a Facebook profile for your car — every service, every part, your full history in one place."* The sticker goes in the glovebox, where it lives alongside the rego papers. Every visit to any mechanic from that day forward, the sticker is right there.

The QR code is permanent — it links to that vehicle's logbook for life, not just the initial claim. A customer who scans it six months later at a different mechanic still lands on their full history.

This is a cold acquisition channel — no prior relationship needed. Full details in `vehicle-scan-campaign-architecture.md`.

### 4. Referral / resale
When a customer shares their logbook link with a potential buyer (at resale), the buyer lands on a read-only logbook. A prompt at the bottom: "Want one for your new car? Create your free logbook." One tap converts a buyer into a new user.

### 5. Workshop partner network
Independent workshops license the Rodz technology stack under their own brand. Their jobs auto-populate their customers' logbooks. Their customers get the same AI profile and maintenance recommendations. The workshop gets enterprise-grade management software without building it themselves.

Full details below.

---

## The data flywheel

Every vehicle that enters the system — through any acquisition channel — adds to a growing picture of what's on the road in each market.

**What accumulates over time:**

- **Geographic demand signal:** customer postcodes show where vehicle owners are concentrated without a nearby Rodz store. High-density clusters without a store = candidate locations for expansion.
- **Vehicle fleet data:** which makes, models, and years are most common in each area. Useful for parts inventory decisions — if 40% of logbook vehicles in Frankston are Toyota RAV4s, that store should stock RAV4 parts.
- **Service pattern data:** average time between services by make/model/age. Feeds the AI recommendation engine with real-world data rather than just manufacturer specs.
- **Common failure data:** what repairs come up most frequently, at what odometer. Over time this makes the "known issues" section of the vehicle profile genuinely accurate for Australian conditions rather than just Gemini's training data.

None of this requires selling data or doing anything unusual with it. It accumulates as a natural by-product of running the logbook.

---

---

## Rollout priority — 500 owned stores

The goal is 500 Rodz-owned stores. No franchises, no white-labelling the workshop system. Every store is Rodz-operated, running the same technology, maintaining the same standards.

The technology is built for Rodz's own network first and stays exclusive to it. The core workshop management system — job board, booking engine, staff portal, AI recommendations, quoting, invoicing — is a competitive advantage that does not leave the Rodz ecosystem. Competitors do not get access to it.

**The logbook data guides expansion.** Every signup tells you where demand is. High logbook user density in a postcode without a nearby Rodz store is the signal to open there next. This replaces guesswork and expensive site selection consulting with a demand map generated by your own product. By the time you're at 50 stores, you'll know exactly where stores 51 through 100 should go.

**The IPO story.** At scale, Rodz is not just a workshop chain — it's a tech-enabled service network with a proprietary customer data asset, a growing recurring revenue stream from the logbook, and a proven data-driven expansion playbook. That is a fundamentally different valuation than a traditional workshop business. Investors price recurring revenue and data assets differently to service revenue alone.

---

## Adding external service records — customer invoice upload

Other workshops don't need to know the logbook exists. The customer adds their own records by photographing the invoice.

### How it works

1. Customer opens their logbook on their phone
2. Taps "Add service"
3. Takes a photo of the invoice (or uploads from camera roll)
4. Enters their odometer reading at time of service
5. Submits

Gemini reads the invoice image and extracts everything automatically:

- Workshop name and address
- Service date
- Services performed (line items)
- Total cost
- Any parts listed

The logbook entry is created instantly. The invoice photo is stored as proof. The customer never has to type anything except the odometer.

### Why this is better than a partner API

A partner API requires the other workshop to integrate, agree to terms, and actively participate. Most small independent workshops won't do that.

Invoice upload requires nothing from the other workshop. It works for every workshop that has ever existed or will ever exist — the local mechanic, the dealer, the tyre shop, the roadside assist job. The customer is in full control of their own history.

The other workshop never knows their invoice is in a Rodz product. They don't need to.

### What Gemini extracts from an invoice

```json
{
  "workshopName":  "Smith's Automotive",
  "workshopAddress": "42 High St, Moorabbin VIC 3189",
  "serviceDate":   "2026-06-15",
  "services": [
    "Engine Oil & Filter Change",
    "Tyre Rotation",
    "Brake Fluid Top-Up"
  ],
  "parts": [
    "Penrite 5W-30 Full Synthetic 5L",
    "Oil Filter — Ryco Z9"
  ],
  "totalCost":     195.00,
  "invoiceNumber": "INV-4821"
}
```

Customer confirms or edits the extracted data before saving. The invoice photo is attached to the entry as a receipt.

### What this means for the data asset

Every uploaded invoice is a real service record from a real workshop for a real vehicle. Over time the logbook accumulates a picture of:

- Which non-Rodz workshops customers use and how often
- What services are being done elsewhere (opportunity to win back)
- Average spend per service at other workshops vs Rodz
- Service frequency gaps — a customer who hasn't logged anything in 14 months is overdue

None of this requires any external integration. It flows naturally from customers maintaining their own records.

### This is a paid tier feature

Invoice upload is part of the paid universal logbook. Free tier customers see their Rodz history only. Upgrading to paid unlocks the ability to add records from any workshop — giving them a complete lifetime history in one place, which is the primary value proposition at resale time.

---

## What needs to be built

Technical architecture is documented in `customer-logbook-architecture.md`. At a product level, the build breaks into three stages:

### Stage 1 — Free tier (unblocks all acquisition channels)
- Customer auth (email + magic link login)
- Logbook read view (Rodz service history)
- Vehicle AI profile page
- Maintenance recommendations
- Shareable logbook token
- Auto-provision logbook on booking confirmation

### Stage 2 — Paid tier
- Stripe subscription integration
- Manual entry creation (other workshops, self-service)
- Receipt photo upload
- PDF export

### Stage 3 — Growth surface
- QR sticker campaign (see `vehicle-scan-campaign-architecture.md`)
- Website standalone signup page
- Referral flow (buyer lands on shared logbook → prompted to create own)
- Demand heatmap report for management (`GET /reports/logbook-demand`)

---

## What Rodz gets

| Benefit | How |
|---------|-----|
| Larger customer database | Every signup = a customer record with vehicle, location, contact details |
| Consumer recurring revenue | Paid logbook subscriptions independent of service bookings |
| Logbook API revenue | Small monthly fee per external workshop for record submission access |
| Customer retention | Accumulated history creates switching cost back to Rodz |
| Expansion intelligence | Logbook demand data by postcode tells you exactly where to open next |
| Cold acquisition channel | Guerrilla campaign reaches prospects who have never heard of Rodz |
| Network effect | More complete logbooks = more valuable product = stronger retention |
| IPO story | Tech-enabled network with recurring revenue and a proprietary data asset |

---

## What the customer gets

A complete, permanent record of their vehicle's service history that:
- Auto-populates every time they service at Rodz (free, zero effort)
- Travels with the vehicle when they sell it (adds resale value)
- Works with any workshop if they upgrade to paid
- Includes an AI profile of their specific car
- Tells them what's coming up before it becomes urgent

The value is clear and immediate. The free tier isn't a teaser — it's a genuinely useful product on its own.
