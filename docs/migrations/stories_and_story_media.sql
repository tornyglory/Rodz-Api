-- Vehicle stories — Facebook-style event posts anchored to a vehicle.
-- Owner-authored, per-story public toggle, draft-first with an explicit
-- publish step. Media attached via story_media referencing either
-- Cloudflare image ids (photos) or video_assets rows (videos).
--
-- See docs/vehicle-stories-plan.md for the full design.

CREATE TABLE stories (
  id                BIGINT UNSIGNED   NOT NULL AUTO_INCREMENT PRIMARY KEY,
  vehicle_id        BIGINT UNSIGNED   NOT NULL,
  customer_id       BIGINT UNSIGNED   NOT NULL,
  title             VARCHAR(200)      NOT NULL,
  description       TEXT              NULL,
  event_date        DATE              NOT NULL,           -- user-picked, "when it happened"
  is_public         TINYINT(1)        NOT NULL DEFAULT 1, -- per-row public gate
  status            ENUM('draft','published') NOT NULL DEFAULT 'draft',
  published_at      DATETIME          NULL,               -- first-publish timestamp; stable across edits
  created_at        DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at        DATETIME          NULL,

  KEY idx_vehicle_event (vehicle_id, deleted_at, event_date DESC),
  KEY idx_customer      (customer_id, deleted_at),
  KEY idx_status_pub    (status, deleted_at, published_at),
  CONSTRAINT fk_stories_vehicle  FOREIGN KEY (vehicle_id)  REFERENCES vehicles(id)  ON DELETE CASCADE,
  CONSTRAINT fk_stories_customer FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- One row per attached media item on a story. Points at EITHER
-- cf_image_id (photo via existing Cloudflare Images pipeline) OR
-- video_asset_id (video via existing R2 + video_assets pipeline).
-- Handler enforces exactly one set — MySQL doesn't have partial
-- constraints and a CHECK on it is verbose.
CREATE TABLE story_media (
  id                BIGINT UNSIGNED   NOT NULL AUTO_INCREMENT PRIMARY KEY,
  story_id          BIGINT UNSIGNED   NOT NULL,
  media_type        ENUM('image','video') NOT NULL,
  cf_image_id       VARCHAR(80)       NULL,
  video_asset_id    BIGINT UNSIGNED   NULL,
  sort_order        SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  created_at        DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at        DATETIME          NULL,

  KEY idx_story (story_id, deleted_at, sort_order),
  KEY idx_video_asset (video_asset_id),
  CONSTRAINT fk_story_media_story FOREIGN KEY (story_id) REFERENCES stories(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
