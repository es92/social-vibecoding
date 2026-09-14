'use strict';

const fs = require('node:fs');
const path = require('node:path');

const OPENCODE_PROMOTION_GUARD_ATTESTATION = [
  'Homeroom promotion guard health check: PASS.',
  'The trusted project OpenCode plugin executed for this model request;',
  'the OpenCode promotion-readiness check in the usernode-proposal skill is satisfied.',
].join(' ');

module.exports = async function createOpenCodePromotionGuard({ worktree, directory }) {
  const candidate = worktree || directory;
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) {
    throw new Error('Homeroom promotion guard requires an absolute OpenCode worktree');
  }
  const checkoutRoot = fs.realpathSync(candidate);
  const policyPath = path.join(checkoutRoot, '.agents', 'hooks', 'promotion-policy.js');
  const policyStat = fs.lstatSync(policyPath);
  if (!policyStat.isFile() || policyStat.isSymbolicLink()
      || fs.realpathSync(policyPath) !== policyPath) {
    throw new Error('Homeroom promotion policy must be a real file in this checkout');
  }

  // eslint-disable-next-line global-require, import/no-dynamic-require
  const {
    OPENCODE_REVIEWED_TOOLS,
    commandMentionsPromotionRoute,
    isTool,
    promotionSessionId,
  } = require(policyPath);
  let manualPromotionApprovalConfigured = false;

  return {
    config: async (config) => {
      const permission = config && typeof config.permission === 'object'
        ? config.permission
        : null;
      const decision = permission && permission[OPENCODE_REVIEWED_TOOLS.proposal_promote];
      manualPromotionApprovalConfigured = decision === 'ask' || decision === 'deny';
    },

    'experimental.chat.system.transform': async (input, output) => {
      if (!input?.sessionID || !Array.isArray(output?.system)) return;
      if (output.system.some((part) => (
        typeof part === 'string' && part.includes(OPENCODE_PROMOTION_GUARD_ATTESTATION)
      ))) return;
      if (output.system.length === 0) {
        output.system.push(OPENCODE_PROMOTION_GUARD_ATTESTATION);
      } else if (typeof output.system[0] === 'string') {
        output.system[0] = `${output.system[0]}\n\n${OPENCODE_PROMOTION_GUARD_ATTESTATION}`;
      } else {
        throw new Error('OpenCode supplied an invalid system prompt to the Homeroom promotion guard');
      }
    },

    'tool.execute.before': async (input, output) => {
      const toolName = input?.tool;
      const args = output?.args;

      if (toolName === OPENCODE_REVIEWED_TOOLS.proposal_promote
          && !manualPromotionApprovalConfigured) {
        throw new Error(
          'Proposal promotion is blocked because OpenCode manual approval is not configured. Run social-vibecoding opencode setup and restart OpenCode.'
        );
      }

      if (isTool(toolName, 'api_write')) {
        const sessionId = promotionSessionId(args?.path);
        if (sessionId && String(args?.method || '').toUpperCase() === 'POST') {
          throw new Error(
            `Session ${sessionId} promotion requires the dedicated proposal_promote tool and manual OpenCode approval.`
          );
        }
      }

      if (toolName === 'bash' && commandMentionsPromotionRoute(args?.command)) {
        throw new Error(
          'Raw proposal promotion is blocked. Use social_vibecoding.proposal_promote and its manual OpenCode approval.'
        );
      }
    },
  };
};
