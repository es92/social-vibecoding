import { useMemo, useState } from 'react';

import { ChevronDownIcon } from '@/components/ui/icons';
import { AppIconContent, appIconKind } from '../apps/app-card-view';
import { GlobalChatSettingsEditor } from '../settings/sections/global-chat';
import { DevelopmentAISettingsEditor } from './development-settings-editor';

import {
  clientAction,
  closeGlobalChat,
  confirmGlobalChatAction,
  dismissConfirmation,
  executeGlobalChatResultAction,
  loadGlobalChatInlineResults,
  runGlobalChatClientAction,
  sendGlobalChatMessage,
  useGlobalChatState,
} from './store';
import type { GlobalChatItemSelection, GlobalChatResult } from './types';

type JsonObject = Record<string, unknown>;

const ARRAY_KEYS = [
  'items', 'issues', 'proposals', 'apps', 'sessions', 'conversations',
  'notifications', 'results', 'rows', 'challenges', 'users', 'messages',
];
const OBJECT_KEYS = ['app', 'issue', 'proposal', 'session', 'conversation', 'profile', 'notification'];
const TITLE_KEYS = [
  'title', 'name', 'label', 'subject', 'displayName', 'appName', 'app_name',
  'sessionTitle', 'session_title', 'prTitle', 'pr_title', 'conversationTitle',
  'conversation_title', 'username',
];
const SUMMARY_KEYS = [
  'summary', 'description', 'body', 'content', 'message', 'statusText',
  'latestSummary', 'latest_summary', 'messageContent', 'message_content',
];
const ID_KEYS = [
  'number', 'issueNumber', 'issue_number', 'github_issue_number', 'sessionId', 'session_id',
  'conversationId', 'conversation_id', 'proposalId', 'proposal_id',
  'challengeId', 'challenge_id', 'id', 'slug', 'username',
];
const PRIVATE_KEY = /(?:secret|password|token|credential|cookie|authorization|signature|private|cipher)/i;

function object(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function text(value: unknown, max = 180): string {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value !== 'string') return '';
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1).trimEnd()}…` : normalized;
}

function unwrapped(result: GlobalChatResult): unknown {
  const authoritative = object(result.authoritativeResult);
  if (!authoritative) return result.authoritativeResult;
  if (authoritative.status === 'confirmation_required') return authoritative;
  return Object.hasOwn(authoritative, 'data') ? authoritative.data : authoritative;
}

function findItems(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const root = object(value);
  if (!root) return [];
  for (const key of ARRAY_KEYS) if (Array.isArray(root[key])) return root[key] as unknown[];
  for (const key of OBJECT_KEYS) if (object(root[key])) return [root[key]];
  for (const nested of Object.values(root)) {
    const child = object(nested);
    if (!child) continue;
    for (const key of ARRAY_KEYS) if (Array.isArray(child[key])) return child[key] as unknown[];
  }
  return [root];
}

function first(item: JsonObject, keys: string[], max?: number) {
  for (const key of keys) {
    const value = text(item[key], max);
    if (value) return value;
  }
  return '';
}

function rendererLabel(renderer: string) {
  const labels: Record<string, string> = {
    app: 'App', issue: 'Issue', proposal: 'Proposal', session: 'Development',
    conversation: 'Conversation', notification: 'Notification', profile: 'Profile',
    leaderboard: 'Leaderboard', challenge: 'Challenge', wallet: 'Wallet',
    staking: 'Staking', setting: 'Setting', admin_record: 'Admin', status: 'Result',
    error: 'Error', form: 'Form', grouped_list: 'Results', confirmation: 'Confirmation',
  };
  return labels[renderer] || 'Result';
}

function humanize(value: string) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[._-]+/g, ' ')
    .replace(/\bpr\b/gi, 'PR')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formattedDate(value: unknown) {
  const raw = text(value, 100);
  if (!raw) return '';
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return raw;
  return parsed.toLocaleString([], {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

function displayValue(key: string, value: unknown) {
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (/activitySecondsLast7Days/.test(key)) {
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) {
      if (seconds < 60) return `${Math.round(seconds)} sec`;
      if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
      return `${(seconds / 3600).toFixed(seconds < 36_000 ? 1 : 0)} hr`;
    }
  }
  if (/(?:^|\.)(?:spent|cap|remaining).*usd$/i.test(key)) {
    const amount = Number(value);
    if (Number.isFinite(amount)) return `$${amount.toFixed(amount > 0 && amount < 0.01 ? 4 : 2)}`;
  }
  if (/(?:At|_at)$/.test(key)) return formattedDate(value);
  return text(value, 80);
}

function itemTitle(result: GlobalChatResult, item: JsonObject) {
  if (result.renderer === 'notification') {
    const kind = text(item.kind, 80);
    const place = first(item, ['appName', 'app_name', 'conversationTitle', 'conversation_title'], 100);
    const label = kind ? humanize(kind) : 'Notification';
    return place ? `${label} · ${place}` : label;
  }
  const rendererKeys: Record<string, string[]> = {
    app: ['name', 'title'],
    issue: ['title', 'name'],
    proposal: ['prTitle', 'pr_title', 'title', 'sessionTitle', 'session_title', 'name'],
    session: ['sessionTitle', 'session_title', 'prTitle', 'pr_title', 'title', 'name'],
    conversation: [
      'title', 'conversationTitle', 'conversation_title', 'name',
      'senderUsername', 'sender_username', 'username',
    ],
    profile: ['displayName', 'username', 'name'],
    leaderboard: ['username', 'displayName', 'name'],
    setting: ['name', 'label'],
  };
  const explicit = first(item, rendererKeys[result.renderer] || TITLE_KEYS, 120);
  if (explicit) return explicit;
  const id = identifier(item)?.value;
  return id ? `${rendererLabel(result.renderer)} ${id}` : rendererLabel(result.renderer);
}

function itemSummary(result: GlobalChatResult, item: JsonObject, title: string) {
  const rendererKeys: Record<string, string[]> = {
    notification: [
      'messageContent', 'message_content', 'voteReason', 'vote_reason', 'detail',
      'prTitle', 'pr_title', 'sessionTitle', 'session_title',
    ],
    conversation: ['latestSummary', 'latest_summary', ...SUMMARY_KEYS],
    session: ['checkErrorDetail', 'check_error_detail', ...SUMMARY_KEYS],
  };
  const summary = first(item, rendererKeys[result.renderer] || SUMMARY_KEYS, 180);
  return summary && summary !== title ? summary : '';
}

function resultLabel(result: GlobalChatResult) {
  if (result.renderer === 'issue') {
    return /(?:^|\.)github\.issues(?:\.|$)/.test(result.capabilityId)
      ? 'GitHub issues'
      : 'Platform issues';
  }
  if (result.capabilityId === 'apps.activity') return 'Recent app activity';
  if (result.capabilityId === 'messages.for_app') return 'App discussions';
  return rendererLabel(result.renderer);
}

function emptyResultMessage(result: GlobalChatResult) {
  const messages: Record<string, string> = {
    app: 'No apps found.',
    issue: 'No issues found.',
    proposal: 'No current proposals.',
    session: 'No active development found.',
    conversation: 'No conversations found.',
    notification: 'No notifications found.',
    leaderboard: 'No leaderboard entries found.',
    setting: 'No settings found.',
  };
  return messages[result.renderer] || 'No results found.';
}

function humanizeCapability(value: string) {
  return value
    .replace(/\.[a-f0-9]{8}$/i, '')
    .split(/[._-]+/)
    .filter((part) => !['get', 'post', 'put', 'patch', 'delete', 'item'].includes(part))
    .slice(1)
    .join(' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase()) || 'this action';
}

function identifier(item: JsonObject) {
  for (const key of ID_KEYS) {
    const value = text(item[key], 80);
    if (value) return { key, value };
  }
  return null;
}

interface DirectItemAction {
  label: string;
  requestLabel: string;
  actionId: string;
  parameters: Record<string, string>;
  mode: 'inline' | 'turn';
}

function itemAction(
  label: string,
  requestLabel: string,
  actionId: string,
  parameters: Record<string, string>,
  mode: 'inline' | 'turn',
): DirectItemAction {
  return { label, requestLabel, actionId, parameters, mode };
}

function resultAppSlug(result: GlobalChatResult, item: JsonObject) {
  const direct = text(item.appSlug || item.app_slug || item.slug, 128);
  if (direct) return direct;
  const encoded = /^#app\/([^/]+)/.exec(result.classicPath || '')?.[1];
  if (!encoded) return '';
  try { return decodeURIComponent(encoded); } catch { return encoded; }
}

function directItemActions(
  result: GlobalChatResult,
  item: JsonObject,
  targetLabel: string,
): DirectItemAction[] {
  const slug = resultAppSlug(result, item);
  const payload = object(item.payload);
  if (result.renderer === 'app' && slug) {
    return [
      itemAction('Details', `About ${targetLabel}`, 'apps.detail', { appSlug: slug }, 'inline'),
      itemAction('Issues', `Issues for ${targetLabel}`, 'issues.for_app', { appSlug: slug }, 'turn'),
      itemAction('Discussions', `Discussions in ${targetLabel}`, 'messages.for_app', { appSlug: slug }, 'turn'),
    ];
  }
  if (result.renderer === 'issue' && slug) {
    const explicitGithubIssueNumber = text(
      item.github_issue_number || payload?.github_issue_number,
      80,
    );
    const issueNumber = text(
      item.number || item.issueNumber || item.issue_number || item.github_issue_number
        || payload?.issueNumber || payload?.issue_number || payload?.github_issue_number,
      80,
    );
    const governanceId = text(item.id, 80);
    const githubIssueCapability = /(?:^|\.)github\.issues(?:\.|$)/.test(result.capabilityId);
    if (issueNumber && (explicitGithubIssueNumber || githubIssueCapability || !text(item.kind, 80))) {
      return [
        itemAction('Details', `Open ${targetLabel}`, 'issue.detail', { appSlug: slug, issueNumber }, 'inline'),
        itemAction('Comments', `Comments on ${targetLabel}`, 'issue.comments', { appSlug: slug, issueNumber }, 'inline'),
      ];
    }
    if (governanceId) {
      return [itemAction(
        'Details', `Open ${targetLabel}`, 'governance.detail',
        { appSlug: slug, governanceId }, 'inline',
      )];
    }
  }
  if (result.renderer === 'proposal' && slug) {
    const governanceId = text(item.governanceId || item.governance_id || item.id, 80);
    if (item.proposalType === 'governance' && governanceId) {
      return [itemAction(
        'Details', `Open ${targetLabel}`, 'governance.detail',
        { appSlug: slug, governanceId }, 'inline',
      )];
    }
    const proposalId = first(item, ['proposalId', 'proposal_id', 'id', 'sessionId', 'session_id'], 80);
    if (proposalId) return [
      itemAction('Details', `Open ${targetLabel}`, 'proposal.detail', { appSlug: slug, proposalId }, 'inline'),
      itemAction('Before/after shots', `Before/after shots for ${targetLabel}`, 'proposal.evidence', { appSlug: slug, proposalId }, 'inline'),
    ];
  }
  if (result.renderer === 'session') {
    const sessionId = first(item, ['sessionId', 'session_id', 'id'], 80);
    if (sessionId) return [
      itemAction('Details', `Details for ${targetLabel}`, 'session.detail', { sessionId }, 'inline'),
      itemAction('Checks', `Checks for ${targetLabel}`, 'session.checks', { sessionId }, 'inline'),
    ];
  }
  if (result.renderer === 'conversation') {
    if (result.capabilityId === 'messages.for_app') return [];
    const conversationId = first(item, ['conversationId', 'conversation_id', 'id'], 80);
    if (conversationId) return [itemAction(
      'Details', `Open ${targetLabel}`, 'conversation.detail', { conversationId }, 'inline',
    )];
  }
  if (result.renderer === 'notification') {
    const notificationId = first(item, ['notificationId', 'notification_id', 'id'], 80);
    if (notificationId) return [itemAction(
      'Details', `Open ${targetLabel}`, 'notification.detail', { notificationId }, 'inline',
    )];
  }
  if (result.renderer === 'leaderboard') {
    const userId = first(item, ['userId', 'user_id', 'id'], 80);
    const username = text(item.username, 80);
    return [
      ...(userId ? [itemAction(
        'Profile', `Profile for ${targetLabel}`, 'leaderboard.profile', { userId }, 'inline',
      )] : []),
      ...(username ? [itemAction(
        'Merged work', `Merged work by ${targetLabel}`, 'leaderboard.prs', { username }, 'inline',
      )] : []),
    ];
  }
  if (result.renderer === 'setting' && result.capabilityId === 'settings.catalog') {
    const group = text(item.id || item.group, 80);
    if (group && text(item.classicPath, 300)) return [itemAction(
      'View', `Open ${targetLabel}`, 'settings.inspect', { group }, 'inline',
    )];
  }
  return [];
}

function itemClassicPath(result: GlobalChatResult, item: JsonObject) {
  const base = result.classicPath;
  if (!base) return null;
  const exactTopic = /\/dev\/(?:issues|proposals|sessions)\/[A-Za-z0-9%-]+$/.test(base)
    || /\/dev\/chat$/.test(base)
    || /^#messages\/[1-9]\d*$/.test(base);
  if (exactTopic) return base;

  const slug = text(item.appSlug || item.app_slug || item.slug, 255)
    || (/^#app\/([^/]+)/.exec(base)?.[1] || '');
  const payload = object(item.payload);
  const segment = (value: string) => {
    try { return encodeURIComponent(decodeURIComponent(value)); }
    catch { return encodeURIComponent(value); }
  };
  if (result.renderer === 'app' && slug) {
    return `#apps/${segment(slug)}`;
  }
  if (result.renderer === 'issue' && slug) {
    const governanceId = text(item.id, 80);
    const governanceKind = text(item.kind, 80);
    const githubIssueCapability = /(?:^|\.)github\.issues(?:\.|$)/.test(result.capabilityId);
    const explicitGithubIssueNumber = text(
      item.github_issue_number || payload?.github_issue_number,
      80,
    );
    const issueNumber = text(
      item.number || item.issueNumber || item.issue_number || item.github_issue_number
        || payload?.issueNumber || payload?.issue_number || payload?.github_issue_number,
      80,
    );
    if (explicitGithubIssueNumber || (issueNumber && githubIssueCapability)) {
      return `#app/${segment(slug)}/dev/issues/${segment(issueNumber)}`;
    }
    if (governanceId && governanceKind && !githubIssueCapability) {
      return `#app/${segment(slug)}/dev/governance/${segment(governanceId)}`;
    }
    if (issueNumber) return `#app/${segment(slug)}/dev/issues/${segment(issueNumber)}`;
    if (governanceId) return `#app/${segment(slug)}/dev/governance/${segment(governanceId)}`;
  }
  if (result.renderer === 'proposal' && slug) {
    const governanceId = text(item.governanceId || item.governance_id || item.id, 80);
    if (item.proposalType === 'governance' && governanceId) {
      return `#app/${segment(slug)}/dev/governance/${segment(governanceId)}`;
    }
    const proposalId = first(item, ['proposalId', 'proposal_id', 'id', 'sessionId', 'session_id'], 80);
    if (proposalId) return `#app/${segment(slug)}/dev/proposals/${segment(proposalId)}`;
  }
  if (result.renderer === 'session' && slug) {
    const sessionId = first(item, ['sessionId', 'session_id', 'id'], 80);
    if (sessionId) return `#app/${segment(slug)}/dev/sessions/${segment(sessionId)}`;
  }
  if (result.renderer === 'conversation' && /^#messages/.test(base)) {
    const conversationId = first(item, ['conversationId', 'conversation_id', 'id'], 80);
    if (conversationId) return `#messages/${segment(conversationId)}`;
  }
  if (result.renderer === 'setting' && /^#settings(?:\/|$)/.test(base)) {
    const group = first(item, ['id', 'group'], 80);
    if (group && /^[a-z][a-z0-9-]{0,63}$/.test(group)) {
      return `#settings/${segment(group)}`;
    }
  }
  if (result.renderer === 'profile') {
    const username = text(item.username, 80);
    if (username) return `#profile/${encodeURIComponent(username)}`;
  }
  return base;
}

function compactMetadata(result: GlobalChatResult, item: JsonObject, title: string) {
  const parts: string[] = [];
  const id = identifier(item);
  if (id && ['issue', 'proposal', 'session'].includes(result.renderer)
      && !title.includes(id.value)) {
    parts.push(`#${id.value}`);
  }
  for (const key of ['status', 'state', 'visibility']) {
    const value = text(item[key], 50);
    if (value && !parts.includes(value)) parts.push(humanize(value));
    if (parts.length === 3) break;
  }
  if (result.renderer === 'notification') {
    parts.push(item.readAt || item.read_at ? 'Read' : 'Unread');
  }
  const date = first(item, ['lastActivityAt', 'last_activity_at', 'updatedAt', 'updated_at', 'createdAt', 'created_at'], 100);
  const renderedDate = formattedDate(date);
  if (renderedDate && parts.length < 3) parts.push(renderedDate);
  return parts.join(' · ');
}

interface DisplayField {
  label: string;
  value: string;
}

function displayFields(result: GlobalChatResult, item: JsonObject): DisplayField[] {
  const fields: DisplayField[] = [];
  const seen = new Set<string>();
  const add = (label: string, keys: string[]) => {
    if (seen.has(label)) return;
    for (const key of keys) {
      if (!Object.hasOwn(item, key) || item[key] == null || item[key] === '') continue;
      const value = displayValue(key, item[key]);
      if (!value) continue;
      fields.push({ label, value });
      seen.add(label);
      return;
    }
  };

  if (result.renderer === 'app') {
    if (result.capabilityId === 'apps.activity') {
      add('Messages (7d)', ['messagesLast7Days']);
      add('Active time (7d)', ['activitySecondsLast7Days']);
      add('Active users', ['activeUsers', 'active_users']);
      add('Development', ['activeDevelopment', 'active_development', 'active_sessions']);
    } else {
      add('Open issues', ['openIssues', 'open_issues']);
      add('Open proposals', ['openProposals', 'open_proposals', 'open_prs']);
      add('Active development', ['activeDevelopment', 'active_development', 'active_sessions']);
    }
  } else if (result.renderer === 'proposal') {
    add('App', ['appName', 'app_name']);
    add('Yes', ['yesCount', 'yes_count', 'upCount', 'up_count']);
    add('No', ['noCount', 'no_count', 'downCount', 'down_count']);
    add('Checks', ['checkState', 'check_state']);
  } else if (result.renderer === 'session') {
    add('App', ['appName', 'app_name']);
    add('Checks', ['checkState', 'check_state']);
    add('Phase', ['checkPhase', 'check_phase']);
  } else if (result.renderer === 'conversation') {
    add('Unread', ['unreadCount', 'unread_count']);
    add('Members', ['memberCount', 'member_count']);
  } else if (result.renderer === 'notification') {
    add('From', ['sourceUsername', 'source_username']);
    add('PR', ['prNumber', 'pr_number']);
  } else if (result.renderer === 'leaderboard') {
    add('Kudos', ['kudosReceived', 'kudos_received']);
    add('PRs recognized', ['prsKudosed', 'prs_kudosed']);
    add('Merged', ['kudosReceivedPrsMerged', 'kudos_received_prs_merged']);
  } else if (result.renderer === 'setting') {
    const spending = text(item.name, 100) === 'Global Chat usage';
    if (spending) {
      add('Spent this month', ['spentUsd']);
      add('Monthly cap', ['capUsd']);
      add('Cap remaining', ['remainingUsd']);
      add('OpenRouter remaining', ['overallRemainingUsd']);
    } else {
      add('Model', ['profile.model', 'backends.codex_openrouter.model', 'model']);
      add('Reasoning', ['profile.reasoningEffort', 'reasoningEffort', 'reasoning_effort']);
      add('Enabled', ['profile.enabled', 'enabled']);
      add('Spent this month', ['usage.spentUsd', 'spentUsd']);
      add('Monthly cap', ['usage.capUsd', 'profile.spendCapUsd', 'capUsd']);
      add('OpenRouter remaining', ['overallRemaining', 'overallRemainingUsd']);
      add('Backend', ['backend', 'profile.backend']);
    }
    if (fields.length < 4) {
      for (const [key, raw] of Object.entries(item)) {
        if (fields.length >= 4) break;
        if (PRIVATE_KEY.test(key)
            || [...TITLE_KEYS, ...SUMMARY_KEYS, ...ID_KEYS, 'group', 'classicPath'].includes(key)
            || !['string', 'number', 'boolean'].includes(typeof raw)) continue;
        const label = humanize(key.split('.').at(-1) || key);
        const value = displayValue(key, raw);
        if (!value || seen.has(label)) continue;
        fields.push({ label, value });
        seen.add(label);
      }
    }
  }
  return fields.slice(0, 4);
}

function actionTargetLabel(result: GlobalChatResult, item: JsonObject, title: string) {
  const id = identifier(item)?.value;
  if (!id || title.includes(id)) return title;
  if (result.renderer === 'issue') return `${title} (#${id})`;
  if (result.renderer === 'proposal') return `${title} (proposal #${id})`;
  if (result.renderer === 'session') return `${title} (development #${id})`;
  return title;
}

function SettingInstruction({ item, title }: { item: JsonObject; title: string }) {
  const [editing, setEditing] = useState(false);
  const [instruction, setInstruction] = useState('');
  const group = text(item.group || item.id, 80);
  if (!group || group === 'global-chat') return null;

  function submit() {
    const requested = instruction.trim();
    if (!requested) return;
    setInstruction('');
    setEditing(false);
    void sendGlobalChatMessage(
      `In the "${title}" settings group (key: ${group}), ${requested}. `
      + 'Preserve every value I did not ask to change, use only capabilities for this settings group, '
      + 'and show the exact confirmation before saving.',
    );
  }

  return editing ? (
    <form
      className="global-chat-setting-instruction"
      onSubmit={(event) => { event.preventDefault(); submit(); }}
    >
      <input
        value={instruction}
        maxLength={500}
        autoFocus
        aria-label={`Change ${title}`}
        placeholder={`What should change in ${title}?`}
        onChange={(event) => setInstruction(event.target.value)}
      />
      <button type="submit" disabled={!instruction.trim()}>Continue</button>
      <button type="button" onClick={() => setEditing(false)}>Cancel</button>
    </form>
  ) : (
    <button type="button" className="global-chat-setting-edit" onClick={() => setEditing(true)}>
      Change these settings
    </button>
  );
}

const LOCAL_SETTING_EDITORS: Record<string, {
  setting: string;
  valueKey: string;
  options: Array<{ label: string; value: string }>;
}> = {
  theme: {
    setting: 'theme', valueKey: 'theme',
    options: [
      { label: 'System', value: 'system' },
      { label: 'Light', value: 'light' },
      { label: 'Dark', value: 'dark' },
    ],
  },
  alerts: {
    setting: 'devAlerts', valueKey: 'devAlerts',
    options: [{ label: 'On', value: 'true' }, { label: 'Off', value: 'false' }],
  },
  'dev-console': {
    setting: 'devConsoleMode', valueKey: 'devConsoleMode',
    options: [
      { label: 'Always', value: 'always' },
      { label: 'Errors only', value: 'errors-only' },
    ],
  },
  'admin-preview': {
    setting: 'adminPreview', valueKey: 'adminPreview',
    options: [{ label: 'On', value: 'true' }, { label: 'Off', value: 'false' }],
  },
};

function LocalSettingEditor({ item, title }: { item: JsonObject; title: string }) {
  const group = text(item.group || item.id, 80);
  const editor = LOCAL_SETTING_EDITORS[group];
  const initial = editor ? text(item[editor.valueKey], 40) : '';
  const [saved, setSaved] = useState(initial);
  const [selected, setSelected] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  if (!editor) return null;

  async function save() {
    if (!selected || selected === saved || saving) return;
    setSaving(true);
    setError('');
    try {
      const results = await loadGlobalChatInlineResults(
        'settings.local.update',
        { setting: editor.setting, value: selected },
        title,
      );
      const pending = results.find((result) => clientAction(result));
      if (!pending) throw new Error('The setting update was not returned.');
      const applied = await runGlobalChatClientAction(pending);
      if (!applied) throw new Error('Could not apply this setting.');
      setSaved(selected);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not save this setting.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="global-chat-setting-controls" aria-label={`Change ${title}`}>
      <div className="global-chat-inline-actions">
        {editor.options.map((option) => (
          <button
            key={option.value}
            type="button"
            className={selected === option.value ? 'global-chat-action-primary' : ''}
            aria-pressed={selected === option.value}
            onClick={() => setSelected(option.value)}
          >
            {option.label}
          </button>
        ))}
        <button
          type="button"
          disabled={!selected || selected === saved || saving}
          onClick={() => void save()}
        >
          {saving ? 'Saving…' : selected === saved ? 'Saved' : 'Save'}
        </button>
      </div>
      {error ? <div className="global-chat-inline-error" role="alert">{error}</div> : null}
    </div>
  );
}

function ItemRow({
  result,
  value,
  nested = false,
  itemSelection,
}: {
  result: GlobalChatResult;
  value: unknown;
  nested?: boolean;
  itemSelection?: GlobalChatItemSelection;
}) {
  const [expanded, setExpanded] = useState(nested);
  const [inlineResults, setInlineResults] = useState<Record<string, GlobalChatResult[]>>({});
  const [inlineLoading, setInlineLoading] = useState<string | null>(null);
  const [inlineError, setInlineError] = useState('');
  const item = object(value) || { value };
  const title = itemTitle(result, item);
  const targetLabel = actionTargetLabel(result, item, title);
  const summary = itemSummary(result, item, title);
  const meta = compactMetadata(result, item, title);
  const classicPath = itemClassicPath(result, item);
  const fields = displayFields(result, item);
  const showAppIcon = result.renderer === 'app' && !!text(item.slug || item.app_slug, 255);
  const selectedValue = itemSelection?.parameter === 'appSlug'
    ? resultAppSlug(result, item)
    : '';
  const selectionAction = itemSelection?.renderer === result.renderer && selectedValue
    ? itemAction(
      itemSelection.label,
      `${itemSelection.label} ${targetLabel}`,
      itemSelection.actionId,
      { [itemSelection.parameter]: selectedValue },
      'turn',
    )
    : null;
  const directActions = nested ? [] : directItemActions(result, item, targetLabel);
  const catalogView = directActions.find((action) => action.actionId === 'settings.inspect');

  async function loadInline(action: DirectItemAction) {
    if (inlineLoading || inlineResults[action.actionId]) return;
    setInlineLoading(action.actionId);
    setInlineError('');
    try {
      const loaded = await loadGlobalChatInlineResults(
        action.actionId,
        action.parameters,
        targetLabel,
      );
      setInlineResults((current) => ({ ...current, [action.actionId]: loaded }));
    } catch (reason) {
      setInlineError(reason instanceof Error ? reason.message : 'Could not load those details.');
    } finally {
      setInlineLoading(null);
    }
  }

  function toggleExpanded() {
    if (selectionAction) {
      void executeGlobalChatResultAction(
        selectionAction.requestLabel,
        selectionAction.actionId,
        selectionAction.parameters,
        targetLabel,
      );
      return;
    }
    const next = !expanded;
    setExpanded(next);
    if (next && catalogView) void loadInline(catalogView);
  }

  return (
    <article
      className={`global-chat-item${selectionAction ? ' global-chat-item-selector' : ''}`}
      data-expanded={selectionAction ? undefined : expanded || undefined}
    >
      {showAppIcon ? (
        <div
          className="app-icon-tile global-chat-app-icon shrink-0 overflow-hidden flex items-center justify-center text-lg font-bold"
          data-icon={appIconKind(item)}
        >
          <AppIconContent app={item} />
        </div>
      ) : null}
      <div className="min-w-0 flex-1">
        <button
          type="button"
          className="global-chat-item-toggle"
          aria-expanded={selectionAction ? undefined : expanded}
          aria-label={selectionAction?.requestLabel}
          onClick={toggleExpanded}
        >
          <span className="min-w-0 flex-1 text-left">
            <span className="global-chat-item-title">{title}</span>
            {meta ? <span className="global-chat-item-meta">{meta}</span> : null}
          </span>
          {!selectionAction ? <ChevronDownIcon className="global-chat-item-chevron" aria-hidden="true" /> : null}
        </button>
        {!selectionAction && expanded ? (
          <div className="global-chat-item-details">
            {summary && summary !== title ? <p className="global-chat-item-summary">{summary}</p> : null}
            {fields.length ? (
              <dl className="global-chat-item-fields">
                {fields.map(({ label, value: fieldValue }) => (
                  <div key={label}><dt>{label}</dt><dd>{fieldValue}</dd></div>
                ))}
              </dl>
            ) : null}
            {!nested ? (
              <div className="global-chat-inline-actions">
                {directActions.filter((action) => action.actionId !== 'settings.inspect').map((action) => (
                  <button
                    key={action.actionId}
                    type="button"
                    disabled={inlineLoading === action.actionId}
                    onClick={() => action.mode === 'inline'
                      ? void loadInline(action)
                      : void executeGlobalChatResultAction(
                        action.requestLabel,
                        action.actionId,
                        action.parameters,
                        targetLabel,
                      )}
                  >
                    {inlineLoading === action.actionId ? 'Loading…' : action.label}
                  </button>
                ))}
                {classicPath ? <button type="button" onClick={() => closeGlobalChat(classicPath)}>Open in Classic</button> : null}
              </div>
            ) : classicPath ? (
              <div className="global-chat-inline-actions">
                <button type="button" onClick={() => closeGlobalChat(classicPath)}>Open in Classic</button>
              </div>
            ) : null}
            {inlineLoading === 'settings.inspect' ? (
              <div className="global-chat-inline-loading">Loading current settings…</div>
            ) : null}
            {inlineError ? <div className="global-chat-inline-error" role="alert">{inlineError}</div> : null}
            {Object.values(inlineResults).flat().map((loaded) => (
              <GlobalChatResultBlock key={loaded.id} result={loaded} nested />
            ))}
            {result.renderer === 'setting' && result.capabilityId === 'settings.inspect'
              ? (LOCAL_SETTING_EDITORS[text(item.group || item.id, 80)]
                ? <LocalSettingEditor item={item} title={title} />
                : <SettingInstruction item={item} title={title} />)
              : null}
          </div>
        ) : null}
      </div>
    </article>
  );
}

function ConfirmationResult({ result, payload }: { result: GlobalChatResult; payload: JsonObject }) {
  const snapshot = useGlobalChatState();
  const token = text(payload.confirmationToken, 500);
  const consumed = !!snapshot.consumedConfirmations[result.id];
  const dismissed = !!snapshot.dismissedConfirmations[result.id];
  const expiresAt = text(payload.expiresAt, 80);
  const preview = object(payload.preview);
  const previewRows = preview ? Object.entries(preview).filter(([, value]) => (
    ['string', 'number', 'boolean'].includes(typeof value) && text(value, 500)
  )).slice(0, 6) : [];
  if (dismissed) {
    return <div className="global-chat-confirmation global-chat-confirmation-muted">Cancelled.</div>;
  }
  return (
    <section className="global-chat-confirmation" aria-label="Confirm action">
      <div className="min-w-0">
        <strong>{text(payload.title, 100) || humanizeCapability(result.capabilityId)}</strong>
        {previewRows.length ? (
          <dl className="global-chat-confirmation-details">
            {previewRows.map(([key, value]) => (
              <div key={key}>
                <dt>{key.replace(/([a-z])([A-Z])/g, '$1 $2')}</dt>
                <dd>{text(value, key === 'task' ? 500 : 160)}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        {expiresAt ? <p>Confirm before {new Date(expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.</p> : null}
      </div>
      <div className="global-chat-inline-actions">
        <button
          type="button"
          className="global-chat-action-primary"
          disabled={!token || consumed}
          onClick={() => void confirmGlobalChatAction(result, token)}
        >
          {consumed ? 'Confirmed' : 'Confirm'}
        </button>
        {!consumed ? <button type="button" onClick={() => dismissConfirmation(result.id)}>Cancel</button> : null}
        {result.classicPath ? <button type="button" onClick={() => closeGlobalChat(result.classicPath)}>Open in Classic</button> : null}
      </div>
    </section>
  );
}

function ClientActionResult({ result }: { result: GlobalChatResult }) {
  const snapshot = useGlobalChatState();
  const action = clientAction(result);
  if (!action) return null;
  const actionState = snapshot.clientActionStates[result.id];
  const navigation = action.transport === 'navigation';
  const localSetting = action.transport === 'local_setting';
  return (
    <div className="global-chat-inline-actions global-chat-client-action">
      <button
        type="button"
        className="global-chat-action-primary"
        disabled={actionState === 'running' || actionState === 'done'}
        onClick={() => void runGlobalChatClientAction(result)}
      >
        {actionState === 'running' ? 'Applying…' : actionState === 'done' ? 'Done' : navigation ? 'Open in Classic' : localSetting ? 'Apply' : 'Open'}
      </button>
      {!navigation && result.classicPath ? <button type="button" onClick={() => closeGlobalChat(result.classicPath)}>Open in Classic</button> : null}
    </div>
  );
}

export function GlobalChatResultBlock({
  result,
  nested = false,
  itemSelection,
}: {
  result: GlobalChatResult;
  nested?: boolean;
  itemSelection?: GlobalChatItemSelection;
}) {
  const payload = unwrapped(result);
  const confirmation = object(payload)?.status === 'confirmation_required';
  const action = clientAction(result);
  const items = useMemo(() => action ? [] : findItems(payload), [action, payload]);
  const pageSize = result.renderer === 'app' ? 6 : 3;
  const [visibleCount, setVisibleCount] = useState(pageSize);
  if (confirmation) return <ConfirmationResult result={result} payload={object(payload) || {}} />;
  if (action) {
    return (
      <section
        className={`global-chat-result${nested ? ' global-chat-result-nested' : ''}`}
        data-renderer={result.renderer}
      >
        <header className="global-chat-result-head">
          <span>{action.transport === 'navigation' ? 'Open in Classic' : 'Ready to apply'}</span>
        </header>
        <ClientActionResult result={result} />
      </section>
    );
  }
  if (result.renderer === 'setting'
      && result.capabilityId === 'settings.inspect'
      && object(payload)?.group === 'global-chat') {
    return (
      <section
        className={`global-chat-result global-chat-result-settings${nested ? ' global-chat-result-nested' : ''}`}
        data-renderer="setting"
      >
        <header className="global-chat-result-head"><span>Global Chat settings</span></header>
        <GlobalChatSettingsEditor embedded />
        {result.classicPath ? (
          <div className="global-chat-inline-actions global-chat-client-action">
            <button type="button" onClick={() => closeGlobalChat(result.classicPath)}>Open in Classic</button>
          </div>
        ) : null}
      </section>
    );
  }
  if (result.renderer === 'setting'
      && result.capabilityId === 'settings.inspect'
      && object(payload)?.group === 'openrouter') {
    return (
      <section
        className={`global-chat-result global-chat-result-settings${nested ? ' global-chat-result-nested' : ''}`}
        data-renderer="setting"
      >
        <header className="global-chat-result-head"><span>Development AI settings</span></header>
        <DevelopmentAISettingsEditor />
        {result.classicPath ? (
          <div className="global-chat-inline-actions global-chat-client-action">
            <button type="button" onClick={() => closeGlobalChat(result.classicPath)}>Open in Classic</button>
          </div>
        ) : null}
      </section>
    );
  }

  const visible = items.slice(0, visibleCount);
  return (
    <section
      className={`global-chat-result${nested ? ' global-chat-result-nested' : ''}${itemSelection ? ' global-chat-result-selector' : ''}`}
      data-renderer={result.renderer}
    >
      <header className="global-chat-result-head">
        <span>{resultLabel(result)}</span>
      </header>
      {visible.length ? (
        <div className="global-chat-result-items">
          {visible.map((item, index) => (
            <ItemRow
              key={`${result.id}-${index}`}
              result={result}
              value={item}
              nested={nested}
              itemSelection={itemSelection}
            />
          ))}
        </div>
      ) : null}
      {items.length > visible.length ? (
        <button
          type="button"
          className="global-chat-expand"
          onClick={() => setVisibleCount((count) => Math.min(count + pageSize, items.length))}
        >
          Show more <ChevronDownIcon className="w-3.5 h-3.5" aria-hidden="true" />
        </button>
      ) : null}
      {!items.length ? (
        <div className="global-chat-result-done">{emptyResultMessage(result)}</div>
      ) : null}
    </section>
  );
}
