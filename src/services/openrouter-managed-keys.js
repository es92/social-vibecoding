'use strict';

const log = require('./logger');
const credentialStore = require('./credential-store');
const managementClient = require('./openrouter-management-client');
const agentModels = require('./agent-models');
const agentPreferences = require('./agent-preferences');
const notifications = require('./notifications');

const OPENROUTER = { provider: 'openrouter', purpose: 'coding_agent' };

class ManagedOpenRouterError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = 'ManagedOpenRouterError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function managementOptions(config) {
  return {
    apiKey: config.openrouterManagementApiKey,
    baseUrl: config.openrouterApiBase,
    origin: config.openrouterOrigin,
  };
}

function requiresVerifiedIdentity(config) {
  return config?.openrouterManagedRequireVerifiedIdentity === true;
}

function publicState(row) {
  if (!row?.managed_key_id) return null;
  return {
    id: row.managed_key_id,
    status: row.managed_status,
    label: row.remote_label || null,
    dailyLimitUsd: row.daily_limit_usd == null ? null : Number(row.daily_limit_usd),
    limitReset: row.limit_reset || null,
    issuedAt: row.issued_at || null,
    disabledAt: row.disabled_at || null,
    deletedAt: row.deleted_at || null,
  };
}

async function stateForUser(pool, userId) {
  const { rows } = await pool.query(
    `SELECT EXISTS (
              SELECT 1 FROM user_social_identities identity
               WHERE identity.user_id = $1
            ) AS verified,
            managed.id AS managed_key_id,
            managed.status AS managed_status,
            managed.remote_key_hash,
            managed.remote_label,
            managed.workspace_id,
            managed.daily_limit_usd,
            managed.limit_reset,
            managed.last_error_code,
            managed.issued_at,
            managed.disabled_at,
            managed.deleted_at,
            managed.created_at,
            managed.updated_at,
            credential.status AS credential_status,
            credential.secret_last4
       FROM (SELECT 1) anchor
       LEFT JOIN credentials.managed_openrouter_keys managed
         ON managed.user_id = $1
       LEFT JOIN credentials.user_ai_credentials credential
         ON credential.id = managed.credential_id`,
    [userId],
  );
  return rows[0] || { verified: false };
}

async function notifyAdmins(pool, args) {
  try {
    await notifications.notifyManagedOpenRouterAdmins(pool, args);
  } catch (err) {
    log.warn('openrouter-managed', 'admin notification failed', {
      sourceUserId: args.sourceUserId, managedKeyId: args.managedKeyId,
      kind: args.kind, err: err.message,
    });
  }
}

async function markNeedsReview(pool, id, userId, err) {
  const code = String(err?.code || 'provision_failed').slice(0, 64);
  await pool.query(
    `UPDATE credentials.managed_openrouter_keys
        SET status = 'needs_review', last_error_code = $2, updated_at = NOW()
      WHERE id = $1`,
    [id, code],
  ).catch(() => {});
  await notifyAdmins(pool, {
    sourceUserId: userId, managedKeyId: id, kind: 'openrouter_key_review',
  });
}

async function chooseDefaultModel({ pool, userId, apiKey, config }) {
  try {
    const catalog = await agentModels.listOpenRouterModels({
      pool,
      userId,
      credentialRevision: 'managed-provision',
      apiKey,
      config,
      forceRefresh: true,
    });
    return catalog.recommendedModelId || config.openrouterDefaultCodexModel || null;
  } catch (err) {
    log.warn('openrouter-managed', 'model catalog unavailable during provisioning', {
      userId, err: err.message,
    });
    return config.openrouterDefaultCodexModel || null;
  }
}

async function provision({ pool, userId, config }) {
  if (!config.openrouterManagementApiKey) {
    throw new ManagedOpenRouterError(
      503,
      'not_configured',
      'Company OpenRouter keys are not configured yet. Ask an administrator to check USERNODE_OPENROUTER_MANAGEMENT_API_KEY.',
    );
  }

  // Reserve the user's one lifetime issuance before the provider call. The
  // user row serializes concurrent claims. When the optional verification
  // policy is enabled, identity proofs are also locked so unlink cannot race
  // the eligibility decision.
  const reservation = await credentialStore.withTransaction(pool, async (client) => {
    await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);
    if (requiresVerifiedIdentity(config)) {
      const { rows: identityRows } = await client.query(
        `SELECT id FROM user_social_identities
          WHERE user_id = $1
          FOR SHARE`,
        [userId],
      );
      if (!identityRows.length) {
        throw new ManagedOpenRouterError(403, 'verification_required', 'Connect a verified GitHub or X account first.');
      }
    }
    const existingCredential = await credentialStore.readMetadata({
      pool: client, userId, ...OPENROUTER,
    });
    if (existingCredential?.status === 'valid') {
      throw new ManagedOpenRouterError(409, 'byok_configured', 'Remove your personal OpenRouter key before claiming the included key.');
    }
    const { rows } = await client.query(
      `INSERT INTO credentials.managed_openrouter_keys
         (user_id, workspace_id, daily_limit_usd, limit_reset, status)
       VALUES ($1, $2, $3, 'daily', 'provisioning')
       ON CONFLICT (user_id) DO NOTHING
       RETURNING id`,
      [userId, config.openrouterManagedWorkspaceId || null, config.openrouterManagedDailyLimitUsd],
    );
    if (!rows.length) {
      throw new ManagedOpenRouterError(409, 'already_issued', 'This account has already received its company OpenRouter key.');
    }
    return rows[0];
  });

  let remote;
  try {
    remote = await managementClient.createKey({
      ...managementOptions(config),
      name: `usernode-user-${userId}`,
      limit: config.openrouterManagedDailyLimitUsd,
      workspaceId: config.openrouterManagedWorkspaceId || undefined,
    });
  } catch (err) {
    await markNeedsReview(pool, reservation.id, userId, err);
    throw new ManagedOpenRouterError(
      502,
      'provisioning_needs_review',
      'OpenRouter provisioning could not be confirmed. An admin has been notified; the request was not retried to avoid creating a duplicate key.',
    );
  }

  try {
    const { rows: recordedRows } = await pool.query(
      `UPDATE credentials.managed_openrouter_keys
          SET remote_key_hash = $2, remote_label = $3, updated_at = NOW()
        WHERE id = $1 AND status = 'provisioning'
        RETURNING id`,
      [reservation.id, remote.hash, remote.label],
    );
    if (!recordedRows.length) throw new Error('managed reservation unavailable after provider creation');
    const modelId = await chooseDefaultModel({ pool, userId, apiKey: remote.key, config });
    const saved = await credentialStore.withTransaction(pool, async (client) => {
      const { rows } = await client.query(
        `SELECT id FROM credentials.managed_openrouter_keys
          WHERE id = $1 AND user_id = $2 AND status = 'provisioning'
          FOR UPDATE`,
        [reservation.id, userId],
      );
      if (!rows.length) throw new Error('managed reservation changed during provisioning');
      const credential = await credentialStore.writeOpenRouterCodingAgentOnClient({
        client,
        userId,
        apiKey: remote.key,
        dataKey: config.dataEncryptionKey,
        metadata: {
          source: 'usernode_managed',
          managedKeyId: reservation.id,
          keyInfo: {
            label: remote.label,
            limit: remote.limit,
            limitRemaining: remote.limitRemaining,
            limitReset: remote.limitReset,
          },
        },
      });
      await client.query(
        `UPDATE credentials.managed_openrouter_keys
            SET credential_id = $2, status = 'active', issued_at = NOW(),
                last_error_code = NULL, updated_at = NOW()
          WHERE id = $1`,
        [reservation.id, credential.id],
      );
      await agentPreferences.setDefaultBackend(client, userId, {
        backend: 'codex_openrouter', model: modelId, reasoningEffort: null,
      });
      return { credential, modelId };
    });

    agentModels.invalidateUser(userId);
    await notifyAdmins(pool, {
      sourceUserId: userId,
      managedKeyId: reservation.id,
      kind: 'openrouter_key_created',
    });
    // Close the unlink-during-provision race when verification is required.
    // There is deliberately no automatic revocation; a second, deduplicated
    // review notification is emitted only if the user lost their final proof
    // while OpenRouter was creating the key.
    await notifyIdentityReview({ pool, userId, config }).catch((err) => {
      log.warn('openrouter-managed', 'post-provision identity review check failed', {
        userId, managedKeyId: reservation.id, err: err.message,
      });
    });
    log.info('openrouter-managed', 'managed child key provisioned', {
      userId, managedKeyId: reservation.id, remoteHash: remote.hash,
    });
    return {
      revision: saved.credential.revision,
      defaultModel: saved.modelId,
      keyInfo: {
        label: remote.label,
        limit: remote.limit,
        limitRemaining: remote.limitRemaining,
        limitReset: remote.limitReset,
      },
      managed: { id: reservation.id, status: 'active' },
    };
  } catch (err) {
    await markNeedsReview(pool, reservation.id, userId, err);
    throw new ManagedOpenRouterError(
      500,
      'provisioning_needs_review',
      'The OpenRouter key was created but could not be saved safely. An admin has been notified to reconcile it.',
    );
  }
}

async function managedRowById(pool, id) {
  const { rows } = await pool.query(
    `SELECT managed.*, credential.status AS credential_status
       FROM credentials.managed_openrouter_keys managed
       LEFT JOIN credentials.user_ai_credentials credential
         ON credential.id = managed.credential_id
      WHERE managed.id = $1`,
    [id],
  );
  return rows[0] || null;
}

async function setDisabled({ pool, id, disabled, config, actorId }) {
  if (!config.openrouterManagementApiKey) {
    throw new ManagedOpenRouterError(503, 'not_configured', 'OpenRouter management is not configured.');
  }
  const row = await managedRowById(pool, id);
  if (!row) throw new ManagedOpenRouterError(404, 'not_found', 'Managed OpenRouter key not found.');
  if (row.status === 'deleted') throw new ManagedOpenRouterError(409, 'deleted', 'This managed key has already been deleted.');
  if (!row.remote_key_hash) throw new ManagedOpenRouterError(409, 'needs_review', 'This key has no confirmed OpenRouter hash and needs manual review.');

  await managementClient.setDisabled({
    ...managementOptions(config), hash: row.remote_key_hash, disabled,
  });
  try {
    await credentialStore.withTransaction(pool, async (client) => {
      const changed = await credentialStore.setStatusOnClient({
        client, userId: row.user_id, ...OPENROUTER,
        status: disabled ? 'disabled' : 'valid',
      });
      if (!changed) throw new Error('managed credential material is unavailable');
      await client.query(
        `UPDATE credentials.managed_openrouter_keys
            SET status = $2::varchar(24),
                disabled_at = CASE WHEN $2::varchar(24) = 'disabled' THEN NOW() ELSE NULL END,
                last_error_code = NULL, updated_at = NOW()
          WHERE id = $1`,
        [id, disabled ? 'disabled' : 'active'],
      );
    });
  } catch (err) {
    await markNeedsReview(pool, id, row.user_id, err);
    throw new ManagedOpenRouterError(500, 'needs_review', 'OpenRouter changed the key, but local state needs manual review.');
  }
  agentModels.invalidateUser(row.user_id);
  log.warn('openrouter-managed', disabled ? 'managed key disabled' : 'managed key enabled', {
    actorId, userId: row.user_id, managedKeyId: id, remoteHash: row.remote_key_hash,
  });
  return { id: Number(id), status: disabled ? 'disabled' : 'active' };
}

async function remove({ pool, id, config, actorId }) {
  if (!config.openrouterManagementApiKey) {
    throw new ManagedOpenRouterError(503, 'not_configured', 'OpenRouter management is not configured.');
  }
  const row = await managedRowById(pool, id);
  if (!row) throw new ManagedOpenRouterError(404, 'not_found', 'Managed OpenRouter key not found.');
  if (row.status === 'deleted') return { id: Number(id), status: 'deleted' };
  if (!row.remote_key_hash) throw new ManagedOpenRouterError(409, 'needs_review', 'This key has no confirmed OpenRouter hash and needs manual review.');

  await managementClient.deleteKey({
    ...managementOptions(config), hash: row.remote_key_hash,
  });
  try {
    await credentialStore.withTransaction(pool, async (client) => {
      await credentialStore.revokeOnClient({ client, userId: row.user_id, ...OPENROUTER });
      await client.query(
        `UPDATE credentials.managed_openrouter_keys
            SET status = 'deleted', deleted_at = NOW(), disabled_at = NULL,
                last_error_code = NULL, updated_at = NOW()
          WHERE id = $1`,
        [id],
      );
      await agentPreferences.setDefaultBackend(client, row.user_id, {
        backend: 'claude_code', model: null, reasoningEffort: null,
      });
    });
  } catch (err) {
    await markNeedsReview(pool, id, row.user_id, err);
    throw new ManagedOpenRouterError(500, 'needs_review', 'OpenRouter deleted the key, but local state needs manual review.');
  }
  agentModels.invalidateUser(row.user_id);
  log.warn('openrouter-managed', 'managed key deleted', {
    actorId, userId: row.user_id, managedKeyId: id, remoteHash: row.remote_key_hash,
  });
  return { id: Number(id), status: 'deleted' };
}

async function notifyIdentityReview({ pool, userId, config }) {
  if (!requiresVerifiedIdentity(config)) return false;
  const state = await stateForUser(pool, userId);
  if (state.verified || !state.managed_key_id
      || !['active', 'disabled'].includes(state.managed_status)) return false;
  await notifyAdmins(pool, {
    sourceUserId: userId,
    managedKeyId: state.managed_key_id,
    kind: 'openrouter_key_review',
  });
  return true;
}

module.exports = {
  ManagedOpenRouterError,
  OPENROUTER,
  requiresVerifiedIdentity,
  publicState,
  stateForUser,
  provision,
  setDisabled,
  remove,
  notifyIdentityReview,
};
