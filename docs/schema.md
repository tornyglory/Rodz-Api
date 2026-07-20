# Database Schema Reference

Use this when building endpoints. Covers all MySQL tables, key columns, enum values, and relationships. Also documents which data lives outside MySQL (S3 detail, Redis cache) for tables where that split matters.

---

## Three-store model

| Store | What lives there |
|-------|------------------|
| **MySQL** (this file) | Operational data (customers, vehicles, bookings, sessions), aggregate summary tables, and pointers to S3 objects via `s3_event_index` |
| **S3** (`rodz-data-lake` bucket) | Full detail for anything that grows unboundedly — chat messages (`diagnostic-sessions/current/{sessionId}.json`), expense/fuel-fill JSON objects (referenced by `s3_event_index.s3_key`) |
| **Redis** (Upstash) | Hot cache — `subscription:{customerId}`, `customer:{id}:profile`, `vehicle:{id}:context`, rate-limit counters. Never a source of truth. |

Rules: **detail** goes to S3, **aggregates** into summary tables, **pointers** into `s3_event_index`. See `docs/s3-data-lake-backend-brief.md` + `docs/redis-cache-backend-brief.md` for the patterns.

---

## Conventions

**Soft deletes** — pattern varies by table:

| Table | Pattern |
|-------|---------|
| `customers`, `vehicles`, `staff`, `parts`, `suppliers`, `part_names`, `service_types`, `catalog_items` | `is_active = 0` |
| `bookings` | `cancelled_at = NOW()` — filter with `cancelled_at IS NULL` |
| `purchase_orders` | `deleted_at = NOW()` + `status = 'cancelled'` — filter with `deleted_at IS NULL` |

**Generated columns** — MySQL computes these; never include in INSERT or UPDATE:

| Table | Column | Expression |
|-------|--------|------------|
| `quote_items` | `line_total` | `quantity * unit_price` |
| `service_job_items` | `line_total` | `quantity * unit_price` |
| `purchase_order_items` | `line_total` | `quantity_ordered * unit_cost` |

**Key relationships:**

- `quotes.booking_id` → `bookings.id` (nullable — quotes can exist without a booking)
- `service_jobs.booking_id` → `bookings.id` (nullable)
- `service_jobs.quote_id` → `quotes.id` (nullable — direct link; also derivable via `quotes.booking_id`)
- `purchase_order_items.service_job_id` → `service_jobs.id` (nullable — links PO items to a job)
- `vehicle_owners` is the join table between `vehicles` and `customers`; `is_current = 1` is the active owner
- `staff_store_access` controls which stores a staff member can access; filter with `revoked_at IS NULL`

---

## Table index

| Group | Tables |
|-------|--------|
| [Core](#core) | `stores`, `staff`, `customers`, `vehicles`, `vehicle_owners` |
| [Bookings](#bookings) | `bookings`, `booking_services` |
| [Jobs](#jobs) | `service_jobs`, `service_job_items`, `job_parts`, `service_job_staff`, `job_card_items` |
| [Financials](#financials) | `invoices`, `invoice_items`, `payments`, `quotes`, `quote_items`, `purchase_orders`, `purchase_order_items` |
| [Catalog](#catalog) | `service_types`, `catalog_items`, `parts`, `suppliers`, `part_names` |
| [Inspections](#inspections) | `job_inspections`, `job_inspection_results`, `inspection_checklist_items`, `job_documents` |
| [Customers — extended](#customers--extended) | `customer_tags`, `customer_communications`, `loyalty_transactions` |
| [Vehicles — extended](#vehicles--extended) | `vehicle_service_history`, `vehicle_service_log` |
| [Reminders & AI](#reminders--ai) | `reminders`, `vehicle_model_profiles`, `ai_milestone_rules`, `ai_recommendations`, `assistant_memory` |
| [Vehicle chats](#vehicle-chats) | `vehicle_chats`, `vehicle_chat_messages` |
| [Customer AI chat](#customer-ai-chat) | `customer_chat_sessions` (`customer_vehicle_chats` **dropped** — messages now in S3) |
| [Notifications](#notifications) | `notifications`, `notification_templates`, `customer_pickup_notifications` |
| [Loan vehicles](#loan-vehicles) | `loan_vehicles`, `loan_vehicle_bookings`, `courtesy_cars` |
| [Operations](#operations) | `hoists`, `business_hours`, `staff_roster`, `daily_kpi_snapshots` |
| [Auth](#auth) | `staff_auth`, `staff_sessions`, `customer_auth`, `customer_sessions`, `customer_oauth_providers` |
| [Permissions](#permissions) | `permissions`, `role_permissions`, `staff_permission_overrides`, `staff_store_access` |
| [Integrations](#integrations) | `xero_connections`, `xero_sync_log` |
| [Settings](#settings) | `email_settings`, `staff_email_settings`, `business_settings` |
| [Audit](#audit) | `audit_log` |
| [Reviews](#reviews) | `reviews` |
| [Warranty](#warranty) | `warranty_claims` |
| [Photos](#photos) | `photos` |
| [Premium — Expense tracker](#premium--expense-tracker) | `vehicle_expenses` (**empty** — details now in S3), `vehicle_expense_summary`, `vehicle_fuel_summary` |
| [Premium — Fuel price intelligence](#premium--fuel-price-intelligence) | `fuel_station_prices` |
| [Premium — Logbook import](#premium--logbook-import) | `vehicle_service_log_external` |
| [Data lake index](#data-lake-index) | `s3_event_index` |
| [Vehicle health & maintenance](#vehicle-health--maintenance) | `vehicle_health_scores`, `maintenance_schedule` |
| [AI prompt versioning & feedback](#ai-prompt-versioning--feedback) | `prompt_versions`, `chat_message_feedback` |

---

## Core

### `stores`

| Column | Type | Null | Default |
|--------|------|------|---------|
| `id` | tinyint unsigned | NO | — |
| `name` | varchar(100) | NO | — |
| `address_line1` | varchar(150) | NO | — |
| `suburb` | varchar(80) | NO | — |
| `state` | char(3) | NO | — |
| `postcode` | char(4) | NO | — |
| `phone` | varchar(20) | YES | — |
| `email` | varchar(255) | YES | — |
| `google_business_id` | varchar(60) | YES | — |
| `google_maps_url` | varchar(500) | YES | — |
| `timezone` | varchar(50) | NO | `Australia/Melbourne` |
| `block_times` | json | YES | — |
| `closure_dates` | json | YES | — |
| `is_active` | tinyint(1) | NO | `1` |
| `opened_date` | date | YES | — |
| `created_at` | datetime | NO | `CURRENT_TIMESTAMP` |
| `updated_at` | datetime | NO | `CURRENT_TIMESTAMP` |

`block_times` is a JSON array of `"HH:MM"` strings — e.g. `["08:00","10:00","13:00","15:00"]`. `NULL` means system default. `closure_dates` is a JSON array of `"YYYY-MM-DD"` strings for emergency one-off closures — e.g. `["2026-07-04","2026-12-25"]`. Both `GET /public/blocks` and `GET /public/availability` treat these dates as closed regardless of business hours.

`block_times` is a JSON array of `"HH:MM"` strings — e.g. `["08:00","10:00","13:00","15:00"]`. `NULL` means the store uses the system default `["08:00","10:00","13:00","15:00"]`. Each entry is a bookable time block on the website. Capacity per block = active hoist count.

---

### `staff`

| Column | Type | Null | Default |
|--------|------|------|---------|
| `id` | bigint unsigned | NO | — |
| `store_id` | tinyint unsigned | NO | `1` |
| `first_name` | varchar(80) | NO | — |
| `last_name` | varchar(80) | NO | — |
| `email` | varchar(255) | NO | — |
| `mobile` | varchar(20) | YES | — |
| `role` | enum | YES | — |
| `qualification_level` | enum | YES | — |
| `pin_code` | char(6) | YES | — |
| `colour_code` | varchar(7) | YES | — |
| `avatar_image_id` | varchar(255) | YES | — |
| `is_active` | tinyint(1) | NO | `1` |
| `hired_at` | date | YES | — |
| `created_at` | datetime | NO | `CURRENT_TIMESTAMP` |
| `updated_at` | datetime | NO | `CURRENT_TIMESTAMP` |

**`role` enum:** `owner`, `manager`, `senior_mechanic`, `qualified_mechanic`, `service_tech`, `tyre_tech`, `receptionist`, `apprentice`, `technician`

**`qualification_level` enum:** `cert_ii`, `cert_iii`, `cert_iv`, `trade_qualified`, `management`, `other`

---

### `customers`

| Column | Type | Null | Default |
|--------|------|------|---------|
| `id` | bigint unsigned | NO | — |
| `first_name` | varchar(80) | NO | — |
| `last_name` | varchar(80) | NO | — |
| `store_id` | tinyint unsigned | NO | `1` |
| `email` | varchar(255) | NO | — |
| `mobile` | varchar(20) | NO | — |
| `phone_alt` | varchar(20) | YES | — |
| `address_line1` | varchar(150) | YES | — |
| `address_line2` | varchar(150) | YES | — |
| `suburb` | varchar(80) | YES | — |
| `state` | char(3) | YES | — |
| `postcode` | char(4) | YES | — |
| `is_premium` | tinyint(1) | NO | `0` |
| `tier` | enum | NO | `free` |
| `preferred_contact` | enum | NO | `mobile` |
| `marketing_opt_in` | tinyint(1) | NO | `1` |
| `sms_opt_in` | tinyint(1) | NO | `1` |
| `push_opt_in` | tinyint(1) | NO | `1` |
| `date_of_birth` | date | YES | — |
| `referral_source` | enum | YES | — |
| `referral_detail` | varchar(255) | YES | — |
| `customer_since` | date | YES | — |
| `onboarding_completed_at` | datetime | YES | — |
| `loyalty_points` | int unsigned | NO | `0` |
| `xero_contact_id` | varchar(100) | YES | — |
| `internal_notes` | text | YES | — |
| `is_active` | tinyint(1) | NO | `1` |
| `created_at` | datetime | NO | `CURRENT_TIMESTAMP` |
| `updated_at` | datetime | NO | `CURRENT_TIMESTAMP` |

**`preferred_contact` enum:** `mobile`, `email`, `sms`, `app`

**`tier` enum:** `free`, `silver`, `gold`. `is_premium` is derived: `(tier != 'free')`.

**`referral_source` enum:** `word_of_mouth`, `google`, `facebook`, `instagram`, `existing_customer`, `signage`, `other`

---

### `vehicles`

| Column | Type | Null | Default |
|--------|------|------|---------|
| `id` | bigint unsigned | NO | — |
| `rego` | varchar(10) | NO | — |
| `rego_state` | char(3) | YES | — |
| `rego_expiry` | date | YES | — |
| `vin` | varchar(17) | YES | — |
| `make` | varchar(60) | NO | — |
| `model` | varchar(60) | NO | — |
| `series` | varchar(60) | YES | — |
| `year` | smallint | NO | — |
| `colour` | varchar(40) | YES | — |
| `body_type` | enum | YES | — |
| `engine_code` | varchar(30) | YES | — |
| `engine_size_cc` | smallint | YES | — |
| `cylinders` | tinyint | YES | — |
| `fuel_type` | enum | NO | `petrol` |
| `transmission` | enum | NO | `automatic` |
| `drive_type` | enum | YES | — |
| `tyre_size_front` | varchar(20) | YES | — |
| `tyre_size_rear` | varchar(20) | YES | — |
| `spare_tyre_size` | varchar(20) | YES | — |
| `odometer_unit` | enum | NO | `km` |
| `odometer_current` | int unsigned | YES | — |
| `odometer_recorded_at` | datetime | YES | — |
| `odometer_at_purchase` | int unsigned | YES | — |
| `service_interval_km` | int unsigned | YES | `10000` |
| `service_interval_months` | tinyint | YES | `6` |
| `next_service_due_km` | int unsigned | YES | — |
| `next_service_due_date` | date | YES | — |
| `fleet_unit_number` | varchar(30) | YES | — |
| `internal_notes` | text | YES | — |
| `is_active` | tinyint(1) | NO | `1` |
| `created_at` | datetime | NO | `CURRENT_TIMESTAMP` |
| `updated_at` | datetime | NO | `CURRENT_TIMESTAMP` |

**`fuel_type` enum:** `petrol`, `diesel`, `hybrid`, `electric`, `lpg`, `other`

**`transmission` enum:** `manual`, `automatic`, `cvt`, `dct`, `other`

**`body_type` enum:** `sedan`, `hatch`, `wagon`, `ute`, `van`, `suv`, `coupe`, `convertible`, `truck`, `other`

**`drive_type` enum:** `fwd`, `rwd`, `awd`, `4wd`

---

### `vehicle_owners`

Links vehicles to customers. A vehicle can have multiple owners over time; `is_current = 1` is the active owner.

| Column | Type | Null |
|--------|------|------|
| `id` | bigint unsigned | NO |
| `vehicle_id` | bigint unsigned | NO |
| `customer_id` | bigint unsigned | NO |
| `acquired_date` | date | NO |
| `released_date` | date | YES |
| `is_current` | tinyint(1) | NO |
| `odometer_at_acquisition` | int unsigned | YES |
| `odometer_at_release` | int unsigned | YES |
| `notes` | varchar(500) | YES |
| `created_at` | datetime | NO |

---

## Bookings

### `bookings`

| Column | Type | Null | Default |
|--------|------|------|---------|
| `id` | bigint unsigned | NO | — |
| `store_id` | tinyint unsigned | NO | `1` |
| `booking_ref` | varchar(12) | NO | — |
| `customer_id` | bigint unsigned | NO | — |
| `vehicle_id` | bigint unsigned | NO | — |
| `hoist_id` | tinyint unsigned | YES | — |
| `assigned_staff_id` | bigint unsigned | YES | — |
| `booking_date` | date | NO | — |
| `booking_time` | time | NO | — |
| `slot` | enum | NO | `morning` |
| `estimated_duration_mins` | smallint | NO | `60` |
| `end_time` | time | YES | — |
| `status` | enum | NO | `pending` |
| `drop_off_type` | enum | NO | `drop_off` |
| `odometer_at_booking` | int unsigned | YES | — |
| `booking_source` | enum | NO | `rodz_app` |
| `customer_notes` | text | YES | — |
| `staff_notes` | text | YES | — |
| `confirmed_at` | datetime | YES | — |
| `confirmed_by_staff_id` | bigint unsigned | YES | — |
| `reminder_sent_24h` | tinyint(1) | NO | `0` |
| `reminder_sent_1h` | tinyint(1) | NO | `0` |
| `courtesy_car_requested` | tinyint(1) | NO | `0` |
| `courtesy_car_id` | int | YES | — |
| `courtesy_car_due_back` | date | YES | — |
| `courtesy_car_assigned_at` | timestamp | YES | — |
| `courtesy_car_returned_at` | timestamp | YES | — |
| `cancellation_reason` | varchar(255) | YES | — |
| `cancelled_at` | datetime | YES | — |
| `created_at` | datetime | NO | `CURRENT_TIMESTAMP` |
| `updated_at` | datetime | NO | `CURRENT_TIMESTAMP` |

**`status` enum:** `pending`, `confirmed`, `rejected`, `in_progress`, `completed`, `cancelled`, `no_show`

**`drop_off_type` enum:** `wait`, `drop_off`, `pickup_required`, `after_hours_drop`, `loan_car_needed`

**`booking_source` enum:** `rodz_app`, `website`, `phone`, `walk_in`, `sms`, `email`, `recurring`

**`slot` enum:** `morning`, `afternoon`

> **Soft delete:** set `cancelled_at = NOW()`. Filter active bookings with `cancelled_at IS NULL`.

---

### `booking_services`

Services requested on a booking. Links to `service_types`.

| Column | Type | Null |
|--------|------|------|
| `id` | bigint unsigned | NO |
| `booking_id` | bigint unsigned | NO |
| `service_type_id` | bigint unsigned | NO |
| `customer_description` | varchar(500) | YES |
| `sort_order` | tinyint | NO |

---

## Jobs

### `service_jobs`

| Column | Type | Null | Default |
|--------|------|------|---------|
| `id` | bigint unsigned | NO | — |
| `store_id` | tinyint unsigned | NO | `1` |
| `hoist_id` | tinyint unsigned | YES | — |
| `job_number` | varchar(15) | NO | — |
| `booking_id` | bigint unsigned | YES | — |
| `quote_id` | bigint unsigned | YES | — |
| `vehicle_id` | bigint unsigned | NO | — |
| `customer_id` | bigint unsigned | NO | — |
| `status` | enum | NO | `open` |
| `slot` | enum | NO | `morning` |
| `scheduled_time` | time | YES | — |
| `sort_order` | smallint | NO | `0` |
| `progress` | tinyint unsigned | NO | `0` |
| `odometer_in` | int unsigned | YES | — |
| `odometer_out` | int unsigned | YES | — |
| `started_at` | datetime | YES | — |
| `completed_at` | datetime | YES | — |
| `cancelled_at` | datetime | YES | — |
| `next_service_due_km` | int unsigned | YES | — |
| `next_service_due_date` | date | YES | — |
| `technician_notes` | text | YES | — |
| `customer_notes` | text | YES | — |
| `upsells_offered` | json | YES | — |
| `upsells_accepted` | json | YES | — |
| `created_at` | datetime | NO | `CURRENT_TIMESTAMP` |
| `updated_at` | datetime | NO | `CURRENT_TIMESTAMP` |

**`status` enum:** `open`, `in_progress`, `awaiting_parts`, `awaiting_approval`, `completed`, `invoiced`, `cancelled`

---

### `service_job_items`

Line items on a job (labour, parts, sublets, discounts).

| Column | Type | Null |
|--------|------|------|
| `id` | bigint unsigned | NO |
| `service_job_id` | bigint unsigned | NO |
| `line_type` | enum | NO |
| `service_type_id` | bigint unsigned | YES |
| `part_id` | bigint unsigned | YES |
| `description` | varchar(500) | NO |
| `quantity` | decimal(8,2) | NO |
| `unit_price` | decimal(10,2) | NO |
| `gst_applicable` | tinyint(1) | NO |
| `line_total` | decimal(10,2) | YES |
| `cost_price` | decimal(10,2) | YES |
| `warranty_months` | tinyint | YES |
| `warranty_expires_at` | date | YES |
| `warranty_supplier` | varchar(80) | YES |
| `technician_notes` | varchar(500) | YES |
| `sort_order` | smallint | NO |

**`line_type` enum:** `labour`, `part`, `sublet`, `discount`

`line_total` is a generated column (`quantity * unit_price`) — do not insert or update it directly.

---

### `job_parts`

Parts tracking on a job (requested, ordered, arrived).

| Column | Type | Null |
|--------|------|------|
| `id` | bigint unsigned | NO |
| `job_id` | bigint unsigned | NO |
| `description` | varchar(255) | NO |
| `part_number` | varchar(100) | YES |
| `qty` | tinyint unsigned | NO |
| `status` | enum | NO |
| `eta` | varchar(50) | YES |
| `requested_by` | bigint unsigned | YES |
| `requested_at` | datetime | NO |

**`status` enum:** `requested`, `ordered`, `arrived`

---

### `service_job_staff`

Staff assigned to a job with time tracking.

| Column | Type | Null |
|--------|------|------|
| `id` | bigint unsigned | NO |
| `service_job_id` | bigint unsigned | NO |
| `staff_id` | bigint unsigned | NO |
| `role_on_job` | enum | NO |
| `clocked_on` | datetime | YES |
| `clocked_off` | datetime | YES |
| `billable_minutes` | smallint | YES |
| `notes` | varchar(300) | YES |
| `created_at` | datetime | NO |

**`role_on_job` enum:** `lead_mechanic`, `service_tech`, `tyre_tech`, `apprentice`, `inspector`

---

### `job_card_items`

Per-job checklist seeded from approved quote items. Technicians tick items off as work is completed.

| Column | Type | Null | Default |
|--------|------|------|---------|
| `id` | int unsigned | NO | — |
| `job_id` | int unsigned | NO | — |
| `quote_item_id` | int unsigned | YES | — |
| `description` | varchar(500) | NO | — |
| `qty` | int unsigned | NO | `1` |
| `sort_order` | int unsigned | NO | `0` |
| `completed` | tinyint(1) | NO | `0` |
| `completed_at` | datetime | YES | — |
| `completed_by_staff_id` | int unsigned | YES | — |
| `notes` | varchar(1000) | YES | — |
| `created_at` | datetime | NO | `CURRENT_TIMESTAMP` |

Unique index: `uidx_job_quote_item (job_id, quote_item_id)` — prevents duplicate seeding under concurrent requests.

Card is auto-seeded on first `GET /jobs/{id}/card` when the job's quote is in `approved`, `converted`, `invoiced`, or `paid` status. Items with `quote_items.is_accepted = 0` are excluded.

---

## Financials

### `invoices`

| Column | Type | Null | Default |
|--------|------|------|---------|
| `id` | bigint unsigned | NO | — |
| `invoice_number` | varchar(20) | NO | — |
| `store_id` | int unsigned | NO | — |
| `staff_id` | int unsigned | NO | — |
| `customer_id` | int unsigned | NO | — |
| `vehicle_rego` | varchar(20) | NO | — |
| `job_id` | int unsigned | YES | — |
| `quote_id` | int unsigned | YES | — |
| `status` | enum | NO | `draft` |
| `payment_method` | enum | YES | — |
| `token` | varchar(64) | YES | — |
| `notes` | text | YES | — |
| `subtotal` | decimal(10,2) | NO | `0` |
| `gst` | decimal(10,2) | NO | `0` |
| `total` | decimal(10,2) | NO | `0` |
| `due_date` | date | YES | — |
| `zeller_payment_id` | varchar(255) | YES | — |
| `zeller_payment_url` | text | YES | — |
| `sent_at` | datetime | YES | — |
| `paid_at` | datetime | YES | — |
| `created_at` | datetime | NO | `CURRENT_TIMESTAMP` |
| `updated_at` | datetime | NO | `CURRENT_TIMESTAMP` |

**`status` enum:** `draft`, `sent`, `paid`

**`payment_method` enum:** `bank_transfer`, `zeller`

- `invoice_number` format: `INV-YYMM-NNN` (e.g. `INV-2506-001`) — monthly sequential, zero-padded to 3 digits
- `token` — 64-char hex, set on send; used for public customer view URL (`/i/:token`)
- `zeller_payment_id` / `zeller_payment_url` — set when Zeller payment link is created at send time; creation is best-effort (non-fatal if it fails)
- FK references: `payments.invoice_id` and `loyalty_transactions.invoice_id` both reference `invoices.id`

---

### `invoice_items`

Line items on an invoice. Deleted and re-inserted on update (draft only).

| Column | Type | Null | Default |
|--------|------|------|---------|
| `id` | bigint unsigned | NO | — |
| `invoice_id` | bigint unsigned | NO | — |
| `type` | enum | NO | `other` |
| `description` | varchar(500) | NO | — |
| `hours` | decimal(8,2) | YES | — |
| `qty` | decimal(8,2) | YES | — |
| `unit_price` | decimal(10,2) | NO | — |
| `line_total` | decimal(10,2) | NO | — |
| `sort_order` | int unsigned | NO | `0` |

**`type` enum:** `labour`, `part`, `other`

- `line_total` is stored (not generated) — computed as `hours × unit_price` for labour, `qty × unit_price` for parts/other
- Cascade-deleted when parent invoice is deleted: `ON DELETE CASCADE`

---

### `payments`

| Column | Type | Null |
|--------|------|------|
| `id` | bigint unsigned | NO |
| `invoice_id` | bigint unsigned | NO |
| `amount` | decimal(10,2) | NO |
| `payment_method` | enum | NO |
| `reference` | varchar(100) | YES |
| `loyalty_points_used` | int unsigned | YES |
| `processed_at` | datetime | NO |
| `processed_by_staff_id` | bigint unsigned | YES |
| `notes` | varchar(255) | YES |
| `is_refund` | tinyint(1) | NO |
| `created_at` | datetime | NO |

**`payment_method` enum:** `cash`, `card_eftpos`, `card_credit`, `bank_transfer`, `afterpay`, `zip`, `loyalty_points`, `other`

---

### `quotes`

| Column | Type | Null |
|--------|------|------|
| `id` | bigint unsigned | NO |
| `quote_number` | varchar(15) | NO |
| `booking_id` | bigint unsigned | YES |
| `vehicle_id` | bigint unsigned | NO |
| `customer_id` | bigint unsigned | NO |
| `store_id` | tinyint unsigned | NO |
| `prepared_by_staff_id` | bigint unsigned | NO |
| `status` | enum | NO |
| `token` | varchar(36) | YES |
| `valid_days` | tinyint | NO |
| `valid_until` | date | NO |
| `subtotal` | decimal(10,2) | NO |
| `gst_amount` | decimal(10,2) | NO |
| `total` | decimal(10,2) | NO |
| `sent_at` | datetime | YES |
| `viewed_at` | datetime | YES |
| `approved_at` | datetime | YES |
| `approved_by_name` | varchar(120) | YES |
| `approval_method` | enum | YES |
| `rejected_at` | datetime | YES |
| `rejection_reason` | varchar(500) | YES |
| `customer_notes` | text | YES |
| `internal_notes` | text | YES |
| `created_at` | datetime | NO |
| `updated_at` | datetime | NO |

**`status` enum:** `draft`, `sent`, `viewed`, `approved`, `rejected`, `expired`, `converted`, `invoiced`, `paid`

**`approval_method` enum:** `app`, `sms_link`, `email_link`, `in_person`, `phone`

---

### `quote_items`

| Column | Type | Null |
|--------|------|------|
| `id` | bigint unsigned | NO |
| `quote_id` | bigint unsigned | NO |
| `catalog_item_id` | bigint unsigned | YES |
| `line_type` | enum | NO |
| `service_type_id` | bigint unsigned | YES |
| `part_id` | bigint unsigned | YES |
| `description` | varchar(500) | NO |
| `quantity` | decimal(8,2) | NO |
| `unit_price` | decimal(10,2) | NO |
| `gst_applicable` | tinyint(1) | NO |
| `line_total` | decimal(10,2) | YES |
| `sort_order` | smallint | NO |
| `is_optional` | tinyint(1) | NO |
| `hours` | decimal(4,2) | YES |
| `is_accepted` | tinyint(1) | YES |

**`line_type` enum:** `labour`, `part`, `sublet`, `discount`, `note`

`line_total` is a generated column (`quantity * unit_price`) — do not insert or update it directly.

---

### `purchase_orders`

| Column | Type | Null |
|--------|------|------|
| `id` | bigint unsigned | NO |
| `po_number` | varchar(15) | NO |
| `store_id` | tinyint unsigned | NO |
| `supplier` | varchar(100) | NO |
| `status` | enum | NO |
| `ordered_at` | datetime | YES |
| `expected_delivery` | date | YES |
| `received_at` | datetime | YES |
| `subtotal` | decimal(10,2) | NO |
| `gst_amount` | decimal(10,2) | NO |
| `total` | decimal(10,2) | NO |
| `supplier_invoice_ref` | varchar(60) | YES |
| `notes` | text | YES |
| `created_by_staff_id` | bigint unsigned | YES |
| `created_at` | datetime | NO |
| `updated_at` | datetime | NO |
| `deleted_at` | datetime | YES |

**`status` enum:** `draft`, `ordered`, `partial`, `received`, `cancelled`

Soft-delete: `deleted_at IS NULL` for active records. Status is also set to `cancelled` on delete.

---

### `purchase_order_items`

| Column | Type | Null |
|--------|------|------|
| `id` | bigint unsigned | NO |
| `purchase_order_id` | bigint unsigned | NO |
| `part_id` | bigint unsigned | YES |
| `service_job_id` | bigint unsigned | YES |
| `description` | varchar(500) | NO |
| `part_number` | varchar(100) | YES |
| `quantity_ordered` | decimal(8,2) | NO |
| `quantity_received` | decimal(8,2) | NO |
| `unit_cost` | decimal(10,2) | NO |
| `line_total` | decimal(10,2) | YES |
| `notes` | text | YES |

`line_total` is a generated column (`quantity_ordered * unit_cost`) — do not insert or update it directly.

---

## Catalog

### `service_types`

| Column | Type | Null |
|--------|------|------|
| `id` | bigint unsigned | NO |
| `name` | varchar(120) | NO |
| `category` | enum | NO |
| `description` | text | YES |
| `labour_hours_estimate` | decimal(4,2) | NO |
| `labour_rate` | decimal(8,2) | NO |
| `complexity` | enum | NO |
| `hoist_required` | tinyint(1) | NO |
| `tyre_bay_job` | tinyint(1) | NO |
| `fixed_price` | decimal(8,2) | YES |
| `default_interval_km` | int unsigned | YES |
| `default_interval_months` | tinyint | YES |
| `xero_account_code` | varchar(20) | YES |
| `sort_order` | smallint | NO |
| `is_active` | tinyint(1) | NO |

**`category` enum:** `service`, `tyres`, `brakes`, `suspension`, `electrical`, `air_con`, `exhaust`, `inspection`, `repairs`, `other`

**`complexity` enum:** `routine`, `moderate`, `complex`

---

### `catalog_items`

Pre-built line items (labour templates, common parts).

| Column | Type | Null |
|--------|------|------|
| `id` | bigint unsigned | NO |
| `name` | varchar(150) | NO |
| `description` | text | YES |
| `category` | varchar(60) | NO |
| `type` | enum | NO |
| `hours` | decimal(4,2) | YES |
| `unit_price` | decimal(10,2) | NO |
| `is_active` | tinyint(1) | NO |

**`type` enum:** `labour`, `part`, `other`

---

### `part_names`

Master list of part name templates used as a reference when creating parts or quoting.

| Column | Type | Null | Default |
|--------|------|------|---------|
| `id` | int unsigned | NO | — |
| `name` | varchar(150) | NO | — |
| `category` | varchar(60) | YES | — |
| `is_active` | tinyint(1) | NO | `1` |

---

### `suppliers`

| Column | Type | Null | Default |
|--------|------|------|---------|
| `id` | int unsigned | NO | — |
| `name` | varchar(100) | NO | — |
| `contact_name` | varchar(100) | YES | — |
| `phone` | varchar(20) | YES | — |
| `email` | varchar(255) | YES | — |
| `website` | varchar(255) | YES | — |
| `account_number` | varchar(60) | YES | — |
| `notes` | text | YES | — |
| `is_active` | tinyint(1) | NO | `1` |
| `created_at` | datetime | NO | `CURRENT_TIMESTAMP` |
| `updated_at` | datetime | NO | `CURRENT_TIMESTAMP` |

---

### `parts`

Inventory parts. `supplier_id` FK to `suppliers`. The old `supplier varchar(80)` column is replaced by this FK.

| Column | Type | Null | Default |
|--------|------|------|---------|
| `id` | bigint unsigned | NO | — |
| `part_number` | varchar(60) | NO | — |
| `name` | varchar(150) | NO | — |
| `category` | varchar(60) | YES | — |
| `supplier_id` | int unsigned | YES | — |
| `supplier_part_number` | varchar(60) | YES | — |
| `cost_price` | decimal(10,2) | NO | — |
| `sell_price` | decimal(10,2) | NO | — |
| `gst_applicable` | tinyint(1) | NO | `1` |
| `stock_on_hand` | int | NO | `0` |
| `reorder_point` | int | NO | `0` |
| `is_active` | tinyint(1) | NO | `1` |

---

## Inspections

### `job_inspections`

| Column | Type | Null |
|--------|------|------|
| `id` | bigint unsigned | NO |
| `service_job_id` | bigint unsigned | NO |
| `vehicle_id` | bigint unsigned | NO |
| `inspected_by_staff_id` | bigint unsigned | YES |
| `status` | enum | NO |
| `overall_condition` | enum | YES |
| `started_at` | datetime | YES |
| `completed_at` | datetime | YES |
| `sent_to_customer_at` | datetime | YES |
| `notes` | text | YES |

**`status` enum:** `in_progress`, `completed`, `sent_to_customer`

**`overall_condition` enum:** `good`, `advisory`, `attention_needed`, `urgent`

---

### `job_inspection_results`

Individual checklist item results within an inspection.

| Column | Type | Null |
|--------|------|------|
| `id` | bigint unsigned | NO |
| `job_inspection_id` | bigint unsigned | NO |
| `checklist_item_id` | smallint unsigned | NO |
| `condition_rating` | enum | NO |
| `measured_value` | varchar(30) | YES |
| `technician_notes` | varchar(500) | YES |
| `photo_url` | varchar(500) | YES |
| `generated_quote_item_id` | bigint unsigned | YES |

**`condition_rating` enum:** `good`, `advisory`, `attention`, `urgent`, `na`

---

### `inspection_checklist_items`

Master list of items that appear on every vehicle inspection.

| Column | Type | Null |
|--------|------|------|
| `id` | smallint unsigned | NO |
| `category` | varchar(60) | NO |
| `name` | varchar(120) | NO |
| `description` | varchar(300) | YES |
| `sort_order` | smallint | NO |
| `is_active` | tinyint(1) | NO |

Referenced by `job_inspection_results.checklist_item_id`.

---

### `job_documents`

Photos and files attached to a job.

| Column | Type | Null |
|--------|------|------|
| `id` | bigint unsigned | NO |
| `service_job_id` | bigint unsigned | NO |
| `vehicle_id` | bigint unsigned | NO |
| `document_type` | enum | NO |
| `file_url` | varchar(500) | NO |
| `thumbnail_url` | varchar(500) | YES |
| `filename_original` | varchar(255) | YES |
| `file_size_bytes` | int unsigned | YES |
| `mime_type` | varchar(60) | YES |
| `caption` | varchar(300) | YES |
| `uploaded_by_staff_id` | bigint unsigned | YES |
| `is_visible_to_customer` | tinyint(1) | NO |

**`document_type` enum:** `arrival_condition`, `worn_part`, `inspection_photo`, `signed_form`, `invoice`, `quote`, `other`

---

## Customers — extended

### `customer_tags`

| Column | Type |
|--------|------|
| `customer_id` | bigint unsigned |
| `tag` | enum(`New`, `Regular`, `VIP`) |

---

### `customer_communications`

Log of all interactions with a customer.

| Column | Type | Null |
|--------|------|------|
| `id` | bigint unsigned | NO |
| `customer_id` | bigint unsigned | NO |
| `vehicle_id` | bigint unsigned | YES |
| `staff_id` | bigint unsigned | YES |
| `direction` | enum | NO |
| `channel` | enum | NO |
| `subject` | varchar(255) | YES |
| `body` | text | YES |
| `follow_up_required` | tinyint(1) | NO |
| `follow_up_date` | date | YES |
| `follow_up_done` | tinyint(1) | NO |

**`direction` enum:** `inbound`, `outbound`, `internal`

**`channel` enum:** `phone`, `email`, `sms`, `in_person`, `app`, `other`

---

### `loyalty_transactions`

| Column | Type | Null |
|--------|------|------|
| `id` | bigint unsigned | NO |
| `customer_id` | bigint unsigned | NO |
| `invoice_id` | bigint unsigned | YES |
| `transaction_type` | enum | NO |
| `points_delta` | int | NO |
| `balance_after` | int | NO |
| `description` | varchar(255) | YES |
| `created_by_staff_id` | bigint unsigned | YES |

**`transaction_type` enum:** `earned`, `redeemed`, `adjusted`, `expired`, `welcome_bonus`

---

## Vehicles — extended

### `vehicle_service_history`

Stores service records (both from Rodz jobs and imported history).

| Column | Type | Null |
|--------|------|------|
| `id` | bigint unsigned | NO |
| `vehicle_id` | bigint unsigned | NO |
| `service_job_id` | bigint unsigned | YES |
| `service_date` | date | NO |
| `odometer` | int unsigned | YES |
| `workshop_name` | varchar(120) | NO |
| `service_summary` | text | NO |
| `oil_changed` | tinyint(1) | NO |
| `filter_oil` | tinyint(1) | NO |
| `filter_air` | tinyint(1) | NO |
| `filter_cabin` | tinyint(1) | NO |
| `filter_fuel` | tinyint(1) | NO |
| `brakes_inspected` | tinyint(1) | NO |
| `tyres_rotated` | tinyint(1) | NO |
| `tyres_replaced` | tinyint(1) | NO |
| `battery_tested` | tinyint(1) | NO |
| `next_service_km` | int unsigned | YES |
| `next_service_date` | date | YES |
| `total_charged` | decimal(10,2) | YES |

---

### `vehicle_service_log`

Denormalised service log built from Rodz invoices. Populated automatically via `ON DUPLICATE KEY UPDATE` whenever an invoice is sent or paid. Powers the customer-facing logbook, service history, AI chat context, and the shareable public logbook page. Read-only from the API — never write to this table directly; let the invoice pipeline maintain it.

| Column | Type | Null | Notes |
|--------|------|------|-------|
| `id` | bigint unsigned | NO | Auto increment |
| `invoice_id` | bigint unsigned | NO | FK → `invoices.id` — unique key |
| `vehicle_rego` | varchar | NO | Denormalised from invoice |
| `invoice_number` | varchar | NO | e.g. `INV-2606-001` |
| `service_date` | date | NO | `DATE(invoice.created_at)` |
| `odometer` | int unsigned | YES | `invoice.odometer_in` |
| `store` | varchar | YES | Denormalised store name |
| `tech` | varchar | YES | Denormalised tech name, format `"N. Rodda"` |
| `total` | decimal(10,2) | NO | Invoice total inc. GST |
| `status` | enum | NO | Mirrors invoice status |
| `ai_summary` | text | YES | AI plain-English summary — set async after invoice is sent |
| `updated_at` | datetime | NO | `CURRENT_TIMESTAMP ON UPDATE` |
| `created_at` | datetime | NO | `CURRENT_TIMESTAMP` |

**`status` enum:** `sent`, `paid`

Filter by `status IN ('sent', 'paid')` when querying public-facing history — drafts are excluded.

---

## Reminders & AI

### `reminders`

| Column | Type | Null |
|--------|------|------|
| `id` | bigint unsigned | NO |
| `vehicle_id` | bigint unsigned | NO |
| `customer_id` | bigint unsigned | NO |
| `reminder_type` | enum | NO |
| `trigger_type` | enum | NO |
| `trigger_date` | date | YES |
| `trigger_odometer` | int unsigned | YES |
| `lead_days` | smallint | NO |
| `status` | enum | NO |
| `message_override` | text | YES |
| `sent_at` | datetime | YES |
| `booking_id` | bigint unsigned | YES |
| `is_recurring` | tinyint(1) | NO |
| `recur_interval_months` | tinyint | YES |
| `recur_interval_km` | int unsigned | YES |

**`reminder_type` enum:** `service`, `tyres`, `brakes`, `rego`, `battery`, `aircon`, `custom`

**`trigger_type` enum:** `date`, `odometer`, `both`

**`status` enum:** `pending`, `queued`, `sent`, `acknowledged`, `booked`, `dismissed`, `expired`

---

### `vehicle_model_profiles`

AI-generated reference profiles per make/model/year. Shared across all vehicles of the same type — generated once and reused. Triggered on the first public booking for a vehicle, or lazily on the first `GET /customers/{id}/vehicles/{id}/profile` call.

| Column | Type | Null |
|--------|------|------|
| `id` | int unsigned | NO |
| `make` | varchar(50) | NO |
| `model` | varchar(80) | NO |
| `year` | smallint | NO |
| `overview` | text | NO |
| `engine_specs` | json | NO |
| `tyre_specs` | json | NO |
| `service_notes` | json | NO |
| `known_issues` | json | NO |
| `common_repairs` | json | NO |
| `generated_at` | datetime | NO |

Unique index: `uidx_make_model_year (make, model, year)`

**JSON shapes:**
- `engine_specs` — `{ oilType, oilCapacityL, coolantType, transmissionFluid, brakeFluid, powerSteeringFluid, sparkPlugType, sparkPlugIntervalKm, timingDrive, timingBeltIntervalKm }`
- `tyre_specs` — `{ front: { size, pressureCold }, rear: { size, pressureCold }, spare }`
- `service_notes` — `string[]`
- `known_issues` — `{ title, description, severity }[]` where severity is `low | medium | high`
- `common_repairs` — `{ name, intervalKm, typicalCostAud }[]`

---

### `ai_milestone_rules`

Static rules used to trigger AI-generated recommendations (e.g. "60,000 km service", "timing belt"). Not currently used by the recommendation engine (which uses Gemini directly), but kept for future rule-based triggers.

| Column | Type | Null |
|--------|------|------|
| `id` | int unsigned | NO |
| `name` | varchar(100) | NO |
| `trigger_km` | int unsigned | YES |
| `trigger_months` | int unsigned | YES |
| `is_active` | tinyint(1) | NO |

---

### `ai_recommendations`

Generated maintenance recommendations per vehicle, produced by the Gemini-powered recommendation engine.

**Regeneration behaviour**: on each engine run the handler deletes rows where `status = 'active'` for that vehicle, then inserts the new Gemini output. Rows in `sent`, `acknowledged`, `dismissed`, `completed`, or `expired` are preserved as history — nothing that has been actioned or emailed is ever destroyed.

**Triggers** (see `docs/ai-maintenance-reminders.md` for the full table):
- Vehicle creation via any path (customer portal, workshop, public booking)
- Odometer update with a delta of ≥10,000 km since last generation
- Booking creation (safety net — only fires if no schedule exists yet)

| Column | Type | Null |
|--------|------|------|
| `id` | bigint unsigned | NO |
| `vehicle_id` | bigint unsigned | NO |
| `customer_id` | bigint unsigned | NO |
| `rule_id` | int unsigned | YES |
| `title` | varchar(60) | NO |
| `recommendation_title` | varchar(60) | NO |
| `recommendation_body` | varchar(500) | NO |
| `urgency` | enum | NO |
| `status` | enum | NO |
| `triggered_at_odometer` | int unsigned | YES |
| `triggered_at_date` | date | YES |
| `estimated_due_odometer` | int unsigned | YES |
| `estimated_due_date` | date | YES |
| `estimated_cost_min` | decimal(8,2) | YES |
| `estimated_cost_max` | decimal(8,2) | YES |
| `sent_at` | datetime | YES |
| `acknowledged_at` | datetime | YES |
| `dismissed_at` | datetime | YES |
| `completed_at` | datetime | YES |
| `completed_by_job_id` | bigint unsigned | YES |
| `created_at` | datetime | NO |
| `updated_at` | datetime | NO |

**`urgency` enum:** `advisory`, `recommended`, `important`, `urgent`

**`status` enum:** `active`, `sent`, `acknowledged`, `dismissed`, `completed`, `expired`

The reminder dispatcher queries `status = 'active'` records where `estimated_due_odometer` is within 2,000 km of the vehicle's predicted current odometer (using `odometer_current + days_since_recorded × 41 km/day`).

**`urgency` enum:** `advisory`, `recommended`, `important`, `urgent`

---

## Vehicle chats

### `vehicle_chats`

One row per conversation. A conversation is always tied to a vehicle and was started by a staff member.

| Column | Type | Null |
|--------|------|------|
| `id` | bigint unsigned | NO |
| `vehicle_id` | bigint unsigned | NO |
| `started_by_staff_id` | bigint unsigned | NO |
| `created_at` | datetime | NO |

Index: `idx_vehicle_chats_vehicle_id (vehicle_id)`

---

### `vehicle_chat_messages`

Individual messages within a vehicle chat. Role is `user` (mechanic) or `model` (Gemini assistant). Images are stored as Cloudflare image IDs.

| Column | Type | Null |
|--------|------|------|
| `id` | bigint unsigned | NO |
| `chat_id` | bigint unsigned | NO |
| `role` | enum(`user`, `model`) | NO |
| `content` | text | YES |
| `image_id` | varchar(255) | YES |
| `staff_id` | bigint unsigned | YES |
| `created_at` | datetime | NO |

- `content` is null for image-only messages
- `image_id` is a Cloudflare Images ID — use `imageUrls(imageId)` to get thumbnail/public URLs
- `staff_id` is null on `model` (assistant) messages
- Index: `idx_vehicle_chat_messages_chat_id (chat_id)`

---

## Customer AI chat

### `customer_chat_sessions`

Groups chat messages into named sessions. Each customer can have multiple sessions per vehicle — the title is auto-generated from the first message via Gemini. **Session METADATA only; messages themselves live in S3** — see below.

| Column | Type | Null | Notes |
|--------|------|------|-------|
| `id` | bigint unsigned | NO | Auto increment |
| `vehicle_id` | bigint unsigned | NO | FK → `vehicles.id` |
| `customer_id` | bigint unsigned | NO | FK → `customers.id` |
| `title` | varchar(255) | YES | AI-generated title — null until first message processed |
| `created_at` | datetime | NO | `CURRENT_TIMESTAMP` |
| `updated_at` | datetime | NO | `CURRENT_TIMESTAMP ON UPDATE` — bumped on every new message |
| `deleted_at` | datetime | YES | Soft delete. When set, session is hidden from user and AI recall tools. S3 blob is moved to `diagnostic-sessions/archived/{sessionId}.json`. |

- Filter `deleted_at IS NULL` on every read path (list, history, greeting, `getDiagnosticHistory`)
- `updated_at` is used to sort sessions newest-first in the session list
- Indexes: `(vehicle_id, customer_id)`, `(vehicle_id, deleted_at)`

---

### `customer_vehicle_chats` — **DROPPED**

Message rows previously lived here. As of 2026-07-14 the table is dropped; messages now live in S3 as one JSON blob per session at:

```
s3://rodz-data-lake/diagnostic-sessions/current/{sessionId}.json
```

Blob shape:

```json
{
  "sessionId":  1,
  "vehicleId":  42,
  "customerId": 3,
  "updatedAt":  "2026-07-14T01:23:45.678Z",
  "messages": [
    {
      "id":        "1783985109460-0-c04979",
      "role":      "user" | "model",
      "content":   "…" | null,
      "imageId":   "cloudflare-uuid" | null,
      "toolCalls": [ { name, args, result }, … ] | null,
      "createdAt": "2026-07-14T01:23:45.000Z"
    }
  ]
}
```

Access via `src/customer/vehicles/chats/messagesStore.ts` — `loadSession`, `appendMessages` (uses S3 `IfMatch` etag with retry on 412 for concurrency), `deleteSessionBlob`, `archiveSessionBlob`.

**Message id is a string** — `${timestampMs}-${index}-${hex}`. Never `Number()` it.

---

## Notifications

### `notifications`

All outbound messages to customers.

| Column | Type | Null |
|--------|------|------|
| `id` | bigint unsigned | NO |
| `customer_id` | bigint unsigned | NO |
| `vehicle_id` | bigint unsigned | YES |
| `booking_id` | bigint unsigned | YES |
| `channel` | enum | NO |
| `notification_type` | enum | NO |
| `subject` | varchar(255) | YES |
| `body` | text | NO |
| `status` | enum | NO |
| `sent_at` | datetime | YES |
| `failed_reason` | varchar(500) | YES |

**`channel` enum:** `email`, `sms`, `push`, `in_app`

**`notification_type` enum:** `service` (AI maintenance reminders), `booking_confirmed`, `booking_reminder`, `work_commenced`, `work_complete`, `quote_sent`, `pickup_ready`

**`status` enum:** `queued`, `sent`, `delivered`, `opened`, `clicked`, `failed`, `bounced`, `unsubscribed`

---

### `notification_templates`

Reusable message templates for each notification type.

| Column | Type | Null |
|--------|------|------|
| `id` | smallint unsigned | NO |
| `notification_type` | varchar(60) | NO |
| `channel` | enum | NO |
| `subject` | varchar(255) | YES |
| `body_template` | text | NO |
| `is_active` | tinyint(1) | NO |

**`channel` enum:** `email`, `sms`, `push`, `in_app`

---

### `customer_pickup_notifications`

Deduplication log for vehicle-ready emails. One row per job per channel — prevents re-sending on every card completion tick.

| Column | Type | Null |
|--------|------|------|
| `id` | int unsigned | NO |
| `job_id` | int unsigned | NO |
| `channel` | varchar(20) | NO |
| `recipient` | varchar(255) | NO |
| `sent_at` | datetime | NO |

---

## Loan vehicles

### `loan_vehicles`

| Column | Type | Null |
|--------|------|------|
| `id` | smallint unsigned | NO |
| `store_id` | tinyint unsigned | NO |
| `rego` | varchar(10) | NO |
| `make` | varchar(60) | NO |
| `model` | varchar(60) | NO |
| `year` | smallint | NO |
| `status` | enum | NO |
| `insurance_expiry` | date | YES |
| `rego_expiry` | date | YES |

**`status` enum:** `available`, `on_loan`, `maintenance`, `retired`

---

### `loan_vehicle_bookings`

Tracks when a loan car is issued and returned for a booking.

Key columns: `loan_vehicle_id`, `customer_id`, `booking_id`, `expected_out`, `expected_return`, `actual_out`, `actual_return`, `odometer_out`, `odometer_in`, `fuel_level_out`, `fuel_level_in`

---

### `courtesy_cars`

Workshop-owned loan cars managed through Settings → Courtesy Cars. Assignment is tracked directly on the `bookings` table via `courtesy_car_id`.

| Column | Type | Null | Default |
|--------|------|------|---------|
| `id` | int | NO | — |
| `rego` | varchar(20) | NO | — |
| `make` | varchar(50) | NO | — |
| `model` | varchar(50) | NO | — |
| `year` | smallint | YES | — |
| `color` | varchar(30) | YES | — |
| `status` | enum | NO | `active` |
| `store_id` | int | YES | — |
| `created_at` | timestamp | NO | `NOW()` |
| `updated_at` | timestamp | NO | `NOW()` |

**`status` enum:** `active`, `inactive`

`store_id` is `NULL` for cars shared across all stores. A car is considered "currently out" when a booking references it via `courtesy_car_id` and that booking's `courtesy_car_returned_at IS NULL`.

---

## Operations

### `hoists`

| Column | Type | Null |
|--------|------|------|
| `id` | tinyint unsigned | NO |
| `store_id` | tinyint unsigned | NO |
| `name` | varchar(30) | NO |
| `hoist_type` | enum | NO |
| `is_active` | tinyint(1) | NO |
| `assigned_staff_id` | bigint unsigned | YES |
| `service_roles` | json | YES |

**`hoist_type` enum:** `two_post`, `four_post`, `scissor`, `tyre_bay`, `other`

---

### `business_hours`

| Column | Type | Null |
|--------|------|------|
| `id` | smallint unsigned | NO |
| `store_id` | tinyint unsigned | NO |
| `day_of_week` | tinyint | NO |
| `open_time` | time | YES |
| `close_time` | time | YES |
| `is_closed` | tinyint(1) | NO |
| `last_booking_offset_mins` | smallint | NO |

---

### `staff_roster`

| Column | Type | Null |
|--------|------|------|
| `id` | bigint unsigned | NO |
| `staff_id` | bigint unsigned | NO |
| `store_id` | tinyint unsigned | NO |
| `roster_date` | date | NO |
| `start_time` | time | NO |
| `end_time` | time | NO |
| `break_mins` | smallint | NO |
| `role_on_day` | enum | YES |

**`role_on_day` enum:** `mechanic`, `service_tech`, `tyre_tech`, `manager`, `reception`

---

### `daily_kpi_snapshots`

Daily performance snapshot per store. Key metrics: hoist utilisation, job counts, revenue breakdown, parts cost ratio, reviews.

---

## Auth

### `staff_auth` / `staff_sessions`

Standard password auth + session management for staff. `staff_sessions.token_hash` is the hashed JWT.

### `customer_auth` / `customer_sessions` / `customer_oauth_providers`

Customer-facing auth. Supports password login and Apple/Google OAuth. `customer_oauth_providers.provider` enum: `apple`, `google`.

---

## Permissions

### `staff_store_access`

Which stores a staff member can access. Filter bookings/jobs by joining this table for non-`super_admin` roles.

| Column | Type | Null |
|--------|------|------|
| `staff_id` | bigint unsigned | NO |
| `store_id` | tinyint unsigned | NO |
| `granted_at` | datetime | NO |
| `revoked_at` | datetime | YES |

> Active access: `revoked_at IS NULL`

### `permissions` / `role_permissions` / `staff_permission_overrides`

Fine-grained permission system. `role_permissions` sets defaults per role; `staff_permission_overrides` adds or removes individual grants.

**Permission categories:** `store_access`, `financials`, `staff_management`, `operations`, `inventory`, `reporting`, `integrations`, `settings`

---

## Integrations

### `xero_connections`

One row per store. Stores OAuth tokens for Xero. Check `is_active = 1` and `token_expires_at` before making Xero API calls.

### `xero_sync_log`

Audit trail of every push/pull to Xero. Key columns: `entity_type`, `entity_id`, `status`, `http_status_code`, `error_message`.

---

## Settings

### `email_settings`

Single-row table (id = 1). Stores JSON blob of global email config.

### `staff_email_settings`

Single-row table (id = 1). Email templates for staff-facing notifications: booking received, confirmed, work commenced, work complete, quote.

---

### `business_settings`

Single-row table (id = 1 always). Global business configuration — bank transfer details for invoices.

| Column | Type | Null | Default |
|--------|------|------|---------|
| `id` | int | NO | `1` |
| `bank_account_name` | varchar(100) | NO | `''` |
| `bank_bsb` | varchar(7) | NO | `''` |
| `bank_account_number` | varchar(20) | NO | `''` |
| `bank_reference` | varchar(50) | NO | `''` |
| `updated_at` | datetime | NO | `CURRENT_TIMESTAMP` |
| `updated_by` | bigint unsigned | YES | — |

Seed once at migration time: `INSERT INTO business_settings (id) VALUES (1) ON DUPLICATE KEY UPDATE id = id;`

If `bank_account_name` is empty, the bank transfer section is omitted from generated invoices.

---

## Audit

### `audit_log`

Tracks all insert/update/delete operations across the system.

| Column | Type |
|--------|------|
| `table_name` | varchar(60) |
| `record_id` | bigint unsigned |
| `action` | enum(`insert`, `update`, `delete`) |
| `changed_by_staff_id` | bigint unsigned |
| `old_values` | json |
| `new_values` | json |
| `changed_fields` | json |
| `ip_address` | varchar(45) |

---

## Reviews

### `reviews`

| Column | Type | Null |
|--------|------|------|
| `id` | bigint unsigned | NO |
| `service_job_id` | bigint unsigned | NO |
| `customer_id` | bigint unsigned | NO |
| `vehicle_id` | bigint unsigned | NO |
| `rating` | tinyint | NO |
| `comment` | text | YES |
| `platform` | enum | NO |
| `is_flagged` | tinyint(1) | NO |

**`platform` enum:** `rodz_app`, `google`, `facebook`, `none`

---

## Warranty

### `warranty_claims`

| Column | Type | Null |
|--------|------|------|
| `id` | bigint unsigned | NO |
| `original_job_item_id` | bigint unsigned | NO |
| `vehicle_id` | bigint unsigned | NO |
| `customer_id` | bigint unsigned | NO |
| `claim_date` | date | NO |
| `failure_description` | text | NO |
| `odometer_at_failure` | int unsigned | YES |
| `resolution` | enum | NO |
| `resolved_at` | datetime | YES |
| `replacement_job_id` | bigint unsigned | YES |
| `credit_amount` | decimal(10,2) | YES |

**`resolution` enum:** `pending`, `approved_replace`, `approved_refund`, `denied`, `escalated_to_supplier`

---

## Photos

### `photos`

| Column | Type | Null | Default |
|--------|------|------|---------|
| `id` | int unsigned | NO | — |
| `image_id` | varchar(255) | NO | — |
| `vehicle_rego` | varchar(20) | NO | — |
| `quote_id` | int unsigned | YES | — |
| `quote_item_id` | int unsigned | YES | — |
| `job_card_item_id` | int unsigned | YES | — |
| `invoice_id` | int unsigned | YES | — |
| `invoice_item_id` | int unsigned | YES | — |
| `uploaded_by` | int unsigned | NO | — |
| `caption` | varchar(255) | YES | — |
| `created_at` | datetime | NO | `CURRENT_TIMESTAMP` |

`image_id` is the Cloudflare Images image ID. Image URLs are derived at read time — never stored:
`https://imagedelivery.net/{CF_ACCOUNT_ID}/{image_id}/{variant}` where variant is `thumbnail` or `public`.

`quote_id` and `quote_item_id` are both nullable. A photo attached to a specific quote line item sets both. A photo for a quote but not a line item sets `quote_id` only. A general condition photo sets neither. `job_card_item_id` is set when a photo is attached to a job card checklist item. `invoice_id` and `invoice_item_id` follow the same pattern for invoices — photos are returned inline on each invoice item in all invoice responses.

---

## Staff notifications

### `staff_notifications`

In-app notification inbox for staff. Created when key events occur (booking received, quote approved, job completed, invoice paid). Delivered to connected clients via WebSocket push and persisted here for the inbox.

| Column | Type | Null | Default |
|--------|------|------|---------|
| `id` | bigint unsigned | NO | — |
| `staff_id` | bigint unsigned | NO | — |
| `store_id` | tinyint unsigned | YES | — |
| `type` | enum | NO | — |
| `title` | varchar(255) | NO | — |
| `body` | varchar(500) | NO | — |
| `booking_id` | bigint unsigned | YES | — |
| `quote_id` | bigint unsigned | YES | — |
| `job_id` | bigint unsigned | YES | — |
| `invoice_id` | bigint unsigned | YES | — |
| `read_at` | datetime | YES | — |
| `created_at` | datetime | NO | `CURRENT_TIMESTAMP` |

**`type` enum:** `booking_received`, `quote_approved`, `job_completed`, `invoice_paid`

`store_id` is `NULL` for `super_admin` connections (receives all stores). `read_at` is `NULL` until the staff member reads the notification.

---

## WebSocket connections

### `ws_connections`

Active WebSocket connections via API Gateway. Used to fan out real-time pushes to the correct staff. Rows are inserted on connect and deleted on disconnect; expired rows are cleaned up lazily.

| Column | Type | Null | Default |
|--------|------|------|---------|
| `connection_id` | varchar(255) | NO | — |
| `staff_id` | int unsigned | NO | — |
| `store_id` | int unsigned | YES | — |
| `role` | varchar(50) | NO | — |
| `connected_at` | datetime | NO | `CURRENT_TIMESTAMP` |
| `expires_at` | datetime | NO | — |

`store_id` is `NULL` for `super_admin` (receives pushes for all stores). `expires_at` is set to 2 hours after connect — API Gateway closes idle connections after 10 minutes, but the row lingers until next cleanup.

---

## Notes

### `customer_notes`

Free-text staff notes against a customer record. Append-only — no editing after posting.

| Column | Type | Null | Default |
|--------|------|------|---------|
| `id` | bigint unsigned | NO | — |
| `customer_id` | bigint unsigned | NO | — |
| `staff_id` | bigint unsigned | NO | — |
| `content` | text | NO | — |
| `created_at` | datetime | NO | `CURRENT_TIMESTAMP` |

---

### `vehicle_notes`

Free-text staff notes against a vehicle record. Append-only — no editing after posting.

| Column | Type | Null | Default |
|--------|------|------|---------|
| `id` | bigint unsigned | NO | — |
| `vehicle_id` | bigint unsigned | NO | — |
| `staff_id` | bigint unsigned | NO | — |
| `content` | text | NO | — |
| `created_at` | datetime | NO | `CURRENT_TIMESTAMP` |

---

## Premium — Expense tracker

### `vehicle_expenses` — **empty; S3 is source of truth**

As of 2026-07-14 the table exists (for the `fuel_station_prices` FK) but holds no rows. Expense detail lives in S3 at:

```
s3://rodz-data-lake/expenses/year=YYYY/month=MM/{id}.json    # non-fuel
s3://rodz-data-lake/fuel-fills/year=YYYY/month=MM/{id}.json  # fuel + ev_charging
```

Discoverable via `s3_event_index` where `event_type IN ('expenses', 'fuel-fills')`. The `s3_event_index.id` is the expense's stable API id. Aggregates live in `vehicle_expense_summary` + `vehicle_fuel_summary`.

The column definitions below are kept for reference — the S3 JSON payload follows the same shape (camelCase field names instead of snake_case).

| Column | Type | Null | Default |
|--------|------|------|---------|
| `id` | bigint unsigned | NO | — |
| `vehicle_id` | bigint unsigned | NO | — |
| `customer_id` | bigint unsigned | NO | — |
| `category` | enum | NO | — |
| `merchant_name` | varchar(200) | YES | — |
| `merchant_suburb` | varchar(100) | YES | — |
| `merchant_state` | char(3) | YES | — |
| `amount_aud` | decimal(10,2) | YES | — |
| `expense_date` | date | NO | — |
| `odometer_km` | int unsigned | YES | — |
| `fuel_type` | enum | YES | — |
| `fuel_litres` | decimal(8,3) | YES | — |
| `price_per_litre` | decimal(6,3) | YES | — |
| `ev_kwh` | decimal(8,3) | YES | — |
| `price_per_kwh` | decimal(6,3) | YES | — |
| `image_id` | varchar(255) | YES | — |
| `extraction_status` | enum | NO | `manual` |
| `ai_raw` | json | YES | — |
| `is_business_expense` | tinyint(1) | NO | `0` |
| `notes` | text | YES | — |
| `created_at` | datetime | NO | `CURRENT_TIMESTAMP` |
| `updated_at` | datetime | NO | `CURRENT_TIMESTAMP` |

**`category` enum:** `fuel`, `ev_charging`, `workshop`, `parts`, `car_wash`, `parking`, `tolls`, `registration`, `insurance`, `roadside`, `other`

**`fuel_type` enum:** `unleaded_91`, `unleaded_95`, `unleaded_98`, `diesel`, `lpg`, `e10`

**`extraction_status` enum:** `manual` (entered by hand), `extracted` (AI-populated from receipt scan), `failed` (scan attempted but unreadable)

**Indexes:** `(vehicle_id, expense_date)`, `(customer_id)`

**Foreign keys:** `vehicle_id → vehicles(id)`, `customer_id → customers(id)`

---

## Premium — Fuel price intelligence

### `fuel_station_prices`

Crowd-sourced fuel and EV charging prices. A row is inserted automatically whenever a customer confirms a fuel or EV expense that includes price data. Pump photos can contribute prices for multiple fuel types in a single entry via the `allFuelPrices` field on the expense create endpoint.

| Column | Type | Null | Default |
|--------|------|------|---------|
| `id` | bigint unsigned | NO | — |
| `expense_id` | bigint unsigned | YES | — |
| `customer_id` | bigint unsigned | NO | — |
| `station_name` | varchar(200) | NO | — |
| `station_suburb` | varchar(100) | YES | — |
| `station_state` | char(3) | YES | — |
| `fuel_type` | enum | NO | — |
| `price` | decimal(6,3) | NO | — |
| `price_unit` | enum | NO | `per_litre` |
| `image_id` | varchar(255) | YES | — |
| `reported_at` | datetime | NO | — |
| `created_at` | datetime | NO | `CURRENT_TIMESTAMP` |

**`fuel_type` enum:** `unleaded_91`, `unleaded_95`, `unleaded_98`, `diesel`, `lpg`, `e10`, `ev_kwh`

**`price_unit` enum:** `per_litre`, `per_kwh`

`reported_at` is the `expense_date` of the source expense (the date the price was observed), not the insert time. `expense_id` is `NULL` for prices contributed from pump photos without a personal expense.

**Indexes:** `(station_name, station_suburb, fuel_type)`, `(reported_at)`, `(station_suburb, station_state, fuel_type)`

**Foreign keys:** `expense_id → vehicle_expenses(id) ON DELETE SET NULL`, `customer_id → customers(id)`

---

## Premium — Logbook import

### `vehicle_service_log_external`

Customer-imported workshop invoices and service records from garages outside the Rodz network. Entries are created by photographing a paper invoice — AI extracts the fields and the customer reviews/corrects them. These entries are merged into the vehicle logbook timeline alongside Rodz workshop jobs.

Also populated automatically when a customer logs a `workshop` category expense in the expense tracker.

| Column | Type | Null | Default |
|--------|------|------|---------|
| `id` | bigint unsigned | NO | — |
| `vehicle_id` | bigint unsigned | NO | — |
| `customer_id` | bigint unsigned | NO | — |
| `image_id` | varchar(255) | NO | — |
| `workshop_name` | varchar(200) | YES | — |
| `workshop_suburb` | varchar(100) | YES | — |
| `service_date` | date | YES | — |
| `odometer_km` | int unsigned | YES | — |
| `services` | text | YES | — |
| `amount_aud` | decimal(10,2) | YES | — |
| `invoice_number` | varchar(100) | YES | — |
| `ai_raw` | json | YES | — |
| `status` | enum | NO | `pending` |
| `created_at` | datetime | NO | `CURRENT_TIMESTAMP` |
| `updated_at` | datetime | NO | `CURRENT_TIMESTAMP` |

**`status` enum:** `pending`, `extracted` (AI successfully read the image), `failed` (image unreadable — customer fills in manually)

`services` is a plain-English summary of work done, AI-generated from the invoice. `ai_raw` stores the full Gemini response for debugging.

**Indexes:** `(vehicle_id)`, `(service_date)`

---

## Data lake index

### `s3_event_index`

Pointer table that makes S3 objects queryable by vehicle + event type + date without listing the bucket. Every fuel-fill, expense, chat session, etc. gets a row here alongside its S3 object. `amount_aud` and `category` are denormalised so per-vehicle aggregates can be computed without S3 fetches.

| Column | Type | Null | Default |
|--------|------|------|---------|
| `id` | bigint unsigned | NO | Auto increment — used as the API's stable id for expenses |
| `vehicle_id` | bigint unsigned | YES | FK → `vehicles.id` (ON DELETE SET NULL) |
| `customer_id` | bigint unsigned | YES | FK → `customers.id` (ON DELETE SET NULL) |
| `event_type` | enum | NO | See below |
| `s3_key` | varchar(500) | NO | Full S3 key — read via `readFromDataLake(key)` |
| `event_date` | datetime | NO | Business-relevant date (expense_date for expenses, session start for chats) |
| `summary` | varchar(500) | YES | Short one-liner for eyeballing the index |
| `amount_aud` | decimal(10,2) | YES | Denormalised for financial-event rollups (null for non-financial) |
| `category` | varchar(30) | YES | Denormalised for grouped queries (null for non-categorised) |
| `key_topics` | json | YES | Optional structured metadata |
| `created_at` | datetime | NO | `CURRENT_TIMESTAMP` |

**`event_type` enum:** `diagnostic-sessions`, `jobs-detail`, `fuel-fills`, `expenses`, `assistant-questions`, `warning-lights`, `diagnostic-outcomes`

**Indexes:**
- `(vehicle_id, event_type, event_date)` — most common per-vehicle history query
- `(customer_id, event_type, event_date)` — cross-vehicle customer views
- `(event_type, event_date)` — cross-fleet analytics
- `(vehicle_id, event_type, event_date, amount_aud)` — summary aggregation

`ON DELETE SET NULL` on both FKs — if a vehicle or customer is removed, the pointer rows survive so we don't orphan S3 objects.

---

## Vehicle health & maintenance

### `vehicle_health_scores`

Per-vehicle rollup used by the customer portal's health-summary widget. Updated on every job completion.

| Column | Type | Null | Notes |
|--------|------|------|-------|
| `vehicle_id` | bigint unsigned | NO | PRIMARY KEY, FK → `vehicles.id` |
| `overall_score` | tinyint unsigned | YES | 0–100 |
| `engine_score` | tinyint unsigned | YES | 0–100 |
| `brakes_score` | tinyint unsigned | YES | 0–100 |
| `tyres_score` | tinyint unsigned | YES | 0–100 |
| `service_compliance` | tinyint unsigned | YES | 0–100 |
| `last_service_date` | date | YES | — |
| `next_service_due` | date | YES | — |
| `overdue_items_count` | tinyint unsigned | NO | Default `0` |
| `calculated_at` | datetime | NO | `CURRENT_TIMESTAMP ON UPDATE` |

One row per vehicle max. Bounded forever.

---

### `maintenance_schedule`

Per-vehicle per-item next-service schedule (oil, brake fluid, timing belt, etc.). Populated + updated by the AI recommendation engine on every service completion.

| Column | Type | Null | Notes |
|--------|------|------|-------|
| `id` | bigint unsigned | NO | Auto increment |
| `vehicle_id` | bigint unsigned | NO | FK → `vehicles.id` |
| `item_name` | varchar(100) | NO | e.g. `oil_service`, `brake_fluid`, `timing_belt` |
| `last_done_date` | date | YES | — |
| `last_done_km` | int unsigned | YES | — |
| `next_due_date` | date | YES | — |
| `next_due_km` | int unsigned | YES | — |
| `status` | enum(`ok`, `due_soon`, `overdue`) | NO | Default `ok` |
| `urgency` | enum(`low`, `medium`, `high`) | NO | Default `low` |
| `estimated_cost` | decimal(8,2) | YES | AUD |
| `updated_at` | datetime | NO | `CURRENT_TIMESTAMP ON UPDATE` |

**Unique key:** `(vehicle_id, item_name)` — one row per item per vehicle.

---

## Assistant memory

### `assistant_memory`

Per-vehicle scratchpad the AI can write to via the `remember` tool. Notes are re-injected into future chat sessions so the assistant appears to remember prior conversations. Scoped to `vehicle_id` (not `customer_id`) so memories transfer with the vehicle on sale.

| Column | Type | Null | Notes |
|--------|------|------|-------|
| `id` | bigint unsigned | NO | Auto increment |
| `vehicle_id` | bigint unsigned | NO | FK → `vehicles.id` ON DELETE CASCADE |
| `note` | varchar(500) | NO | Max 500 chars — AI writes short factual notes |
| `source` | enum(`assistant`, `customer`, `system`) | NO | Default `assistant` |
| `created_at` | datetime | NO | `CURRENT_TIMESTAMP` |
| `expires_at` | datetime | YES | Default: 180 days from creation. Filtered out when in the past. |
| `deleted_at` | datetime | YES | Soft delete — user or `forget` tool can remove |

- **Cap: 20 active notes per vehicle.** When writing a 21st, the oldest active note is soft-deleted.
- Read path filters `deleted_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())`
- Index: `(vehicle_id, deleted_at, expires_at)`

---

## Summary tables (aggregates)

These tables are **recomputed on every write** to the underlying data (via `refreshVehicleSummaries` in `src/shared/summaries.ts`). One row per vehicle max. Bounded forever.

### `vehicle_fuel_summary`

| Column | Type | Null | Notes |
|--------|------|------|-------|
| `vehicle_id` | bigint unsigned | NO | PRIMARY KEY, FK → `vehicles.id` |
| `last_fill_date` | date | YES | — |
| `last_fill_litres` | decimal(6,2) | YES | — |
| `last_fill_price` | decimal(6,2) | YES | c/L |
| `avg_consumption_l100km` | decimal(5,2) | YES | Computed across YTD fills |
| `total_fuel_spend_ytd` | decimal(10,2) | NO | Default `0` |
| `total_litres_ytd` | decimal(10,2) | NO | Default `0` |
| `fill_count_ytd` | int unsigned | NO | Default `0` |
| `updated_at` | datetime | NO | `CURRENT_TIMESTAMP ON UPDATE` |

Populated from `s3_event_index` rows where `event_type = 'fuel-fills'`, plus one S3 GET per fill for `litres` (not in the index).

---

### `vehicle_expense_summary`

| Column | Type | Null | Notes |
|--------|------|------|-------|
| `vehicle_id` | bigint unsigned | NO | PRIMARY KEY, FK → `vehicles.id` |
| `total_spend_mtd` | decimal(10,2) | NO | Default `0` — this calendar month |
| `total_spend_ytd` | decimal(10,2) | NO | Default `0` — this calendar year |
| `fuel_spend_ytd` | decimal(10,2) | NO | Default `0` |
| `service_spend_ytd` | decimal(10,2) | NO | Default `0` |
| `other_spend_ytd` | decimal(10,2) | NO | Default `0` |
| `cost_per_km` | decimal(6,2) | YES | Approx cost per km driven |
| `updated_at` | datetime | NO | `CURRENT_TIMESTAMP ON UPDATE` |

Computed entirely from `s3_event_index` (uses denormalised `amount_aud + category` columns — zero S3 fetches).

**Foreign keys:** `vehicle_id → vehicles(id)`, `customer_id → customers(id)`

---

## AI prompt versioning & feedback

Closes the loop between customer feedback on AI replies and the live assistant prompt. Customers 👍/👎 individual AI messages (`chat_message_feedback`), a super-admin reviews the accumulated 👎s (Gemini clusters themes + proposes edits), the operator applies chosen edits which save as a new active row in `prompt_versions`. The chat handler + all specialist agents read the active version on every request.

Migrations:
- `docs/migrations/chat_message_feedback.sql`
- `docs/migrations/prompt_versions.sql`

Endpoints (all super-admin unless noted):
- Customer-facing: `PUT /c/vehicles/{id}/chats/{sessionId}/messages/{messageId}/feedback` — customer submits 👍/👎.
- Admin review: `GET /admin/chat-feedback`, `POST /admin/chat-feedback/review` (Gemini review).
- Admin prompt CRUD: `GET /admin/prompts` (filters + pagination + lite mode), `GET /admin/prompts/{id}` (full detail), `POST /admin/prompts` (manual save), `POST /admin/prompts/apply-edits` (from Rodz review), `POST /admin/prompts/{id}/activate` (revert — creates a new row with `source = 'revert'`).

Frontend briefs: `docs/chat-message-feedback-frontend-brief.md`, `docs/admin-chat-feedback-frontend-brief.md`, `docs/admin-chat-feedback-applied-flag-brief.md`, `docs/admin-prompts-frontend-brief.md`, `docs/admin-prompts-search-brief.md`.

---

### `chat_message_feedback`

Per-customer 👍/👎 rating on individual AI chat messages. One row per (customer, message). Idempotent PUT upsert — same customer rating the same message replaces the row; rating: null deletes it.

| Column | Type | Null | Notes |
|--------|------|------|-------|
| `id` | bigint unsigned | NO | PRIMARY KEY, AUTO_INCREMENT |
| `customer_id` | bigint unsigned | NO | FK → `customers.id` |
| `vehicle_id` | bigint unsigned | NO | FK → `vehicles.id` |
| `session_id` | bigint unsigned | NO | FK → `customer_chat_sessions.id` |
| `message_id` | varchar(80) | NO | S3 message id (string, e.g. `1784158472547-0-b10446`). Never coerce to number. |
| `rating` | enum | NO | `up` \| `down` |
| `reason` | varchar(500) | YES | Optional freetext, used mostly with 👎 |
| `prompt_version` | varchar(40) | YES | The `version_label` of `prompt_versions` that produced the AI reply. Correlates ratings to prompt iterations. |
| `created_at` | datetime | NO | Default `CURRENT_TIMESTAMP` |
| `updated_at` | datetime | NO | `ON UPDATE CURRENT_TIMESTAMP` |

Unique key: `uk_customer_message (customer_id, message_id)` — enforces idempotent upsert.

Indexes:
- `idx_session (session_id, created_at)` — for session-history feedback lookup.
- `idx_rating_date (rating, created_at)` — for admin review windowed queries.
- `idx_prompt_rating (prompt_version, rating)` — for per-version up-rate aggregation.

Detail (message text itself) lives in the S3 session blob at `s3://rodz-data-lake/diagnostic-sessions/current/{sessionId}.json` — this table stores only the customer's opinion of a given message.

Foreign keys cascade on customer/vehicle/session delete.

---

### `prompt_versions`

The assistant's live prompt, versioned. Exactly one row is active at any time (enforced by the virtual `_active_lock` column + UNIQUE trick — same pattern as `vehicle_policies`). Every save, review-apply, or revert writes a NEW immutable row and flips the active flag in one transaction. The chat handler reads the active row on every request via `loadActivePrompt()` (cached in Redis 30s).

| Column | Type | Null | Notes |
|--------|------|------|-------|
| `id` | bigint unsigned | NO | PRIMARY KEY, AUTO_INCREMENT |
| `version_label` | varchar(80) | NO | UNIQUE. Format: `v{N}-{YYYY-MM-DD}-{HH:mm}[-slug]`. N monotonically increases across all rows (never re-uses a number, even after reverts). |
| `base_prompt` | mediumtext | NO | Full static persona text — persona blocks, values, workshop framing, diagnosis flow, safety rails, coverage guidance, etc. What the chat handler sees as the main system prompt. |
| `learned_guidance` | json | NO | Array of accumulated guidance entries applied from Rodz's review-of-👎 workflow. Empty array on manual saves that don't carry guidance. |
| `notes` | varchar(500) | YES | Freetext "why this change" — read in the version list. |
| `source` | enum | NO | `manual` \| `review-apply` \| `revert`. Default `manual`. |
| `source_review` | json | YES | Metadata about the review that produced a `review-apply` row: `{ windowDays, cached, reviewedCount }`. |
| `parent_version_id` | bigint unsigned | YES | FK → `prompt_versions.id`. The version this one was saved on top of. Null only on the initial seed. |
| `saved_by` | bigint unsigned | NO | FK → `staff.id`. Attribution. |
| `saved_at` | datetime | NO | Default `CURRENT_TIMESTAMP` |
| `is_active` | tinyint(1) | NO | Default `0`. Exactly one row has `1` at any time. |
| `_active_lock` | tinyint(1) | — | **Virtual/generated** — `IF(is_active = 1, 1, NULL)`. Do NOT insert or update. Paired with UNIQUE index below. |

Unique keys:
- `uk_version_label (version_label)`
- `uk_active_lock (_active_lock)` — the virtual-column trick: `_active_lock` is `1` for the active row and `NULL` otherwise; MySQL treats NULLs in a UNIQUE as distinct, so only one row can be active at a time.

Other indexes: `idx_saved_at (saved_at DESC)` for the version list.

**`learned_guidance` JSON shape** — array of:
```jsonc
{
  "instruction":  "…",
  "rationale":    "…",
  "target":       "system-prompt" | "agent",
  "agentName":    null | "booking" | "expense" | "fuel" | "vehicle" | "logbook" | "quote",
  "addedAt":      "2026-07-20T14:29:11.000Z",
  "addedBy":      <staff.id>,
  "fromReview":   { "windowDays": 7, "reviewedCount": 12 } | null
}
```

The chat handler composes the final system prompt as: `{preamble} + {base_prompt} + {dynamic scaffolding} + {learned_guidance filtered by target = 'system-prompt'}`. Each specialist agent composes: `{preamble} + {agent-specific instructions} + {learned_guidance filtered by target = 'agent' AND agentName = <this agent>}`.

Foreign keys:
- `parent_version_id → prompt_versions(id)` (ON DELETE SET NULL)
- `saved_by → staff(id)` (ON DELETE RESTRICT — attribution must survive)
