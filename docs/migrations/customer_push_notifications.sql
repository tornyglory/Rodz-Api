-- Push notification infrastructure for Phase 1 ambient-presence work.
-- Three tables:
--   customer_push_tokens        — device tokens (APNs / FCM), one per device
--   customer_notification_prefs — per-customer topic opt-outs + quiet hours
--   notification_events         — audit + dedupe + rate-limit source of truth
--
-- Backend brief: docs/ambient-presence-phase1-spec.md
-- Frontend brief: rodz-staff/docs/endpoints/push-notifications-customer.md

CREATE TABLE customer_push_tokens (
  id            BIGINT UNSIGNED       NOT NULL AUTO_INCREMENT PRIMARY KEY,
  customer_id   BIGINT UNSIGNED       NOT NULL,
  token         VARCHAR(512)          NOT NULL,
  platform      ENUM('ios','android') NOT NULL,
  label         VARCHAR(200)          NULL,
  created_at    DATETIME              NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at  DATETIME              NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_token (token),
  KEY idx_customer (customer_id),
  CONSTRAINT fk_push_token_customer FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- One row per customer max. Absence = opted in (defaults on). We upsert on
-- first pref change. Kept flat (one column per topic) for cheap lookups.
CREATE TABLE customer_notification_prefs (
  customer_id       BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  service_due       TINYINT(1)      NOT NULL DEFAULT 1,
  rego_expiring     TINYINT(1)      NOT NULL DEFAULT 1,
  booking           TINYINT(1)      NOT NULL DEFAULT 1,
  quote             TINYINT(1)      NOT NULL DEFAULT 1,
  invoice           TINYINT(1)      NOT NULL DEFAULT 1,
  urgent_reco       TINYINT(1)      NOT NULL DEFAULT 1,
  workshop_message  TINYINT(1)      NOT NULL DEFAULT 1,
  quiet_hours_start TIME            NULL,
  quiet_hours_end   TIME            NULL,
  updated_at        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_notif_prefs_customer FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Every push we attempt. Powers dedupe (`event_id`), rate-limit checks
-- (per-topic-per-day / per-customer-per-day), and a future in-app history.
CREATE TABLE notification_events (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  customer_id   BIGINT UNSIGNED NOT NULL,
  vehicle_id    BIGINT UNSIGNED NULL,
  event_id      VARCHAR(80)     NOT NULL,    -- e.g. 'quote:87' for dedupe
  type          VARCHAR(40)     NOT NULL,    -- push type from the frontend brief
  title         VARCHAR(200)    NOT NULL,
  body          VARCHAR(500)    NOT NULL,
  deeplink      VARCHAR(300)    NOT NULL,
  sent_at       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_customer_type_sent (customer_id, type, sent_at),
  KEY idx_event               (event_id),
  CONSTRAINT fk_notif_event_customer FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
  CONSTRAINT fk_notif_event_vehicle  FOREIGN KEY (vehicle_id)  REFERENCES vehicles(id)  ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Rate-limit checks (used by src/shared/push.ts before sending):
--   -- per-topic-per-day-per-vehicle
--   SELECT COUNT(*) FROM notification_events
--   WHERE customer_id = ? AND type = ? AND vehicle_id <=> ? AND sent_at >= CURDATE();
--
--   -- baseline cap (per-customer-per-day)
--   SELECT COUNT(*) FROM notification_events
--   WHERE customer_id = ? AND sent_at >= CURDATE();
--
--   -- dedupe
--   SELECT 1 FROM notification_events
--   WHERE event_id = ? AND sent_at >= DATE_SUB(NOW(), INTERVAL 30 DAY) LIMIT 1;
