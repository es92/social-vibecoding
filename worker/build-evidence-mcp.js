#!/usr/bin/env node
'use strict';

// Build-turn bridge for declaring WHAT the implementing agent changed in the
// UI, so the preview agent can take before/after shots of it. It cannot take
// or publish shots and has no broader platform surface; the server validates
// the same v1 contract used by submission APIs.

const { McpServer } = require('/usr/local/lib/node_modules/@modelcontextprotocol/sdk/dist/cjs/server/mcp.js');
const { StdioServerTransport } = require('/usr/local/lib/node_modules/@modelcontextprotocol/sdk/dist/cjs/server/stdio.js');
const { z } = require('/usr/local/lib/node_modules/zod');

const platform = String(process.env.PLATFORM_URL || '').replace(/\/$/, '');
const sessionId = Number(process.env.SESSION_ID);
const token = String(process.env.WORKER_JWT || '');
if (!/^https?:\/\//.test(platform) || !Number.isInteger(sessionId) || sessionId <= 0 || !token) {
  process.stderr.write('Visual-intent MCP configuration is incomplete.\n');
  process.exit(1);
}

const viewport = z.object({
  name: z.string().min(1).max(32),
  width: z.number().int().min(320).max(1920),
  height: z.number().int().min(480).max(1440),
}).strict();
const story = z.object({
  id: z.string().min(1).max(96),
  claim: z.string().min(1).max(1000)
    .describe('The change in plain words, as a person reading the proposal would say it.'),
  persona: z.enum(['member', 'read_only_admin', 'full_admin'])
    .describe('Who is signed in. Use full_admin only for Homeroom controls that are hidden from read-only administrators; that identity exists only inside the disposable before/after builds.'),
  viewports: z.array(viewport).min(1).max(2),
  intent: z.object({
    startPath: z.string().min(1).max(512)
      .describe('Use a concrete relative route from an observed screen or declared check, including query and hash. Use / only when the change is visible on the home screen.'),
    steps: z.array(z.string().min(1).max(200)).min(1).max(40)
      .describe('What a person clicks or types from startPath to see the change, one short line each.'),
    checkpoint: z.string().min(1).max(500)
      .describe('What is on screen when the change is showing.'),
    focus: z.string().min(1).max(200)
      .describe('The part of the screen that changed.'),
    baseState: z.enum(['present', 'not_present']).optional()
      .describe('Use not_present only for a genuinely new screen or control; the before shot then shows where it will appear.'),
    animation: z.enum(['none', 'steps', 'motion'])
      .describe('motion when the change is movement a still cannot show (a transition, an animation); the preview agent then also records a short before and after clip.'),
    controlledFailurePath: z.string().min(6).max(512).optional()
      .describe('Only for an error state: exact same-origin /api/ GET path to block on both revisions. Set the FIRST intent.steps entry exactly to "Controlled test: deliberately block the declared API GET on both revisions." so people see the condition.'),
    hints: z.object({
      setup: z.string().min(1).max(500).optional()
        .describe('Data or state the screen needs and how to create it through the UI as this persona, e.g. "Create a request from the + button first".'),
      expectText: z.array(z.string().min(1).max(120)).min(1).max(5).optional()
        .describe('Short visible text that shows the after build reached the change.'),
      focusTarget: z.object({
        by: z.enum(['testId', 'role', 'label', 'placeholder', 'text', 'css']),
        value: z.string().min(1).max(256).optional(),
        role: z.string().min(1).max(64).optional(),
        name: z.string().min(1).max(256).optional(),
        exact: z.boolean().optional(),
      }).strict().optional()
        .describe('The element you would point a person at, as you located it while building.'),
    }).strict().optional()
      .describe('Optional shot-list hints from what you observed while building, so the preview agent can go straight to this state.'),
  }).strict(),
}).strict();
const intentSchema = {
  version: z.literal(1),
  impact: z.enum(['ui', 'motion', 'none']),
  rationale: z.string().min(1).max(1000),
  stories: z.array(story).max(3),
};

async function record(intent) {
  const response = await fetch(`${platform}/api/internal/sessions/${sessionId}/visual-evidence-intent`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ intent }),
    signal: AbortSignal.timeout(30_000),
  });
  let payload;
  try { payload = await response.json(); }
  catch { payload = { ok: false, code: 'invalid_platform_response', message: 'Homeroom returned a non-JSON response.' }; }
  if (!response.ok || payload?.ok !== true) {
    const error = new Error(String(payload?.message || `Homeroom returned HTTP ${response.status}`).slice(0, 1000));
    error.code = String(payload?.code || 'visual_intent_failed');
    throw error;
  }
  return payload;
}

const server = new McpServer(
  { name: 'usernode-visual-intent', version: '1.0.0' },
  { instructions: 'After implementing a change, declare what a person will see change, only for a visible state you reached in the running local app with representative test data. Report missing data or an unreachable state instead of guessing. This only records the declared changes; Homeroom\'s preview agent later follows them on the before and after builds and takes the shots.' }
);
server.registerTool('record_visual_evidence_intent', {
  description: 'Declare 1-3 visible changes and how a person reaches each one, as you reached them in the running local app with representative test data, or impact=none with a specific rationale for a truly non-visual change. Add hints (setup, expectText, focusTarget) when they would help someone else find the same state. A state that needs a server fault or background job needs a repeatable staging fixture; report that rather than guessing the steps. Call once after implementation and before finishing the build turn.',
  inputSchema: intentSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async (intent) => {
  try {
    const result = await record(intent);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  } catch (error) {
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify({
        ok: false,
        code: String(error?.code || 'visual_intent_failed'),
        message: String(error?.message || 'Could not record visual intent.').slice(0, 1000),
      }) }],
    };
  }
});

server.connect(new StdioServerTransport()).catch((error) => {
  process.stderr.write(`${String(error?.message || error).slice(0, 1000)}\n`);
  process.exit(1);
});
