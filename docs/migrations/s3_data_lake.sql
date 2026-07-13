-- S3 data-lake index + summary tables. MySQL never holds detail; it holds
-- pointers to S3 (s3_event_index) and per-vehicle aggregates (summary tables).

CREATE TABLE s3_event_index (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  vehicle_id   BIGINT UNSIGNED NULL,
  customer_id  BIGINT UNSIGNED NULL,
  event_type   ENUM('diagnostic-sessions','jobs-detail','fuel-fills','expenses',
                    'assistant-questions','warning-lights','diagnostic-outcomes') NOT NULL,
  s3_key       VARCHAR(500) NOT NULL,
  event_date   DATETIME     NOT NULL,
  summary      VARCHAR(500) NULL,
  key_topics   JSON         NULL,
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,

  INDEX idx_vehicle_event_date  (vehicle_id,  event_type, event_date),
  INDEX idx_customer_event_date (customer_id, event_type, event_date),
  INDEX idx_event_date          (event_type,  event_date),

  FOREIGN KEY (vehicle_id)  REFERENCES vehicles(id)  ON DELETE SET NULL,
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE vehicle_fuel_summary (
  vehicle_id             BIGINT UNSIGNED PRIMARY KEY,
  last_fill_date         DATE          NULL,
  last_fill_litres       DECIMAL(6,2)  NULL,
  last_fill_price        DECIMAL(6,2)  NULL,
  avg_consumption_l100km DECIMAL(5,2)  NULL,
  total_fuel_spend_ytd   DECIMAL(10,2) NOT NULL DEFAULT 0,
  total_litres_ytd       DECIMAL(10,2) NOT NULL DEFAULT 0,
  fill_count_ytd         INT UNSIGNED  NOT NULL DEFAULT 0,
  updated_at             DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (vehicle_id) REFERENCES vehicles(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE vehicle_expense_summary (
  vehicle_id            BIGINT UNSIGNED PRIMARY KEY,
  total_spend_mtd       DECIMAL(10,2) NOT NULL DEFAULT 0,
  total_spend_ytd       DECIMAL(10,2) NOT NULL DEFAULT 0,
  fuel_spend_ytd        DECIMAL(10,2) NOT NULL DEFAULT 0,
  service_spend_ytd     DECIMAL(10,2) NOT NULL DEFAULT 0,
  other_spend_ytd       DECIMAL(10,2) NOT NULL DEFAULT 0,
  cost_per_km           DECIMAL(6,2)  NULL,
  updated_at            DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (vehicle_id) REFERENCES vehicles(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE vehicle_health_scores (
  vehicle_id          BIGINT UNSIGNED PRIMARY KEY,
  overall_score       TINYINT UNSIGNED NULL,
  engine_score        TINYINT UNSIGNED NULL,
  brakes_score        TINYINT UNSIGNED NULL,
  tyres_score         TINYINT UNSIGNED NULL,
  service_compliance  TINYINT UNSIGNED NULL,
  last_service_date   DATE             NULL,
  next_service_due    DATE             NULL,
  overdue_items_count TINYINT UNSIGNED NOT NULL DEFAULT 0,
  calculated_at       DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (vehicle_id) REFERENCES vehicles(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE maintenance_schedule (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  vehicle_id     BIGINT UNSIGNED NOT NULL,
  item_name      VARCHAR(100)    NOT NULL,
  last_done_date DATE            NULL,
  last_done_km   INT UNSIGNED    NULL,
  next_due_date  DATE            NULL,
  next_due_km    INT UNSIGNED    NULL,
  status         ENUM('ok','due_soon','overdue') NOT NULL DEFAULT 'ok',
  urgency        ENUM('low','medium','high')     NOT NULL DEFAULT 'low',
  estimated_cost DECIMAL(8,2)    NULL,
  updated_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  UNIQUE KEY uq_vehicle_item (vehicle_id, item_name),
  FOREIGN KEY (vehicle_id) REFERENCES vehicles(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
