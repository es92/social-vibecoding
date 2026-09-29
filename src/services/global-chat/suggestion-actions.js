'use strict';

// Fixed suggestion and inline-result buttons resolve here, on the server, to
// exact read-only capabilities. The browser supplies only an allowlisted
// action id plus bounded object identifiers; it never supplies a route,
// method, capability id, renderer, or Classic path.

const inventory = require('./classic-inventory.generated.json');
const {
  directActionIdForSuggestion,
  suggestionLabelForId,
} = require('./presentation');

const ACTION_ID_RE = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$/;
const APP_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const NUMERIC_ID_RE = /^[1-9]\d{0,18}$/;
const USERNAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;
const SETTING_KEYS = new Set(inventory.settings.map((item) => item.key));
const COMPACT_APP_QUERY = Object.freeze([{ name: 'view', value: 'global-chat' }]);

class SuggestionActionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SuggestionActionError';
    this.code = code;
  }
}

function routeCapability(method, path) {
  const route = inventory.routes.find((item) => (
    item.status === 'mapped' && item.method === method && item.path === path
  ));
  if (!route) throw new Error(`Global Chat direct action route is missing: ${method} ${path}`);
  return route.capabilityId;
}

function routeStep(method, path, pathParameters = {}, query = []) {
  return {
    capabilityId: routeCapability(method, path),
    input: { pathParameters, query, bodyJson: null },
  };
}

function manualStep(capabilityId, input = {}) {
  return { capabilityId, input };
}

function noParameters(value) {
  if (value == null) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length) {
    throw new SuggestionActionError('invalid_direct_action', 'This action does not accept parameters.');
  }
  return {};
}

function exactParameters(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SuggestionActionError('invalid_direct_action', 'Action parameters are required.');
  }
  const keys = Object.keys(value);
  const expected = Object.keys(fields);
  if (keys.length !== expected.length || keys.some((key) => !Object.hasOwn(fields, key))) {
    throw new SuggestionActionError('invalid_direct_action', 'Action parameters are invalid.');
  }
  const out = {};
  for (const [key, pattern] of Object.entries(fields)) {
    const text = String(value[key] ?? '');
    if (!pattern.test(text)) {
      throw new SuggestionActionError('invalid_direct_action', `Action parameter ${key} is invalid.`);
    }
    out[key] = text;
  }
  return out;
}

function settingParameters(value) {
  const result = exactParameters(value, { group: /^[a-z][a-z0-9-]{0,63}$/ });
  if (!SETTING_KEYS.has(result.group)) {
    throw new SuggestionActionError('invalid_direct_action', 'That settings group is unavailable.');
  }
  return result;
}

function localSettingParameters(value) {
  const result = exactParameters(value, {
    setting: /^(?:theme|devAlerts|devConsoleMode|adminPreview)$/,
    value: /^(?:system|light|dark|true|false|always|errors-only)$/,
  });
  const allowed = {
    theme: new Set(['system', 'light', 'dark']),
    devAlerts: new Set(['true', 'false']),
    devConsoleMode: new Set(['always', 'errors-only']),
    adminPreview: new Set(['true', 'false']),
  };
  if (!allowed[result.setting]?.has(result.value)) {
    throw new SuggestionActionError('invalid_direct_action', 'That setting value is unavailable.');
  }
  return {
    setting: result.setting,
    value: ['devAlerts', 'adminPreview'].includes(result.setting)
      ? result.value === 'true'
      : result.value,
  };
}

function fixed({ label, message, domain, steps, itemSelection = null }) {
  return Object.freeze({
    label,
    message,
    domain,
    parameters: noParameters,
    steps: () => steps,
    ...(itemSelection ? { itemSelection: Object.freeze(itemSelection) } : {}),
  });
}

function displayTarget(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value !== 'string' || !value.trim() || value.length > 160
      || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new SuggestionActionError('invalid_direct_action', 'The action target is invalid.');
  }
  return value.trim();
}

function fallbackTarget(actionId, parameters) {
  if (parameters.appSlug && parameters.issueNumber) {
    return `issue #${parameters.issueNumber} in ${parameters.appSlug}`;
  }
  if (parameters.appSlug) return parameters.appSlug;
  if (parameters.sessionId) return `development #${parameters.sessionId}`;
  if (parameters.proposalId) return `proposal #${parameters.proposalId}`;
  if (parameters.governanceId) return `governance item #${parameters.governanceId}`;
  if (parameters.conversationId) return `conversation #${parameters.conversationId}`;
  if (parameters.notificationId) return `notification #${parameters.notificationId}`;
  if (parameters.username) return parameters.username;
  if (parameters.userId) return `profile #${parameters.userId}`;
  if (parameters.group) return `${parameters.group.replace(/-/g, ' ')} settings`;
  return actionId;
}

function contextualCopy(actionId, definition, parameters, requestedTarget) {
  const target = displayTarget(requestedTarget, fallbackTarget(actionId, parameters));
  const copies = {
    'apps.detail': [`About ${target}`, `Here are the details for ${target}.`],
    'issues.for_app': [`Issues for ${target}`, `Here are the issues for ${target}.`],
    'development.for_app': [`Development in ${target}`, `Here is the development work for ${target}.`],
    'governance.for_app': [`Proposals for ${target}`, `Here are the proposals for ${target}.`],
    'messages.for_app': [`Discussions in ${target}`, `Here are the discussions for ${target}.`],
    'issue.detail': [`Open ${target}`, `Here are the details for ${target}.`],
    'issue.comments': [`Comments on ${target}`, `Here are the comments on ${target}.`],
    'governance.detail': [`Open ${target}`, `Here are the details for ${target}.`],
    'proposal.detail': [`Open ${target}`, `Here are the details for ${target}.`],
    'proposal.evidence': [`Before/after shots for ${target}`, `Here are the before/after shots for ${target}.`],
    'session.detail': [`Details for ${target}`, `Here are the details for ${target}.`],
    'session.checks': [`Checks for ${target}`, `Here are the checks for ${target}.`],
    'conversation.detail': [`Open ${target}`, `Here are the details for ${target}.`],
    'notification.detail': [`Open ${target}`, `Here are the details for ${target}.`],
    'leaderboard.profile': [`Profile for ${target}`, `Here is the profile for ${target}.`],
    'leaderboard.prs': [`Merged work by ${target}`, `Here is the merged work by ${target}.`],
    'settings.inspect': [`Open ${target}`, `Here are the current values for ${target}.`],
  };
  const [label, message] = copies[actionId] || [definition.label, definition.message];
  return { label, message, targetLabel: target };
}

function shortLabel(prefix, target) {
  const available = Math.max(8, 36 - prefix.length - 1);
  let compact = target;
  if (target.length > available) {
    const identifier = target.match(/#\d{1,18}/)?.[0] || '';
    const identifierSuffix = identifier && identifier.length + 4 <= available ? ` ${identifier}` : '';
    const headLength = Math.max(2, available - identifierSuffix.length - 1);
    compact = `${target.slice(0, headLength).trimEnd()}…${identifierSuffix}`;
  }
  return `${prefix} ${compact}`;
}

function contextualId(action, suffix) {
  const key = Object.values(action.parameters || {}).join('.')
    .replace(/[^A-Za-z0-9._:-]+/g, '-')
    .slice(0, 64) || 'current';
  return `context.${action.id}.${suffix}.${key}`.slice(0, 160);
}

function trustedSuggestion(action, suffix, value) {
  return {
    id: contextualId(action, suffix),
    label: value.label,
    prompt: value.prompt,
    capabilityHint: null,
    ...(value.actionId ? { actionId: value.actionId } : {}),
    // Contextual suggestions are not part of the fixed presentation catalog.
    // Keep an explicit (possibly empty) parameter object so the client sends
    // their allowlisted action id instead of trying to resolve their dynamic
    // suggestion id as a fixed catalog entry.
    ...(value.actionId ? { parameters: value.parameters || {} } : {}),
    ...(value.targetLabel ? { targetLabel: value.targetLabel } : {}),
  };
}

function contextualBranches(parent, topic) {
  const exactTopic = String(topic || '').slice(0, 240);
  const templates = {
    'apps.detail': [
      ['Recent changes', `Show recent changes and activity for ${exactTopic}.`],
      ['App members', `Show the people currently active in ${exactTopic}.`],
      ['Open work', `Show all open issues, proposals, and development work for ${exactTopic}.`],
      ['App discussions', `Show recent discussions for ${exactTopic}.`],
      ['App settings', `Show settings and permissions available for ${exactTopic}.`],
    ],
    'issues.for_app': [
      ['Newest issues', `Show the newest open issues for ${exactTopic}.`],
      ['Search issues', `Ask me for text or tags, then search issues in ${exactTopic}.`],
      ['My issue work', `Show issues connected to my work in ${exactTopic}.`],
      ['Recently closed', `Show recently closed issues in ${exactTopic}.`],
      ['Start issue work', `Help me choose an issue and start development in ${exactTopic}.`],
    ],
    'development.for_app': [
      ['Active work', `Show active development sessions for ${exactTopic}.`],
      ['Needs attention', `Show development work that needs my attention in ${exactTopic}.`],
      ['Check failures', `Show development work with failing checks in ${exactTopic}.`],
      ['Recently merged', `Show recently merged development work in ${exactTopic}.`],
      ['Start new work', `Help me start new development work in ${exactTopic}.`],
    ],
    'governance.for_app': [
      ['Needs my vote', `Show proposals awaiting my vote in ${exactTopic}.`],
      ['Newest proposals', `Show the newest proposals in ${exactTopic}.`],
      ['Recently merged', `Show recently merged proposals in ${exactTopic}.`],
      ['Proposal issues', `Show issues linked to current proposals in ${exactTopic}.`],
      ['Proposal status', `Summarize the current proposal states in ${exactTopic}.`],
    ],
    'messages.for_app': [
      ['Unread discussion', `Show unread discussion messages in ${exactTopic}.`],
      ['Recent discussion', `Show the newest discussion messages in ${exactTopic}.`],
      ['My mentions', `Show discussion messages that mention me in ${exactTopic}.`],
      ['Discussion people', `Show who recently participated in discussions for ${exactTopic}.`],
      ['Related work', `Show issues or proposals discussed recently in ${exactTopic}.`],
    ],
    'settings.inspect': [
      ['Current values', `Show the current readable values for ${exactTopic}.`],
      ['Change a value', `Ask which value I want to change in ${exactTopic}, preserve every other value, and show confirmation before saving.`],
      ['Available controls', `Show which values can be changed in ${exactTopic}.`],
      ['Related settings', `Show settings groups directly related to ${exactTopic}.`],
      ['Reset options', `Show safe reset or default options available for ${exactTopic}; do not change anything yet.`],
    ],
  };
  const branch = templates[parent.actionId];
  if (!branch) return [];
  return branch.map(([label, prompt], index) => ({
    id: `${parent.id}.branch.${index + 1}`.slice(0, 160),
    label,
    prompt,
    capabilityHint: null,
  }));
}

function contextualSuggestionSet(action) {
  const target = action.targetLabel;
  const parameters = action.parameters || {};
  let topic = null;
  let candidates = [];

  if (parameters.appSlug && [
    'apps.detail', 'issues.for_app', 'development.for_app',
    'governance.for_app', 'messages.for_app',
  ].includes(action.id)) {
    const app = target || parameters.appSlug;
    topic = `${app} app (${parameters.appSlug})`;
    const exact = { appSlug: parameters.appSlug };
    candidates = [
      trustedSuggestion(action, 'about', {
        label: shortLabel('About', app),
        prompt: `Show details for the ${app} app (slug ${parameters.appSlug}).`,
        actionId: 'apps.detail', parameters: exact, targetLabel: app,
      }),
      trustedSuggestion(action, 'issues', {
        label: shortLabel('Issues in', app),
        prompt: `Show open issues for the ${app} app (slug ${parameters.appSlug}).`,
        actionId: 'issues.for_app', parameters: exact, targetLabel: app,
      }),
      trustedSuggestion(action, 'development', {
        label: shortLabel('Work in', app),
        prompt: `Show development work for the ${app} app (slug ${parameters.appSlug}).`,
        actionId: 'development.for_app', parameters: exact, targetLabel: app,
      }),
      trustedSuggestion(action, 'proposals', {
        label: shortLabel('Proposals in', app),
        prompt: `Show proposals for the ${app} app (slug ${parameters.appSlug}).`,
        actionId: 'governance.for_app', parameters: exact, targetLabel: app,
      }),
      trustedSuggestion(action, 'discussions', {
        label: shortLabel('Discuss', app),
        prompt: `Show recent discussions for the ${app} app (slug ${parameters.appSlug}).`,
        actionId: 'messages.for_app', parameters: exact, targetLabel: app,
      }),
      trustedSuggestion(action, 'search', {
        label: shortLabel('Search', app),
        prompt: `Help me search within the ${app} app (slug ${parameters.appSlug}). Ask what I want to find if needed.`,
      }),
    ];
  } else if (parameters.sessionId && ['session.detail', 'session.checks'].includes(action.id)) {
    const session = target || `development #${parameters.sessionId}`;
    topic = `${session} (development session ${parameters.sessionId})`;
    const exact = { sessionId: parameters.sessionId };
    candidates = [
      trustedSuggestion(action, 'details', {
        label: shortLabel('Details for', session),
        prompt: `Show details for ${session} (session ${parameters.sessionId}).`,
        actionId: 'session.detail', parameters: exact, targetLabel: session,
      }),
      trustedSuggestion(action, 'checks', {
        label: shortLabel('Checks for', session),
        prompt: `Show checks for ${session} (session ${parameters.sessionId}).`,
        actionId: 'session.checks', parameters: exact, targetLabel: session,
      }),
      trustedSuggestion(action, 'continue', {
        label: shortLabel('Continue', session),
        prompt: `Help me continue ${session} using development session ${parameters.sessionId}.`,
      }),
      trustedSuggestion(action, 'issues', {
        label: shortLabel('Issues for', session),
        prompt: `Show issues related to ${session} (development session ${parameters.sessionId}).`,
      }),
      trustedSuggestion(action, 'proposals', {
        label: shortLabel('Proposals for', session),
        prompt: `Show proposals related to ${session} (development session ${parameters.sessionId}).`,
      }),
      trustedSuggestion(action, 'active', {
        label: 'All active work', prompt: 'Show all of my active development work.',
        actionId: 'development.active',
      }),
    ];
  } else if (parameters.appSlug && parameters.issueNumber
      && ['issue.detail', 'issue.comments'].includes(action.id)) {
    const issue = target || `issue #${parameters.issueNumber}`;
    topic = `${issue} in app ${parameters.appSlug}`;
    const exact = { appSlug: parameters.appSlug, issueNumber: parameters.issueNumber };
    candidates = [
      trustedSuggestion(action, 'details', {
        label: shortLabel('Open', issue),
        prompt: `Show details for ${issue} in app ${parameters.appSlug}.`,
        actionId: 'issue.detail', parameters: exact, targetLabel: issue,
      }),
      trustedSuggestion(action, 'comments', {
        label: shortLabel('Comments on', issue),
        prompt: `Show comments on ${issue} in app ${parameters.appSlug}.`,
        actionId: 'issue.comments', parameters: exact, targetLabel: issue,
      }),
      trustedSuggestion(action, 'start', {
        label: shortLabel('Start', issue),
        prompt: `Start development work for ${issue} in app ${parameters.appSlug}.`,
      }),
      trustedSuggestion(action, 'proposals', {
        label: shortLabel('Proposals for', issue),
        prompt: `Show proposals related to ${issue} in app ${parameters.appSlug}.`,
      }),
      trustedSuggestion(action, 'similar', {
        label: shortLabel('Similar to', issue),
        prompt: `Find issues similar to ${issue} in app ${parameters.appSlug}.`,
      }),
      trustedSuggestion(action, 'app', {
        label: 'All app issues',
        prompt: `Show all open issues for app ${parameters.appSlug}.`,
        actionId: 'issues.for_app', parameters: { appSlug: parameters.appSlug },
        targetLabel: parameters.appSlug,
      }),
    ];
  } else if (action.id === 'settings.inspect' && parameters.group) {
    const setting = target || `${parameters.group.replace(/-/g, ' ')} settings`;
    topic = `${setting} (settings group ${parameters.group})`;
    candidates = [
      trustedSuggestion(action, 'change', {
        label: shortLabel('Change', setting),
        prompt: `Help me change ${setting} (settings group ${parameters.group}). Preserve values I do not ask to change and show confirmation before saving.`,
      }),
      trustedSuggestion(action, 'chat', {
        label: 'Chat settings', prompt: 'Show my Global Chat settings.',
        actionId: 'settings.global_chat',
      }),
      trustedSuggestion(action, 'development', {
        label: 'Development AI', prompt: 'Show my Development AI settings.',
        actionId: 'settings.development',
      }),
      trustedSuggestion(action, 'spending', {
        label: 'AI spending', prompt: 'Show my AI usage and spending limits.',
        actionId: 'settings.spending',
      }),
      trustedSuggestion(action, 'notifications', {
        label: 'Notification settings', prompt: 'Show my notification settings.',
        actionId: 'settings.notifications',
      }),
      trustedSuggestion(action, 'other', {
        label: 'Other settings', prompt: 'Show other settings I can configure.',
        actionId: 'settings.catalog',
      }),
    ];
  }

  if (!topic || candidates.length < 5) return null;
  const suggestions = candidates.filter((candidate) => candidate.actionId !== action.id).slice(0, 5);
  if (suggestions.length !== 5) return null;
  return {
    topic: topic.slice(0, 240),
    suggestions: suggestions.map((suggestion) => ({
      ...suggestion,
      relatedSuggestions: contextualBranches(suggestion, topic),
    })),
  };
}

const ACTIONS = Object.freeze({
  'work.overview': fixed({
    label: 'Show my work',
    message: 'Here is your current work.',
    domain: 'development',
    steps: [
      routeStep('GET', '/api/me/active-sessions'),
      manualStep('governance.mine'),
    ],
  }),
  'apps.list': fixed({
    label: 'Explore apps',
    message: 'Here are the apps you can access.',
    domain: 'apps',
    steps: [routeStep('GET', '/api/apps', {}, COMPACT_APP_QUERY)],
  }),
  'apps.activity': fixed({
    label: 'Recent app activity',
    message: 'Here are your apps with their recent activity.',
    domain: 'apps',
    steps: [manualStep('apps.activity')],
  }),
  'issues.choose_app': fixed({
    label: 'Open issues',
    message: 'Choose an app to view its issues.',
    domain: 'issues',
    steps: [routeStep('GET', '/api/apps', {}, COMPACT_APP_QUERY)],
    itemSelection: {
      renderer: 'app',
      actionId: 'issues.for_app',
      parameter: 'appSlug',
      label: 'Issues for',
    },
  }),
  'development.active': fixed({
    label: 'Active development',
    message: 'Here is your active development work.',
    domain: 'development',
    steps: [routeStep('GET', '/api/me/active-sessions')],
  }),
  'development.continue': fixed({
    label: 'Continue work',
    message: 'Choose development work to continue.',
    domain: 'development',
    steps: [routeStep('GET', '/api/me/active-sessions')],
  }),
  'development.status': fixed({
    label: 'Check status',
    message: 'Choose development work to inspect.',
    domain: 'development',
    steps: [routeStep('GET', '/api/me/active-sessions')],
  }),
  'governance.mine': fixed({
    label: 'Review proposals',
    message: 'Here are your current proposals.',
    domain: 'governance',
    steps: [manualStep('governance.mine')],
  }),
  'governance.completed': fixed({
    label: 'Completed work',
    message: 'Here is your recently completed work.',
    domain: 'governance',
    steps: [manualStep('governance.completed', { limit: 10 })],
  }),
  'messages.recent': fixed({
    label: 'Recent conversations',
    message: 'Here are your recent conversations.',
    domain: 'messages',
    steps: [routeStep('GET', '/api/conversations')],
  }),
  'messages.unread': fixed({
    label: 'Unread messages',
    message: 'Here are your conversations with unread messages.',
    domain: 'messages',
    steps: [manualStep('messages.unread')],
  }),
  'messages.overview': fixed({
    label: 'Check messages',
    message: 'Here are your unread conversations and recent notifications.',
    domain: 'messages',
    steps: [
      manualStep('messages.unread'),
      routeStep('GET', '/api/notifications', {}, [{ name: 'limit', value: '20' }]),
    ],
  }),
  'messages.choose_app': fixed({
    label: 'App discussions',
    message: 'Choose an app to view its discussions.',
    domain: 'messages',
    steps: [routeStep('GET', '/api/apps', {}, COMPACT_APP_QUERY)],
    itemSelection: {
      renderer: 'app',
      actionId: 'messages.for_app',
      parameter: 'appSlug',
      label: 'Discussions in',
    },
  }),
  'notifications.list': fixed({
    label: 'Notifications',
    message: 'Here are your recent notifications.',
    domain: 'messages',
    steps: [routeStep('GET', '/api/notifications', {}, [{ name: 'limit', value: '20' }])],
  }),
  'settings.global_chat': fixed({
    label: 'Chat settings',
    message: 'Here are your Global Chat settings.',
    domain: 'settings',
    steps: [manualStep('settings.inspect', { group: 'global-chat' })],
  }),
  'settings.development': fixed({
    label: 'Development AI',
    message: 'Here are your Development AI settings.',
    domain: 'settings',
    steps: [manualStep('settings.inspect', { group: 'openrouter' })],
  }),
  'settings.spending': fixed({
    label: 'AI spending',
    message: 'Here is your Global Chat usage and spending limit.',
    domain: 'settings',
    steps: [manualStep('settings.spending')],
  }),
  'settings.notifications': fixed({
    label: 'Notification settings',
    message: 'Here are your notification settings.',
    domain: 'settings',
    steps: [manualStep('settings.inspect', { group: 'alerts' })],
  }),
  'settings.catalog': fixed({
    label: 'Open settings',
    message: 'Choose a settings group.',
    domain: 'settings',
    steps: [manualStep('settings.catalog')],
  }),
  'settings.inspect': Object.freeze({
    label: 'View setting', message: 'Here are the current settings for this group.', domain: 'settings',
    parameters: settingParameters,
    steps: ({ group }) => [manualStep('settings.inspect', { group })],
  }),
  'settings.local.update': Object.freeze({
    label: 'Save setting', message: 'The setting is ready to apply.', domain: 'settings',
    parameters: localSettingParameters,
    steps: (input) => [manualStep('settings.local.update', input)],
  }),
  'profile.me': fixed({
    label: 'View my profile',
    message: 'Here is your profile.',
    domain: 'general',
    steps: [routeStep('GET', '/api/me/public-profile')],
  }),
  'leaderboard.users': fixed({
    label: 'View leaderboard',
    message: 'Here is the leaderboard.',
    domain: 'general',
    steps: [routeStep('GET', '/api/leaderboard/users')],
  }),

  // Inline result actions. These carry exact ids from an authoritative result
  // and remain read-only; writes continue through the model + confirmation
  // path until a dedicated fixed action defines every required input.
  'apps.detail': Object.freeze({
    label: 'App details', message: 'Here are the app details.', domain: 'apps',
    parameters: (value) => exactParameters(value, { appSlug: APP_SLUG_RE }),
    steps: ({ appSlug }) => [routeStep('GET', '/api/apps/:slug', { slug: appSlug })],
  }),
  'issues.for_app': Object.freeze({
    label: 'App issues', message: 'Here are the issues for this app.', domain: 'issues',
    parameters: (value) => exactParameters(value, { appSlug: APP_SLUG_RE }),
    steps: ({ appSlug }) => [
      routeStep('GET', '/api/apps/:slug/issues', { slug: appSlug }),
      routeStep('GET', '/api/apps/:slug/github-issues', { slug: appSlug }),
    ],
  }),
  'development.for_app': Object.freeze({
    label: 'App development', message: 'Here is the development work for this app.', domain: 'development',
    parameters: (value) => exactParameters(value, { appSlug: APP_SLUG_RE }),
    steps: ({ appSlug }) => [routeStep('GET', '/api/apps/:slug/sessions', { slug: appSlug })],
  }),
  'governance.for_app': Object.freeze({
    label: 'App proposals', message: 'Here are the proposals for this app.', domain: 'governance',
    parameters: (value) => exactParameters(value, { appSlug: APP_SLUG_RE }),
    steps: ({ appSlug }) => [routeStep('GET', '/api/apps/:slug/promoted', { slug: appSlug })],
  }),
  'messages.for_app': Object.freeze({
    label: 'App discussions', message: 'Here are the discussions for this app.', domain: 'messages',
    parameters: (value) => exactParameters(value, { appSlug: APP_SLUG_RE }),
    steps: ({ appSlug }) => [manualStep('messages.for_app', { appSlug })],
  }),
  'issue.detail': Object.freeze({
    label: 'Issue details', message: 'Here are the issue details.', domain: 'issues',
    parameters: (value) => exactParameters(value, {
      appSlug: APP_SLUG_RE, issueNumber: NUMERIC_ID_RE,
    }),
    steps: ({ appSlug, issueNumber }) => [routeStep(
      'GET', '/api/apps/:slug/github-issues/:number',
      { slug: appSlug, number: issueNumber },
    )],
  }),
  'issue.comments': Object.freeze({
    label: 'Issue comments', message: 'Here are the issue comments.', domain: 'issues',
    parameters: (value) => exactParameters(value, {
      appSlug: APP_SLUG_RE, issueNumber: NUMERIC_ID_RE,
    }),
    steps: ({ appSlug, issueNumber }) => [routeStep(
      'GET', '/api/apps/:slug/github-issues/:number/comments',
      { slug: appSlug, number: issueNumber },
    )],
  }),
  'governance.detail': Object.freeze({
    label: 'Governance details', message: 'Here are the governance item details.', domain: 'governance',
    parameters: (value) => exactParameters(value, {
      appSlug: APP_SLUG_RE, governanceId: NUMERIC_ID_RE,
    }),
    steps: ({ appSlug, governanceId }) => [routeStep(
      'GET', '/api/apps/:slug/governance/:id',
      { slug: appSlug, id: governanceId },
    )],
  }),
  'proposal.detail': Object.freeze({
    label: 'Proposal details', message: 'Here are the proposal details.', domain: 'governance',
    parameters: (value) => exactParameters(value, {
      appSlug: APP_SLUG_RE, proposalId: NUMERIC_ID_RE,
    }),
    steps: ({ appSlug, proposalId }) => [routeStep(
      'GET', '/api/apps/:slug/proposals/:id',
      { slug: appSlug, id: proposalId },
    )],
  }),
  'proposal.evidence': Object.freeze({
    label: 'Proposal before/after shots', message: 'Here are the proposal before/after shots.', domain: 'governance',
    parameters: (value) => exactParameters(value, {
      appSlug: APP_SLUG_RE, proposalId: NUMERIC_ID_RE,
    }),
    steps: ({ appSlug, proposalId }) => [routeStep(
      'GET', '/api/apps/:slug/proposals/:sessionId/evidence',
      { slug: appSlug, sessionId: proposalId },
    )],
  }),
  'session.detail': Object.freeze({
    label: 'Development details', message: 'Here are the development details.', domain: 'development',
    parameters: (value) => exactParameters(value, { sessionId: NUMERIC_ID_RE }),
    steps: ({ sessionId }) => [routeStep('GET', '/api/sessions/:id/details', { id: sessionId })],
  }),
  'session.checks': Object.freeze({
    label: 'Development checks', message: 'Here are the development checks.', domain: 'development',
    parameters: (value) => exactParameters(value, { sessionId: NUMERIC_ID_RE }),
    steps: ({ sessionId }) => [routeStep('GET', '/api/sessions/:id/checks', { id: sessionId })],
  }),
  'conversation.detail': Object.freeze({
    label: 'Conversation details', message: 'Here are the conversation details.', domain: 'messages',
    parameters: (value) => exactParameters(value, { conversationId: NUMERIC_ID_RE }),
    steps: ({ conversationId }) => [routeStep('GET', '/api/conversations/:id', { id: conversationId })],
  }),
  'notification.detail': Object.freeze({
    label: 'Notification details', message: 'Here are the notification details.', domain: 'messages',
    parameters: (value) => exactParameters(value, { notificationId: NUMERIC_ID_RE }),
    steps: ({ notificationId }) => [routeStep(
      'GET', '/api/notifications/:id', { id: notificationId },
    )],
  }),
  'leaderboard.profile': Object.freeze({
    label: 'Profile', message: 'Here is the leaderboard profile.', domain: 'general',
    parameters: (value) => exactParameters(value, { userId: NUMERIC_ID_RE }),
    steps: ({ userId }) => [routeStep(
      'GET', '/api/v4/users/:userId/profile', { userId },
    )],
  }),
  'leaderboard.prs': Object.freeze({
    label: 'Merged work', message: 'Here is this contributor’s merged work.', domain: 'general',
    parameters: (value) => exactParameters(value, { username: USERNAME_RE }),
    steps: ({ username }) => [routeStep(
      'GET', '/api/leaderboard/users/:username/prs', { username },
    )],
  }),
});

function resolveAction({
  suggestionId = null,
  actionId = null,
  parameters = null,
  targetLabel = null,
} = {}) {
  let resolvedActionId = actionId;
  let suggestionLabel = null;
  if (suggestionId != null) {
    if (typeof suggestionId !== 'string') {
      throw new SuggestionActionError('invalid_direct_action', 'Suggestion id is invalid.');
    }
    resolvedActionId = directActionIdForSuggestion(suggestionId);
    suggestionLabel = suggestionLabelForId(suggestionId);
  }
  if (typeof resolvedActionId !== 'string' || !ACTION_ID_RE.test(resolvedActionId)) {
    throw new SuggestionActionError('direct_action_not_found', 'That option requires Global Chat.');
  }
  const definition = ACTIONS[resolvedActionId];
  if (!definition) {
    throw new SuggestionActionError('direct_action_not_found', 'That direct action is unavailable.');
  }
  const normalized = definition.parameters(parameters);
  const steps = definition.steps(normalized);
  if (!Array.isArray(steps) || !steps.length || steps.length > 5) {
    throw new SuggestionActionError('invalid_direct_action', 'That direct action is invalid.');
  }
  const copy = contextualCopy(resolvedActionId, definition, normalized, targetLabel);
  return {
    id: resolvedActionId,
    label: suggestionLabel || copy.label,
    message: copy.message,
    domain: definition.domain,
    parameters: normalized,
    targetLabel: copy.targetLabel,
    steps,
    ...(definition.itemSelection ? { itemSelection: definition.itemSelection } : {}),
  };
}

module.exports = {
  ACTIONS,
  contextualSuggestionSet,
  SuggestionActionError,
  resolveAction,
  routeCapability,
};
