-- Track whether a customer has completed the first-time onboarding wizard
-- in the customer portal. NULL = pending, DATETIME = completed (or skipped).
-- Backfill existing customers to NOW() so the wizard only fires for genuinely
-- new signups.

ALTER TABLE customers
  ADD COLUMN onboarding_completed_at DATETIME NULL AFTER description;

UPDATE customers SET onboarding_completed_at = NOW() WHERE onboarding_completed_at IS NULL;
