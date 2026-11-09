-- #6540 (9 Nov 2026): record where people come from.
--
-- An invite link's landing keeps the site that sent the person (its host
-- only, never the full address) and the short tag the link was copied or
-- shared with, so a link pasted into a chat app that names no referrer still
-- says how it went out. A waitlist sign-up keeps the same host plus the
-- landing URL's utm_source, utm_campaign and ref values. Admin Journey reads
-- both through the links that already follow a person (a row's user_id, and
-- a sign-up's linked_user_id); nothing is added to users.
--
-- NULL means not recorded: rows from before this change, or a client that
-- did not send the field. 'none' means the source was looked for and none was
-- given. Only hosts and short tags are stored; a full URL never reaches here.
ALTER TABLE community_invite_opens
  ADD COLUMN IF NOT EXISTS referrer_host VARCHAR(253),
  ADD COLUMN IF NOT EXISTS via VARCHAR(24);
COMMENT ON COLUMN community_invite_opens.referrer_host IS 'staging:private';
COMMENT ON COLUMN community_invite_opens.via IS 'staging:private';

ALTER TABLE waitlist_signups
  ADD COLUMN IF NOT EXISTS referrer_host VARCHAR(253),
  ADD COLUMN IF NOT EXISTS utm_source VARCHAR(64),
  ADD COLUMN IF NOT EXISTS utm_campaign VARCHAR(64),
  ADD COLUMN IF NOT EXISTS ref VARCHAR(64);
COMMENT ON COLUMN waitlist_signups.referrer_host IS 'staging:private';
COMMENT ON COLUMN waitlist_signups.utm_source IS 'staging:private';
COMMENT ON COLUMN waitlist_signups.utm_campaign IS 'staging:private';
COMMENT ON COLUMN waitlist_signups.ref IS 'staging:private';
