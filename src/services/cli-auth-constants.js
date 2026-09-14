'use strict';

const CLIENT_ID = 'social-vibecoding-cli';
const CLIENT_NAME = 'Homeroom CLI';
const IDENTITY_SCOPE = 'rpc:identity:read';
const API_SCOPE = 'api:access';
// #907: the local coding agent. Deliberately its own scope rather than a
// reuse of api:access — the agent protocol lets a machine claim a session's
// coding turn and stream its result back, which is a materially larger grant
// than "read and write the user-facing JSON API". Credentials issued before
// this scope existed keep working for everything else and get a plain
// 403 insufficient_scope on /api/cli/agent/*, which the CLI turns into a
// re-login prompt.
const AGENT_SCOPE = 'agent:local';
const REQUIRED_SCOPES = Object.freeze([IDENTITY_SCOPE, API_SCOPE, AGENT_SCOPE]);
const REQUIRED_SCOPE_TEXT = REQUIRED_SCOPES.join(' ');
// MCP and local agents use the hosted platform by default. Self-hosted
// deployments can still select their canonical origin with USERNODE_DOMAIN.
// Concretely: the production profile resolves to https://my.onhomeroom.com
// with no environment set, so normal production use of the CLI, the stdio
// MCP server and the local-agent commands needs no USERNODE_DOMAIN. When
// USERNODE_DOMAIN *is* set it still wins, which is how a self-hosted
// deployment points the same three surfaces at its own origin. The local
// profile (LOCAL_ORIGIN, below) is unaffected either way, and credentials
// stay bound to whichever origin they were issued for, so the new default
// needs its own sign-in rather than inheriting the old host's session.
// The default is what it is because the previous host only redirects here,
// and the CLI refuses redirects by design — so leaving it unset used to
// fail rather than follow the hop.
const PRODUCTION_ORIGIN = process.env.USERNODE_DOMAIN
  ? `https://${process.env.USERNODE_DOMAIN}`
  : 'https://my.onhomeroom.com';
const LOCAL_ORIGIN = 'http://localhost:3000';
const DEVICE_TTL_SECONDS = 600;
const ACCESS_TTL_SECONDS = 30 * 24 * 60 * 60;
const POLL_INTERVAL_SECONDS = 5;

module.exports = {
  CLIENT_ID,
  CLIENT_NAME,
  IDENTITY_SCOPE,
  API_SCOPE,
  AGENT_SCOPE,
  REQUIRED_SCOPES,
  REQUIRED_SCOPE_TEXT,
  PRODUCTION_ORIGIN,
  LOCAL_ORIGIN,
  DEVICE_TTL_SECONDS,
  ACCESS_TTL_SECONDS,
  POLL_INTERVAL_SECONDS,
};
