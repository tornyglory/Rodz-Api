-- Adds `read_at` to notification_events so the customer portal can render
-- a notification centre (bell icon + unread count + list). One column +
-- two indexes:
--   • idx_customer_read  — covers the "unread count" and "unread list" queries
--   • idx_customer_sent  — covers the "recent notifications" list, newest first
--
-- The existing idx_customer_type_sent stays — still used by rate limits.
--
-- Idempotent: safe to re-run.

ALTER TABLE notification_events
  ADD COLUMN read_at DATETIME NULL AFTER sent_at,
  ADD KEY idx_customer_read (customer_id, read_at),
  ADD KEY idx_customer_sent (customer_id, sent_at);
