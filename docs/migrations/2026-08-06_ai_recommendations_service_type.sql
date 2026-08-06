-- Link each AI maintenance recommendation to the workshop service that
-- fulfils it, so the frontend "Book this" button can open the booking
-- flow with the correct service preselected.
--
-- ON DELETE SET NULL — deactivating a service_type must never nuke
-- customer recommendations. The frontend downgrades to a plain
-- "Book a service" button when service_type_id is null.

ALTER TABLE ai_recommendations
  ADD COLUMN service_type_id BIGINT UNSIGNED NULL AFTER rule_id,
  ADD CONSTRAINT fk_ai_rec_service_type
    FOREIGN KEY (service_type_id) REFERENCES service_types(id) ON DELETE SET NULL,
  ADD INDEX idx_service_type (service_type_id);
