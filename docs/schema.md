# Database Schema Reference

Use this when building endpoints. Covers all tables, key columns, enum values, and relationships.

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
| [Reminders & AI](#reminders--ai) | `reminders`, `vehicle_model_profiles`, `ai_milestone_rules`, `ai_recommendations` |
| [Vehicle chats](#vehicle-chats) | `vehicle_chats`, `vehicle_chat_messages` |
| [Customer AI chat](#customer-ai-chat) | `customer_chat_sessions`, `customer_vehicle_chats` |
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
| [Premium — Expense tracker](#premium--expense-tracker) | `vehicle_expenses` |
| [Premium — Fuel price intelligence](#premium--fuel-price-intelligence) | `fuel_station_prices` |
| [Premium — Logbook import](#premium--logbook-import) | `vehicle_service_log_external` |

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
| `preferred_contact` | enum | NO | `mobile` |
| `marketing_opt_in` | tinyint(1) | NO | `1` |
| `sms_opt_in` | tinyint(1) | NO | `1` |
| `push_opt_in` | tinyint(1) | NO | `1` |
| `date_of_birth` | date | YES | — |
| `referral_source` | enum | YES | — |
| `referral_detail` | varchar(255) | YES | — |
| `customer_since` | date | YES | — |
| `loyalty_points` | int unsigned | NO | `0` |
| `xero_contact_id` | varchar(100) | YES | — |
| `internal_notes` | text | YES | — |
| `is_active` | tinyint(1) | NO | `1` |
| `created_at` | datetime | NO | `CURRENT_TIMESTAMP` |
| `updated_at` | datetime | NO | `CURRENT_TIMESTAMP` |

**`preferred_contact` enum:** `mobile`, `email`, `sms`, `app`

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

Generated maintenance recommendations per vehicle, produced by the Gemini-powered recommendation engine. Rebuilt from scratch on each engine run (active records deleted and re-inserted).

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

**`status` enum:** `active`, `sent`, `acknowledged`, `dismissed`, `completed`

The reminder dispatcher queries `status = 'active'` records where `estimated_due_odometer` is within 2,000 km of the vehicle's predicted current odometer (using `odometer_current + days_since_recorded × 41 km/day`).

**`status` enum:** `active`, `sent`, `acknowledged`, `dismissed`, `completed`, `expired`

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

Groups chat messages into named sessions. A customer can have multiple sessions per vehicle — each gets an auto-generated title from the first message via Gemini. Separate from the staff-side chat tables.

| Column | Type | Null | Notes |
|--------|------|------|-------|
| `id` | bigint unsigned | NO | Auto increment |
| `vehicle_id` | bigint unsigned | NO | FK → `vehicles.id` |
| `customer_id` | bigint unsigned | NO | FK → `customers.id` |
| `title` | varchar(255) | YES | AI-generated title — null until first message processed |
| `created_at` | datetime | NO | `CURRENT_TIMESTAMP` |
| `updated_at` | datetime | NO | `CURRENT_TIMESTAMP ON UPDATE` — bumped on every new message |

- `updated_at` is used to sort sessions newest-first in the session list
- Index: `(vehicle_id, customer_id)`

---

### `customer_vehicle_chats`

Individual messages within a customer chat session. One row per message (user or AI). Separate from the staff-side `vehicle_chats`/`vehicle_chat_messages` tables.

| Column | Type | Null | Notes |
|--------|------|------|-------|
| `id` | bigint unsigned | NO | Auto increment |
| `vehicle_id` | bigint unsigned | NO | FK → `vehicles.id` |
| `customer_id` | bigint unsigned | NO | FK → `customers.id` |
| `session_id` | bigint unsigned | NO | FK → `customer_chat_sessions.id` |
| `role` | enum(`user`, `model`) | NO | `user` = customer message, `model` = AI response |
| `content` | text | YES | Null for image-only messages or tool-call-only turns |
| `image_id` | varchar(255) | YES | Cloudflare Images ID — use `imageUrls(imageId)` for URLs |
| `tool_calls` | json | YES | Gemini function call history for multi-turn tool use |
| `created_at` | datetime | NO | `CURRENT_TIMESTAMP` |

- Always filter by `vehicle_id`, `customer_id`, AND `session_id` — never query cross-session
- Ownership verified via `vehicle_owners` and `customer_chat_sessions` before reading or writing
- History returned ordered by `id ASC`
- Index: `(vehicle_id, customer_id)`

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

### `vehicle_expenses`

Every cost associated with a vehicle — fuel, servicing, registration, insurance, tolls, parts, etc. Customers log expenses manually or by scanning a receipt via AI. Workshop entries are dual-written to `vehicle_service_log_external`.

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

**Foreign keys:** `vehicle_id → vehicles(id)`, `customer_id → customers(id)`
