-- 11 Nov 2026: a project's card can carry an animated preview, a short
-- silent loop of the real app that plays over its picture
-- (frontend/src/features/guest/card-preview.tsx).
--
-- The loop travels with the card picture: it is part of the same
-- featured-illustration record (`preview: { url, type }`), proposed and voted
-- in by the same governance card (services/illustration-proposals.js), and
-- its bytes wait and land beside the picture's, under the same rule: a
-- proposal's bytes wait in app_illustration_proposals, and the apply copies
-- them into app_illustrations under the SAME id, so the URL the vote card
-- previewed is the URL the cards play (/app-previews/<id>, routes/
-- app-illustrations.js). A loop is at most 1.5 MB (MP4 or WebM).
ALTER TABLE app_illustrations ADD COLUMN IF NOT EXISTS preview_id VARCHAR(32) UNIQUE;
ALTER TABLE app_illustrations ADD COLUMN IF NOT EXISTS preview_content_type TEXT;
ALTER TABLE app_illustrations ADD COLUMN IF NOT EXISTS preview_data BYTEA;

ALTER TABLE app_illustration_proposals ADD COLUMN IF NOT EXISTS preview_id VARCHAR(32) UNIQUE;
ALTER TABLE app_illustration_proposals ADD COLUMN IF NOT EXISTS preview_content_type TEXT;
ALTER TABLE app_illustration_proposals ADD COLUMN IF NOT EXISTS preview_data BYTEA;
