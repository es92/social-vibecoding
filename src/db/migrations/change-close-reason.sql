-- Why a change was closed (#6100): the proposal machine's close reason
-- ('auto-rejected', 'stale-pr', ...), written with the close and cleared
-- when the change leaves 'archived' (reopen, unarchive).
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS close_reason TEXT;
