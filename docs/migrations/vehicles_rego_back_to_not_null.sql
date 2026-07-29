-- Correction to vehicles_partial_guest_data.sql — rego is REQUIRED on
-- the guest booking flow, not optional. Only model was intended to
-- become nullable. Reverts vehicles.rego back to NOT NULL so the DB
-- schema matches the actual application constraint.
--
-- No rows should have NULL rego yet — the earlier migration relaxed
-- the constraint but no writes have happened since; the handler has
-- always required rego so a NULL couldn't have landed.

ALTER TABLE vehicles
  MODIFY COLUMN rego VARCHAR(10) NOT NULL;
