-- Video assets. One table, prefix-partitioned by `context_type` — same
-- shape as s3_event_index handles the expenses/fuel split. Handlers own
-- the polymorphic FK by convention (no db-level FK on context_id, which
-- may point at quotes, chats, vehicles, modifications, or invoices).
--
-- Storage: Cloudflare R2 (S3-compatible). Column named `r2_key` for
-- clarity — if we later migrate to S3, rename the column via a single
-- ALTER TABLE and swap the shared helper.
--
-- See docs/video-platform-plan.md for the full design.

CREATE TABLE video_assets (
  id                       BIGINT UNSIGNED   NOT NULL AUTO_INCREMENT PRIMARY KEY,

  -- Storage
  r2_key                   VARCHAR(500)      NOT NULL,               -- e.g. 'quote-clips/42/uuid.mp4'
  content_type             VARCHAR(80)       NOT NULL,               -- video/mp4, video/webm, video/quicktime
  duration_seconds         DECIMAL(7, 2)     NULL,                   -- client-reported, verified in post-process
  size_bytes               BIGINT UNSIGNED   NULL,
  width                    SMALLINT UNSIGNED NULL,                   -- filled by post-process
  height                   SMALLINT UNSIGNED NULL,
  thumbnail_r2_key         VARCHAR(500)      NULL,
  process_status           ENUM('pending','ready','failed') NOT NULL DEFAULT 'pending',
  process_error            VARCHAR(500)      NULL,

  -- Polymorphic context. context_id is not FK-enforced — handler layer
  -- validates it against the appropriate parent table before insert.
  context_type             ENUM('quote','chat','vehicle','modification','invoice') NOT NULL,
  context_id               BIGINT UNSIGNED   NOT NULL,
  context_item_id          BIGINT UNSIGNED   NULL,                   -- e.g. quote_item_id for quote clips; null for quote-level

  -- Visibility drives whether the playback URL is presigned or public.
  visibility               ENUM('private','shared_link','public') NOT NULL DEFAULT 'private',

  -- Uploader — one of the two is set. Both null is a system-generated
  -- video (none exist today but leave the door open).
  uploaded_by_staff_id     BIGINT UNSIGNED   NULL,
  uploaded_by_customer_id  BIGINT UNSIGNED   NULL,

  created_at    DATETIME  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME  NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at    DATETIME  NULL,

  KEY idx_context          (context_type, context_id, deleted_at),
  KEY idx_context_item     (context_type, context_item_id, deleted_at),
  KEY idx_process          (process_status, created_at),
  KEY idx_uploader_staff   (uploaded_by_staff_id),
  KEY idx_uploader_customer(uploaded_by_customer_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
