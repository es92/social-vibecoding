'use strict';

// Staging mock data for #907's local coding agent.
//
// `session_agent_leases` and `local_agent_turns` are both `staging:private`
// (schema.sql), so a staging clone copies their shape and none of their rows.
// Without this, every surface the feature adds — the Settings "Local coding
// agent" block, the dev-chat "Run on" selector, the "Running on your machine"
// chip — reviews as an empty state, and there is nothing for a reviewer or a
// dapp.json test to look at.
//
// Same convention as demoCliTokens() in routes/cli-auth.js and the ?demo=1
// branches in the agent-files and LLM-grant routes: request-time injection
// only, never a write; obviously-fake labels; every object carries
// `demo: true` so the client can suppress destructive controls; a strict
// no-op unless USERNODE_ENV is exactly 'staging'.

const MINUTE = 60 * 1000;

function isStagingDemo(req) {
  return process.env.USERNODE_ENV === 'staging' && req?.query?.demo === '1';
}

// Two machines, because one is indistinguishable from a hardcoded string:
// the reviewer needs to see that the block is a list, that labels differ, and
// that a second machine on a different session is a normal state.
function demoLocalAgents() {
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  return [
    {
      leaseId: 'staging-demo-lease-1',
      sessionId: 0,
      label: 'Staging demo laptop',
      runtime: 'claude-code',
      createdAt: iso(now - 42 * MINUTE),
      lastSeenAt: iso(now - 12 * 1000),
      expiresAt: iso(now + 2 * MINUTE),
      heartbeatSeconds: 30,
      appSlug: 'staging-demo-app',
      appName: 'Staging demo app',
      sessionTitle: 'Make the header sticky',
      branch: 'dev/staging-demo-1',
      demo: true,
    },
    {
      leaseId: 'staging-demo-lease-2',
      sessionId: 0,
      label: 'Staging demo desktop',
      runtime: 'claude-code',
      createdAt: iso(now - 6 * 60 * MINUTE),
      lastSeenAt: iso(now - 25 * 1000),
      expiresAt: iso(now + 2 * MINUTE),
      heartbeatSeconds: 30,
      appSlug: 'staging-demo-app',
      appName: 'Staging demo app',
      sessionTitle: 'Port the settings screen to the new tokens',
      branch: 'dev/staging-demo-2',
      demo: true,
    },
  ];
}

// What GET /api/sessions/:id/status?demo=1 reports in staging: the first demo
// machine, attached to whichever session is being viewed. This is what turns
// the dev-chat "Run on" selector into something with a second option and
// lights the "Running on your machine" chip.
//
// Scout turns need nothing extra here. A lease is mode-agnostic — the same
// attached machine takes both spec and coding turns — so what changed for
// scout support is the copy on the chip and in the Settings block, which is
// static markup already visible through this injection. Adding a
// `lastTurnMode` field nothing reads would be decoration, not seed data.
function demoSessionRunner(sessionId) {
  const [laptop] = demoLocalAgents();
  return {
    runner: 'local',
    localAgent: { ...laptop, sessionId: Number(sessionId) || 0 },
  };
}

module.exports = { isStagingDemo, demoLocalAgents, demoSessionRunner };
