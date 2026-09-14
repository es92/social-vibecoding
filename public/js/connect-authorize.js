/* Consent page for the hosted MCP connector.
 *
 * Claude.ai / ChatGPT send the user here with the standard OAuth
 * authorization-request parameters. The page:
 *
 *   1. reads them from the QUERY STRING (they are not secrets — the code is
 *      minted later, and PKCE binds it to the client that asked),
 *   2. asks the server for display details, which requires a platform
 *      session (an anonymous visitor is sent to sign in with this request
 *      as `?return_to=`, and is brought straight back here),
 *   3. shows who is asking, the address they will be sent back to, and what
 *      is being allowed, and
 *   4. on an explicit Allow, posts the decision and follows the redirect
 *      the server hands back.
 *
 * The page never mints anything itself and never sees a token.
 */
(function () {
  'use strict';

  var params = new URLSearchParams(window.location.search);
  var request = {
    clientId: params.get('client_id') || '',
    redirectUri: params.get('redirect_uri') || '',
    scope: params.get('scope') || '',
    state: params.get('state') || '',
    codeChallenge: params.get('code_challenge') || '',
    codeChallengeMethod: params.get('code_challenge_method') || '',
    responseType: params.get('response_type') || '',
  };

  var entry = document.getElementById('entry');
  var entryMessage = document.getElementById('entry-message');
  var confirmation = document.getElementById('confirmation');
  var result = document.getElementById('result');
  var message = document.getElementById('message');

  function showEntry(text, isError) {
    entryMessage.textContent = text;
    entryMessage.className = isError ? 'error' : '';
    entry.hidden = false;
    confirmation.hidden = true;
    result.hidden = true;
  }

  function showResult(text, isError) {
    message.textContent = text;
    message.className = isError ? 'error' : '';
    entry.hidden = true;
    confirmation.hidden = true;
    result.hidden = false;
  }

  // One generic message for every failed lookup — a distinguishable
  // "unknown client" vs "bad redirect" would let someone probe which
  // client ids exist.
  var GENERIC_INVALID = 'This connection request is invalid or has expired. Start a new one from Claude or ChatGPT.';

  function looksComplete() {
    return request.clientId
      && request.redirectUri
      && request.codeChallenge
      && request.codeChallengeMethod === 'S256'
      && request.responseType === 'code';
  }

  async function load() {
    if (!looksComplete()) {
      showEntry(
        'Start the connection from Claude or ChatGPT and the approval details will open here automatically.',
        false
      );
      return;
    }

    var query = new URLSearchParams({
      client_id: request.clientId,
      redirect_uri: request.redirectUri,
    });
    if (request.scope) query.set('scope', request.scope);

    var resp;
    try {
      resp = await fetch('/api/connect/authorization?' + query.toString(), {
        credentials: 'same-origin',
        cache: 'no-store',
      });
    } catch (err) {
      showEntry('Could not reach Homeroom. Check your connection and reload.', true);
      return;
    }

    if (resp.status === 401) {
      // Sign in, then come back to this exact request.
      //
      // The return target goes in the QUERY STRING, and the '#login' that
      // picks the screen goes in the fragment. It used to be the other way
      // round — '/#login?next=<encoded>' — and nothing could act on that:
      // a fragment never reaches the server, restoreFromHash splits the
      // fragment's own query off and drops it for auth routes, and
      // AuthScreens.finishLogin reads location.search. The value survived
      // in the address bar, was read by nobody, and signing in landed on
      // the feed with the request gone, so it had to be started again from
      // the chat product.
      //
      // '?return_to=<path>#login' is the form the platform already honours
      // (the CLI consent page uses it) and this page's path is on
      // finishLogin's allowlist. replace() rather than an assignment so
      // Back from the login screen leaves, instead of bouncing through a
      // request that is answered the same way.
      window.location.replace('/?return_to='
        + encodeURIComponent(window.location.pathname + window.location.search)
        + '#login');
      return;
    }
    // Platform access is a SECOND gate, separate from having a session, and
    // it is the ordinary state of a brand new account: `has_platform_access`
    // defaults FALSE (src/db/schema.sql) until the waitlist releases it.
    // Somebody who SIGNED UP from this page therefore comes back holding a
    // real session and still cannot be shown the request. Answering with
    // GENERIC_INVALID would blame the request, which is not what is wrong —
    // the request is fine and the account is not ready — and would send them
    // back to Claude or ChatGPT to retry something that cannot yet succeed.
    if (resp.status === 403) {
      showEntry(
        'Your Homeroom account has not been released off the waitlist yet, so it '
        + 'cannot approve a connection. Once it is, start the connection again '
        + 'from Claude or ChatGPT.',
        true
      );
      return;
    }
    if (!resp.ok) {
      showEntry(GENERIC_INVALID, true);
      return;
    }

    var data = await resp.json().catch(function () { return null; });
    if (!data) {
      showEntry(GENERIC_INVALID, true);
      return;
    }

    document.getElementById('intro').textContent =
      data.client_name + ' is asking to connect to your Homeroom account.';
    document.getElementById('confirm-client').textContent = data.client_name;
    document.getElementById('confirm-origin').textContent = data.redirect_origin;
    document.getElementById('confirm-user').textContent = data.username;

    var list = document.getElementById('confirm-scopes');
    list.textContent = '';
    (data.scopes || []).forEach(function (scope) {
      var li = document.createElement('li');
      var label = document.createElement('strong');
      label.textContent = scope.label;
      var detail = document.createElement('span');
      detail.textContent = scope.detail;
      li.appendChild(label);
      li.appendChild(detail);
      list.appendChild(li);
    });

    entry.hidden = true;
    confirmation.hidden = false;
  }

  async function decide(decision) {
    var approve = document.getElementById('approve');
    var reject = document.getElementById('reject');
    approve.disabled = true;
    reject.disabled = true;

    var resp;
    try {
      resp = await fetch('/api/connect/oauth/authorize', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          decision: decision,
          client_id: request.clientId,
          redirect_uri: request.redirectUri,
          scope: request.scope,
          state: request.state,
          code_challenge: request.codeChallenge,
          code_challenge_method: request.codeChallengeMethod,
        }),
      });
    } catch (err) {
      approve.disabled = false;
      reject.disabled = false;
      showResult('Could not reach Homeroom. Try again.', true);
      return;
    }

    if (!resp.ok) {
      approve.disabled = false;
      reject.disabled = false;
      showResult(GENERIC_INVALID, true);
      return;
    }

    var data = await resp.json().catch(function () { return null; });
    if (!data || !data.redirect_to) {
      showResult(GENERIC_INVALID, true);
      return;
    }
    showResult(
      decision === 'approve'
        ? 'Connected. Returning you to your chat…'
        : 'Cancelled. Returning you to your chat…',
      false
    );
    window.location.href = data.redirect_to;
  }

  document.getElementById('approve').addEventListener('click', function () {
    decide('approve');
  });
  document.getElementById('reject').addEventListener('click', function () {
    decide('deny');
  });

  load();
})();
