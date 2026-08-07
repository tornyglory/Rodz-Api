-- Parts sourcing engine — persist eBay (later: Burson, Repco, etc.)
-- search snapshots per booking so the workshop can review the JIT
-- shopping list without hitting the API every time the page loads.
--
-- Two tables:
--   part_sourcing_queries    — one row per (booking, part) shopping-list entry
--   part_sourcing_offerings  — top-N supplier results per query

CREATE TABLE IF NOT EXISTS part_sourcing_queries (
  id                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  booking_id            BIGINT UNSIGNED NULL,
  vehicle_id            BIGINT UNSIGNED NOT NULL,
  service_type_id       BIGINT UNSIGNED NULL,
  part_name_id          INT UNSIGNED    NOT NULL,
  spec_hint             VARCHAR(255)    NULL,
  search_query          VARCHAR(500)    NOT NULL,
  status                ENUM('pending','completed','failed') NOT NULL DEFAULT 'pending',
  error                 VARCHAR(500)    NULL,
  results_count         INT UNSIGNED    NOT NULL DEFAULT 0,
  cheapest_total_aud    DECIMAL(10,2)   NULL,
  fastest_days_max      INT UNSIGNED    NULL,
  queried_at            DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at          DATETIME        NULL,
  KEY idx_booking      (booking_id, queried_at DESC),
  KEY idx_vehicle_part (vehicle_id, part_name_id, queried_at DESC),
  KEY idx_status       (status),
  CONSTRAINT fk_psq_vehicle FOREIGN KEY (vehicle_id)   REFERENCES vehicles(id)   ON DELETE CASCADE,
  CONSTRAINT fk_psq_part    FOREIGN KEY (part_name_id) REFERENCES part_names(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS part_sourcing_offerings (
  id                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  query_id              BIGINT UNSIGNED NOT NULL,
  supplier              ENUM('ebay','burson','repco','other') NOT NULL,
  marketplace           VARCHAR(40)     NULL,
  external_id           VARCHAR(120)    NULL,
  title                 VARCHAR(500)    NOT NULL,
  price_native          DECIMAL(10,2)   NOT NULL,
  currency              VARCHAR(10)     NOT NULL,
  shipping_native       DECIMAL(10,2)   NULL,
  fx_rate               DECIMAL(10,4)   NOT NULL,
  price_aud             DECIMAL(10,2)   NOT NULL,
  shipping_aud          DECIMAL(10,2)   NULL,
  total_aud             DECIMAL(10,2)   NOT NULL,
  delivery_min_days     INT UNSIGNED    NULL,
  delivery_max_days     INT UNSIGNED    NULL,
  item_condition        VARCHAR(60)     NULL,
  seller_name           VARCHAR(120)    NULL,
  seller_feedback_pct   DECIMAL(5,2)    NULL,
  product_url           VARCHAR(800)    NULL,
  image_url             VARCHAR(800)    NULL,
  location              VARCHAR(60)     NULL,
  captured_at           DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_query_total   (query_id, total_aud ASC),
  KEY idx_query_fastest (query_id, delivery_max_days ASC),
  CONSTRAINT fk_pso_query FOREIGN KEY (query_id) REFERENCES part_sourcing_queries(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
