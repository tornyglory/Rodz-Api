-- Attach the parts required for each AI recommendation as a JSON array
-- of part_name_ids. Vehicle-specific (the engine sees the vehicle when
-- it picks them) and task-specific (a Timing Belt Service pulls in
-- water pump + coolant, a routine oil service doesn't).
--
-- Foreign-key integrity is not enforced by the DB — MySQL can't put
-- FKs on JSON array elements. The engine validates against the active
-- part_names set at write time, and read paths filter to active ids at
-- render time, so a deactivated part just disappears from the card.

ALTER TABLE ai_recommendations
  ADD COLUMN part_name_ids JSON NULL AFTER service_type_id;
