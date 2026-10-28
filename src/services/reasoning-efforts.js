'use strict';

// One effort scale for the whole platform: minimal, low, medium, high,
// xhigh. The coding-agent default (config.js) and the OpenRouter transport
// (services/openrouter.js) both validate against this list, so no two
// callers can drift onto different vocabularies. 'none' (thinking off) and
// 'max' are not efforts on this scale; the callers that accept them say so.

const REASONING_EFFORTS = Object.freeze(['minimal', 'low', 'medium', 'high', 'xhigh']);
const REASONING_EFFORT_SET = new Set(REASONING_EFFORTS);

module.exports = { REASONING_EFFORTS, REASONING_EFFORT_SET };
