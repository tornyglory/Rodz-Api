-- Story interactions — comments (flat threading) + one-per-viewer emoji
-- reactions. Only authenticated Rodz customers can comment or react
-- (v1 decision — see docs/vehicle-stories-plan.md § Design decisions).

CREATE TABLE story_comments (
  id                BIGINT UNSIGNED   NOT NULL AUTO_INCREMENT PRIMARY KEY,
  story_id          BIGINT UNSIGNED   NOT NULL,
  customer_id       BIGINT UNSIGNED   NOT NULL,        -- author
  body              TEXT              NOT NULL,        -- max 1000 chars enforced at handler
  created_at        DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at        DATETIME          NULL,

  KEY idx_story    (story_id, deleted_at, created_at DESC),
  KEY idx_customer (customer_id, deleted_at),
  CONSTRAINT fk_story_comment_story    FOREIGN KEY (story_id)    REFERENCES stories(id)   ON DELETE CASCADE,
  CONSTRAINT fk_story_comment_customer FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Reactions — one per customer per story. Upsert via
-- INSERT ... ON DUPLICATE KEY UPDATE to switch kind idempotently.
-- No deleted_at — DELETE removes the row.
CREATE TABLE story_reactions (
  id                BIGINT UNSIGNED   NOT NULL AUTO_INCREMENT PRIMARY KEY,
  story_id          BIGINT UNSIGNED   NOT NULL,
  customer_id       BIGINT UNSIGNED   NOT NULL,
  kind              ENUM('like','love','fire','wow','thinking') NOT NULL,
  created_at        DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  UNIQUE KEY uk_story_customer (story_id, customer_id),
  KEY idx_story (story_id, kind),
  CONSTRAINT fk_story_reaction_story    FOREIGN KEY (story_id)    REFERENCES stories(id)   ON DELETE CASCADE,
  CONSTRAINT fk_story_reaction_customer FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
