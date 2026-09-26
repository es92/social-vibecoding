'use strict';

// Evidence uses non-interactive fixture identities: a normal member, a
// read-only administrator, and a full administrator that exists only in the
// paired disposable databases. Their passwords cannot be used to sign in;
// short-lived app-scoped iframe JWTs are minted only for a controlled run.

const visuals = require('./visuals');
const fixtures = require('./visual-evidence-fixtures');

async function mintEvidenceAuthTokens(pool, appId) {
  const { rows } = await pool.query(
    `SELECT id, username, usernode_pubkey, locale, is_admin, admin_readonly
       FROM users
      WHERE username = ANY($1::text[])`,
    [[visuals.CAPTURE_USERNAME, visuals.CAPTURE_ADMIN_USERNAME]]
  );
  const byName = new Map(rows.map((row) => [row.username, row]));
  const member = byName.get(visuals.CAPTURE_USERNAME);
  const admin = byName.get(visuals.CAPTURE_ADMIN_USERNAME);
  if (!member) throw new Error('The visual-evidence member fixture identity is unavailable.');
  if (!admin || admin.is_admin !== true || admin.admin_readonly !== true) {
    throw new Error('The visual-evidence read-only administrator fixture identity is unavailable or unsafe.');
  }
  return {
    member: visuals.mintCaptureToken(member, appId),
    read_only_admin: visuals.mintCaptureToken(admin, appId),
    // Production has no full-admin service-account row. This token can only
    // become a session inside an evidence clone, where resetPair inserts the
    // matching non-loginable identity. Production ignores iframe tokens and
    // ordinary staging clones do not contain the reserved user id.
    full_admin: visuals.mintCaptureToken({
      id: fixtures.FULL_ADMIN_USER_ID,
      username: fixtures.FULL_ADMIN_USERNAME,
      usernode_pubkey: null,
      locale: 'en',
    }, appId),
  };
}

module.exports = { mintEvidenceAuthTokens };
