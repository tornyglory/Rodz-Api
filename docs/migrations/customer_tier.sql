-- Replace the boolean is_premium with a three-value tier column
-- (free / silver / gold). is_premium is retained as a derived flag for
-- backwards compatibility during the transition.
--
-- Silver features gate on tier != 'free' (== isPremium).
-- Gold features gate on tier === 'gold'.

ALTER TABLE customers
  ADD COLUMN tier ENUM('free','silver','gold') NOT NULL DEFAULT 'free' AFTER is_premium;

UPDATE customers SET tier = 'silver' WHERE is_premium = 1;
