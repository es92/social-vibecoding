// Tests for the import-existing-repo pre-flight: github.verifyBotAccess()
// and the invitation accept it runs first (#3021).
//
// A user who added usernode-bot as a collaborator on a repository owned by
// a PERSONAL account was told the bot lacked "Write access" — a level such
// repositories do not have (every collaborator can push). The collaborator
// was real; the bot had simply never accepted the invitation, because the
// accept step read only the first 30 of the bot's pending invitations and
// stopped at the first match even when that match had expired.
//
// Invariants pinned here:
//   1. The accept step walks every page of pending invitations.
//   2. An expired duplicate never shadows the live invitation.
//   3. Read-only is never treated as write, for any owner type.
//   4. A personal-account repo without push gets a message about the
//      missing collaborator/invitation, not "grant Write".
//   5. Private repositories are still refused.
//
// Run with: node --test tests/github-verify-bot-access.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');

const github = require('../src/services/github');

function invite(id, owner, name, extra = {}) {
  return { id, repository: { name, owner: { login: owner } }, ...extra };
}

function filler(n, start = 1) {
  return Array.from({ length: n }, (_, i) => invite(start + i, `someone${start + i}`, 'other'));
}

// A stub octokit exposing just the three calls the pre-flight makes.
function stubOctokit({ invitations = [], repo, repoError, acceptFails = [] }) {
  const calls = { list: [], accepted: [], get: 0 };
  const client = {
    rest: {
      repos: {
        listInvitationsForAuthenticatedUser: async (params) => {
          calls.list.push(params);
          const per = params.per_page || 30;
          const page = params.page || 1;
          return { data: invitations.slice((page - 1) * per, page * per) };
        },
        acceptInvitationForAuthenticatedUser: async ({ invitation_id }) => {
          if (acceptFails.includes(invitation_id)) {
            const err = new Error('Invitation expired');
            err.status = 404;
            throw err;
          }
          calls.accepted.push(invitation_id);
          return { status: 204 };
        },
        get: async () => {
          calls.get++;
          if (repoError) throw repoError;
          return { data: typeof repo === 'function' ? repo(calls) : repo };
        },
      },
    },
  };
  return { client, calls };
}

function withStub(t, stub) {
  github._setOctokitFactoryForTests(() => stub.client);
  t.after(() => github._setOctokitFactoryForTests(null));
}

function repoData({ ownerType = 'User', push = false, isPrivate = false } = {}) {
  return {
    name: 'demo',
    full_name: 'alice/demo',
    description: 'A demo',
    private: isPrivate,
    owner: { login: 'alice', type: ownerType },
    permissions: { admin: false, maintain: false, push, triage: false, pull: true },
  };
}

test('accepts an invitation that sits past the first page of pending invitations', async (t) => {
  const invitations = [...filler(130), invite(9001, 'Alice', 'Demo')];
  const stub = stubOctokit({ invitations, repo: repoData() });
  withStub(t, stub);

  assert.equal(await github.acceptInvitationFor('alice', 'demo'), true);
  assert.deepEqual(stub.calls.accepted, [9001]);
  assert.deepEqual(stub.calls.list.map((p) => p.page), [1, 2]);
  assert.ok(stub.calls.list.every((p) => p.per_page === 100));
});

test('an expired duplicate does not shadow the live invitation', async (t) => {
  const invitations = [
    invite(1, 'alice', 'demo', { expired: true }),
    invite(2, 'alice', 'demo', { expired: false }),
  ];
  const stub = stubOctokit({ invitations, repo: repoData(), acceptFails: [1] });
  withStub(t, stub);

  assert.equal(await github.acceptInvitationFor('alice', 'demo'), true);
  assert.deepEqual(stub.calls.accepted, [2]);
});

test('returns false when only an expired invitation exists', async (t) => {
  const stub = stubOctokit({ invitations: [invite(1, 'alice', 'demo', { expired: true })], repo: repoData() });
  withStub(t, stub);
  assert.equal(await github.acceptInvitationFor('alice', 'demo'), false);
  assert.deepEqual(stub.calls.accepted, []);
});

test('personal-repo collaborator: accepting the late invitation turns the check green', async (t) => {
  const invitations = [...filler(45), invite(77, 'alice', 'demo')];
  // Push flips on only once the invitation has been accepted, as on GitHub.
  const stub = stubOctokit({
    invitations,
    repo: (calls) => repoData({ push: calls.accepted.includes(77) }),
  });
  withStub(t, stub);

  const r = await github.verifyBotAccess('alice', 'demo');
  assert.equal(r.ok, true);
  assert.equal(r.fullName, 'alice/demo');
});

test('personal repo without push explains the missing collaborator, not a Write level', async (t) => {
  const stub = stubOctokit({ invitations: [], repo: repoData({ ownerType: 'User', push: false }) });
  withStub(t, stub);

  const r = await github.verifyBotAccess('alice', 'demo');
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
  assert.equal(r.code, 'not_collaborator');
  assert.match(r.message, /not a collaborator/);
  assert.match(r.message, /expire/);
  assert.doesNotMatch(r.message, /Grant Write/);
});

test('organization repo with read-only access is still refused as no_push', async (t) => {
  const stub = stubOctokit({ invitations: [], repo: repoData({ ownerType: 'Organization', push: false }) });
  withStub(t, stub);

  const r = await github.verifyBotAccess('acme', 'demo');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'no_push');
  assert.match(r.message, /read-only/);
});

test('organization repo with push passes', async (t) => {
  const stub = stubOctokit({ invitations: [], repo: repoData({ ownerType: 'Organization', push: true }) });
  withStub(t, stub);
  assert.equal((await github.verifyBotAccess('acme', 'demo')).ok, true);
});

test('private repositories are still refused, even with push', async (t) => {
  const stub = stubOctokit({ invitations: [], repo: repoData({ push: true, isPrivate: true }) });
  withStub(t, stub);

  const r = await github.verifyBotAccess('alice', 'demo');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'private_repo');
});

test('a 404 does not suggest that inviting the bot makes a private repo importable', async (t) => {
  const err = new Error('Not Found');
  err.status = 404;
  const stub = stubOctokit({ invitations: [], repoError: err });
  withStub(t, stub);

  const r = await github.verifyBotAccess('alice', 'demo');
  assert.equal(r.code, 'not_found');
  assert.match(r.message, /public repositories only/);
  assert.doesNotMatch(r.message, /If it's private, invite/);
});

test('an invitation-list failure does not mask the real access answer', async (t) => {
  const stub = stubOctokit({ repo: repoData({ push: true }) });
  stub.client.rest.repos.listInvitationsForAuthenticatedUser = async () => {
    throw new Error('boom');
  };
  withStub(t, stub);
  assert.equal((await github.verifyBotAccess('alice', 'demo')).ok, true);
});
