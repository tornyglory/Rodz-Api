# Database Schema Reference

Use this when building endpoints. Covers all tables, key columns, enum values, and relationships.

---

## Table index

| Group | Tables |
|-------|--------|
| [Core](#core) | `stores`, `staff`, `customers`, `vehicles`, `vehicle_owners` |
| [Bookings](#bookings) | `bookings`, `booking_services` |
| [Jobs](#jobs) | `service_jobs`, `service_job_items`, `service_job_parts`, `service_job_staff` |
| [Financials](#financials) | `invoices`, `payments`, `quotes`, `quote_items`, `purchase_orders`, `purchase_order_items` |
| [Catalog](#catalog) | `service_types`, `catalog_items`, `parts` |
| [Inspections](#inspections) | `job_inspections`, `job_inspection_results`, `inspection_checklist_items`, `job_documents` |
| [Customers — extended](#customers--extended) | `customer_tags`, `customer_communications`, `loyalty_transactions` |
| [Vehicles — extended](#vehicles--extended) | `vehicle_service_history` |
| [Reminders & AI](#reminders--ai) | `reminders`, `ai_milestone_rules`, `ai_recommendations` |
| [Notifications](#notifications) | `notifications`, `notification_templates` |
| [Loan vehicles](#loan-vehicles) | `loan_vehicles`, `loan_vehicle_bookings` |
| [Operations](#operations) | `hoists`, `business_hours`, `staff_roster`, `daily_kpi_snapshots` |
| [Auth](#auth) | `staff_auth`, `staff_sessions`, `customer_auth`, `customer_sessions`, `customer_oauth_providers` |
| [Permissions](#permissions) | `permissions`, `role_permissions`, `staff_permission_overrides`, `staff_store_access` |
| [Integrations](#integrations) | `xero_connections`, `xero_sync_log` |
| [Settings](#settings) | `email_settings`, `staff_email_settings` |
| [Audit](#audit) | `audit_log` |
| [Reviews](#reviews) | `reviews` |
| [Warranty](#warranty) | `warranty_claims` |

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
| `is_active` | tinyint(1) | NO | `1` |
| `opened_date` | date | YES | — |
| `created_at` | datetime | NO | `CURRENT_TIMESTAMP` |
| `updated_at` | datetime | NO | `CURRENT_TIMESTAMP` |

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

---

### `service_job_parts`

Parts tracking on a job (requested, ordered, arrived).

| Column | Type | Null |
|--------|------|------|
| `id` | bigint unsigned | NO |
| `service_job_id` | bigint unsigned | NO |
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

## Financials

### `invoices`

| Column | Type | Null |
|--------|------|------|
| `id` | bigint unsigned | NO |
| `invoice_number` | varchar(15) | NO |
| `service_job_id` | bigint unsigned | NO |
| `quote_id` | bigint unsigned | YES |
| `customer_id` | bigint unsigned | NO |
| `subtotal` | decimal(10,2) | NO |
| `gst_amount` | decimal(10,2) | NO |
| `total` | decimal(10,2) | NO |
| `amount_paid` | decimal(10,2) | NO |
| `amount_owing` | decimal(10,2) | YES |
| `status` | enum | NO |
| `due_date` | date | YES |
| `sent_at` | datetime | YES |
| `paid_at` | datetime | YES |
| `xero_invoice_id` | varchar(100) | YES |
| `xero_invoice_number` | varchar(50) | YES |
| `xero_invoice_url` | varchar(500) | YES |
| `xero_sync_status` | enum | NO |
| `xero_synced_at` | datetime | YES |
| `notes` | text | YES |
| `created_at` | datetime | NO |
| `updated_at` | datetime | NO |

**`status` enum:** `draft`, `sent`, `unpaid`, `partial`, `paid`, `void`, `refunded`

**`xero_sync_status` enum:** `pending`, `synced`, `failed`, `skipped`

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

---

### `purchase_orders` / `purchase_order_items`

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

**`status` enum:** `draft`, `ordered`, `partial`, `received`, `cancelled`

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

### `parts`

Inventory parts.

| Column | Type | Null |
|--------|------|------|
| `id` | bigint unsigned | NO |
| `part_number` | varchar(60) | NO |
| `name` | varchar(150) | NO |
| `category` | varchar(60) | YES |
| `supplier` | varchar(80) | YES |
| `supplier_part_number` | varchar(60) | YES |
| `cost_price` | decimal(10,2) | NO |
| `sell_price` | decimal(10,2) | NO |
| `gst_applicable` | tinyint(1) | NO |
| `stock_on_hand` | int | NO |
| `reorder_point` | int | NO |
| `is_active` | tinyint(1) | NO |

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

### `ai_milestone_rules` / `ai_recommendations`

Rules engine for proactive service recommendations. `ai_recommendations` are generated instances linked to a vehicle and customer.

Key `ai_recommendations` columns: `vehicle_id`, `customer_id`, `rule_id`, `status`, `urgency`, `triggered_at_odometer`, `triggered_at_date`, `estimated_due_date`, `completed_by_job_id`

**`status` enum:** `active`, `sent`, `acknowledged`, `dismissed`, `completed`, `expired`

**`urgency` enum:** `advisory`, `recommended`, `important`, `urgent`

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

**`status` enum:** `queued`, `sent`, `delivered`, `opened`, `clicked`, `failed`, `bounced`, `unsubscribed`

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
