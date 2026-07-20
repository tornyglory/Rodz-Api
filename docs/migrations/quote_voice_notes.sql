-- Voice notes attached to quotes. Mechanic records ~30-sec audio explaining
-- an issue → customer plays back on the approval page. Same trust pattern
-- as the existing photo evidence, audio + transcript instead of images.
--
-- Audio lives in S3 under `rodz-data-lake/quote-voice-notes/{quoteId}/{uuid}.{ext}`.
-- Transcript is filled asynchronously by a Gemini-backed Lambda after upload.
-- Playback is via short-lived presigned GET URLs baked into quote responses.
--
-- Spec: docs/quote-voice-notes-spec.md

CREATE TABLE quote_voice_notes (
  id                    BIGINT UNSIGNED   NOT NULL AUTO_INCREMENT PRIMARY KEY,
  quote_id              BIGINT UNSIGNED   NOT NULL,
  quote_item_id         BIGINT UNSIGNED   NULL,                -- null = attached to whole quote, set = per line item
  s3_key                VARCHAR(500)      NOT NULL,
  content_type          VARCHAR(80)       NOT NULL,            -- 'audio/webm', 'audio/mp4', etc.
  duration_seconds      DECIMAL(6, 2)     NOT NULL,            -- client-reported, capped at 60 server-side
  size_bytes            INT UNSIGNED      NULL,
  transcript            TEXT              NULL,
  transcript_status     ENUM('pending','ready','failed') NOT NULL DEFAULT 'pending',
  recorded_by_staff_id  BIGINT UNSIGNED   NULL,
  created_at            DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at            DATETIME          NULL,
  KEY idx_quote            (quote_id, deleted_at),
  KEY idx_quote_item       (quote_item_id, deleted_at),
  KEY idx_transcript_status (transcript_status, created_at),
  CONSTRAINT fk_qvn_quote      FOREIGN KEY (quote_id)              REFERENCES quotes(id)      ON DELETE CASCADE,
  CONSTRAINT fk_qvn_quote_item FOREIGN KEY (quote_item_id)         REFERENCES quote_items(id) ON DELETE CASCADE,
  CONSTRAINT fk_qvn_staff      FOREIGN KEY (recorded_by_staff_id)  REFERENCES staff(id)       ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
