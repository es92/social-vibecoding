-- An activation code is also a link now (services/access-links.js): an admin
-- makes one per person in Admin › Activation codes and sends it, and the
-- account signed up from /welcome/<code> is let in at once, with no waitlist
-- and no project attached. Who it is for is the admin's own note, shown only
-- in the admin list, and who made it is recorded beside it.
ALTER TABLE activation_codes
  ADD COLUMN IF NOT EXISTS note TEXT,
  ADD COLUMN IF NOT EXISTS created_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
