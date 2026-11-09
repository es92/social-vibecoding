-- #6420: a change's `linked_issues` is a CLAIM that merging it closes those
-- requests, not the merge itself. Each row here records that claim being
-- announced once in the request's own discussion, and the requester's
-- "This doesn't close it" answer (`disputed_at`). `linked_issues` is never
-- touched: the request stays linked, and the merge still closes it.
CREATE TABLE IF NOT EXISTS change_request_claims (
  session_id     INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  app_id         INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  request_number INTEGER NOT NULL CHECK (request_number > 0),
  announced_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  disputed_at    TIMESTAMPTZ,
  disputed_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (session_id, request_number)
);
CREATE INDEX IF NOT EXISTS change_request_claims_app_request
  ON change_request_claims (app_id, request_number);
