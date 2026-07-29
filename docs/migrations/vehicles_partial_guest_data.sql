-- Relax vehicles NOT NULL so guest bookings can proceed with minimum
-- information (year + make only). Model and rego frequently unknown by
-- guests — workshop fills them in when the car arrives.
--
-- rego is being relaxed from NOT NULL → NULL. The existing
-- uq_vehicles_rego UNIQUE (rego, rego_state) index continues to work
-- since MySQL allows multiple NULL rows in a UNIQUE index. Practical
-- consequence: vehicles inserted without a rego cannot be deduped on
-- future bookings — each guest booking creates a new vehicle row.
-- Staff merge duplicates in the workshop once they have the plate.
--
-- year + make stay NOT NULL — those are the minimum viable identity
-- for the workshop to prep and the AI engines to have anything to
-- work with.

ALTER TABLE vehicles
  MODIFY COLUMN model VARCHAR(60) NULL;

ALTER TABLE vehicles
  MODIFY COLUMN rego VARCHAR(10) NULL;
