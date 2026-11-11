-- #6585 (11 Nov 2026): the kind the public directory sorts a project under
-- when the project's group never chose one.
--
-- Home's Communities section draws a chip per kind of project it holds, and
-- most projects' dapp.json says nothing (100 of 139 public projects) or still
-- carries the template's starting `other` (37). services/app-category.js works
-- a kind out from the project's name and description with the helper model and
-- keeps the answer here; public-app-directory.js reads it only when
-- dapp.json's `category` is not a chosen kind. A kind a group chose always
-- wins, and this table never changes a project's own files.
--
-- `category` is one of app-manifest.js APP_CATEGORIES, or NULL when the call
-- failed (the sweep tries again after a day). `source_description` is the
-- description the kind was worked out from: the row counts only while the
-- project's current description still equals it, which is how a changed
-- description gets sorted again with no trigger.
CREATE TABLE IF NOT EXISTS app_inferred_categories (
  app_id             INTEGER PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
  category           VARCHAR(16),
  source_description TEXT NOT NULL DEFAULT '',
  model              VARCHAR(128),
  inferred_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE app_inferred_categories IS 'staging:private';
