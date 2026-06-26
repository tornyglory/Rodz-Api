CREATE TABLE customer_notes (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  customer_id BIGINT UNSIGNED NOT NULL,
  staff_id    BIGINT UNSIGNED NOT NULL,
  content     TEXT            NOT NULL,
  created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
  FOREIGN KEY (staff_id)    REFERENCES staff(id)     ON DELETE RESTRICT,
  INDEX idx_customer_notes_customer (customer_id),
  INDEX idx_customer_notes_created  (customer_id, created_at DESC)
);

CREATE TABLE vehicle_notes (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  vehicle_id BIGINT UNSIGNED NOT NULL,
  staff_id   BIGINT UNSIGNED NOT NULL,
  content    TEXT            NOT NULL,
  created_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (vehicle_id) REFERENCES vehicles(id) ON DELETE CASCADE,
  FOREIGN KEY (staff_id)   REFERENCES staff(id)    ON DELETE RESTRICT,
  INDEX idx_vehicle_notes_vehicle (vehicle_id),
  INDEX idx_vehicle_notes_created (vehicle_id, created_at DESC)
);
