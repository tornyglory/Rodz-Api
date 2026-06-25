-- Staff notification inbox
-- Run once against the rodz database

CREATE TABLE IF NOT EXISTS staff_notifications (
  id           BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  staff_id     BIGINT UNSIGNED  NOT NULL,
  store_id     TINYINT UNSIGNED NULL,
  type         ENUM('booking_received','quote_approved','job_completed','invoice_paid') NOT NULL,
  title        VARCHAR(255)     NOT NULL,
  body         VARCHAR(500)     NOT NULL,
  booking_id   BIGINT UNSIGNED  NULL,
  quote_id     BIGINT UNSIGNED  NULL,
  job_id       BIGINT UNSIGNED  NULL,
  invoice_id   BIGINT UNSIGNED  NULL,
  read_at      DATETIME         NULL,
  created_at   DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_staff_notifications_staff     (staff_id),
  KEY idx_staff_notifications_unread    (staff_id, read_at),
  KEY idx_staff_notifications_store     (store_id)
);
