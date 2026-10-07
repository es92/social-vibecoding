'use strict';

// Return moves to the next field, and the last field submits (request #3907).
//
// The Homeroom iOS app drops WKWebView's keyboard accessory bar (the up/down
// chevrons and the check mark above the keys, flutter-mobile-app PR #603).
// Those chevrons were the only way between fields in several forms, so
// Return does it now, through one helper (frontend/src/lib/return-to-next.ts)
// on each form's container. This pins the helper's rule and, form by form,
// that it is wired and that every field's `enterKeyHint` says what Return
// does there.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderComponent, createElement, renderToHtml } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const LIB = 'frontend/src/lib/return-to-next.ts';
const lib = () => loadTsx(LIB);

// ── a DOM small enough to read ─────────────────────────────────────────

function field(tag, props = {}) {
  const attrs = { ...(props.attrs || {}) };
  const el = {
    tagName: tag.toUpperCase(),
    type: tag === 'input' ? 'text' : undefined,
    disabled: false,
    readOnly: false,
    tabIndex: 0,
    value: '',
    form: null,
    focused: false,
    blurred: false,
    selection: null,
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    closest: () => null,
    getClientRects: () => [{}],
    focus() { el.focused = true; },
    blur() { el.blurred = true; },
    setSelectionRange(a, b) { el.selection = [a, b]; },
    ...props,
  };
  delete el.attrs;
  return el;
}

const rootOf = (fields) => ({ querySelectorAll: () => fields });

function enter(target, extra = {}) {
  const e = {
    key: 'Enter',
    target,
    keyCode: 13,
    prevented: false,
    preventDefault() { e.prevented = true; },
    ...extra,
  };
  return e;
}

const ROW = (over = {}) => ({ key: 'Enter', tag: 'input', type: 'text', index: 0, count: 2, hasSubmit: false, inForm: false, ...over });

// ── the rule ───────────────────────────────────────────────────────────

test('returnStep: Return in a field with one after it moves on; the last submits, lets a form submit itself, or blurs', () => {
  const { returnStep } = lib();
  assert.equal(returnStep(ROW()), 'next');
  assert.equal(returnStep(ROW({ index: 1, count: 3 })), 'next');
  assert.equal(returnStep(ROW({ index: 1, hasSubmit: true })), 'submit');
  assert.equal(returnStep(ROW({ index: 1, inForm: true })), 'native', 'a real form submits itself, as it always did');
  assert.equal(returnStep(ROW({ index: 1, hasSubmit: true, inForm: true })), 'submit', 'a given action wins over the form');
  assert.equal(returnStep(ROW({ index: 1 })), 'blur', 'no action and no form: the keyboard closes, as the gone check mark did');
  assert.equal(returnStep(ROW({ index: 0, count: 1, hasSubmit: true })), 'submit', 'a one-field step submits from its only field');
  // Shift+Return in a single-line field is still Return.
  assert.equal(returnStep(ROW({ shiftKey: true })), 'next');
  for (const type of ['email', 'password', 'search', 'tel', 'url', 'number', undefined]) {
    assert.equal(returnStep(ROW({ type })), 'next', `type=${type}`);
  }
});

test('returnStep: a textarea keeps Return as a new line unless its key says it moves on, and Shift+Return always is one', () => {
  const { returnStep } = lib();
  assert.equal(returnStep(ROW({ tag: 'textarea', type: undefined })), null, 'a bio or a description breaks lines');
  assert.equal(returnStep(ROW({ tag: 'textarea', index: 1, hasSubmit: true })), null, 'even as the last field');
  assert.equal(returnStep(ROW({ tag: 'textarea', hint: 'next' })), 'next', 'make.tsx\'s description opts in');
  assert.equal(returnStep(ROW({ tag: 'textarea', hint: 'NEXT' })), 'next');
  assert.equal(returnStep(ROW({ tag: 'textarea', hint: 'next', shiftKey: true })), null, 'Shift+Return is a new line');
  assert.equal(returnStep(ROW({ tag: 'textarea', hint: 'enter' })), null);
  assert.equal(returnStep(ROW({ tag: 'textarea', hint: 'send', index: 1, hasSubmit: true })), 'submit');
  assert.equal(returnStep(ROW({ tag: 'textarea', hint: 'done', index: 1, inForm: true })), 'blur',
    'a form cannot submit itself from a textarea, so the opted-in last one blurs');
});

test('returnStep: a Return that belongs to something else is left alone', () => {
  const { returnStep } = lib();
  assert.equal(returnStep(ROW({ key: 'a' })), null);
  assert.equal(returnStep(ROW({ key: 'Tab' })), null);
  assert.equal(returnStep(ROW({ isComposing: true })), null, 'an IME composition is being committed');
  assert.equal(returnStep(ROW({ keyCode: 229 })), null, 'WebKit\'s composition-ending Enter');
  assert.equal(returnStep(ROW({ metaKey: true })), null, '⌘+Enter submits where a form has it');
  assert.equal(returnStep(ROW({ ctrlKey: true })), null);
  assert.equal(returnStep(ROW({ altKey: true })), null);
  assert.equal(returnStep(ROW({ defaultPrevented: true })), null, 'a handler took it first');
  assert.equal(returnStep(ROW({ expanded: true })), null, 'a combobox list is open: Enter picks from it');
  assert.equal(returnStep(ROW({ index: -1 })), null, 'not one of this container\'s fields');
  for (const type of ['checkbox', 'radio', 'button', 'submit', 'file', 'range', 'color', 'hidden']) {
    assert.equal(returnStep(ROW({ type })), null, `type=${type}`);
  }
  assert.equal(returnStep(ROW({ tag: 'select', type: undefined })), null, 'a select keeps its own Enter');
});

test('returnFields: steps over what cannot take focus, and lands on a select', () => {
  const { returnFields, isReturnField } = lib();
  const name = field('input');
  const disabled = field('input', { disabled: true });
  const readOnly = field('input', { readOnly: true });
  const untabbable = field('input', { tabIndex: -1 });
  const folded = field('input', { getClientRects: () => [] });
  const hiddenAncestor = field('input', { closest: (sel) => (/\[hidden\]/.test(sel) ? {} : null) });
  const checkbox = field('input', { type: 'checkbox' });
  const file = field('input', { type: 'file' });
  const picker = field('select');
  const bio = field('textarea');
  const fields = returnFields(rootOf([name, disabled, readOnly, untabbable, folded, hiddenAncestor, checkbox, file, picker, bio]));
  assert.deepEqual(fields, [name, picker, bio]);
  assert.equal(isReturnField(null), false);
  assert.deepEqual(returnFields(null), []);
});

// ── doing it ───────────────────────────────────────────────────────────

test('handleReturnKey: next focuses the following field with the caret after its text, and takes the key', () => {
  const { handleReturnKey } = lib();
  const name = field('input', { value: 'Evan' });
  const bio = field('textarea', { value: 'Runs on Sundays' });
  const e = enter(name);
  assert.equal(handleReturnKey(e, rootOf([name, bio])), 'next');
  assert.equal(e.prevented, true, 'no implicit submission from the first field');
  assert.equal(bio.focused, true);
  assert.deepEqual(bio.selection, [15, 15]);
  // Return in the bio is a new line: untouched.
  const nl = enter(bio);
  assert.equal(handleReturnKey(nl, rootOf([name, bio])), null);
  assert.equal(nl.prevented, false);
});

test('handleReturnKey: skips a hidden field on the way, and a field that refuses a caret still gets focus', () => {
  const { handleReturnKey } = lib();
  const current = field('input', { type: 'password', getClientRects: () => [] });
  const next = field('input', { type: 'password' });
  const email = field('input', {
    type: 'email',
    value: 'a@b.c',
    setSelectionRange() { throw new Error('InvalidStateError'); },
  });
  const confirm = field('input', { type: 'password' });
  assert.equal(handleReturnKey(enter(next), rootOf([current, next, email, confirm])), 'next');
  assert.equal(email.focused, true);
  assert.equal(current.focused, false);
});

test('handleReturnKey: the last field runs the action, lets a form submit itself, or blurs', () => {
  const { handleReturnKey } = lib();
  const a = field('input');
  const b = field('input');
  let sent = 0;
  const submit = enter(b);
  assert.equal(handleReturnKey(submit, rootOf([a, b]), { submit: () => { sent += 1; } }), 'submit');
  assert.equal(sent, 1);
  assert.equal(submit.prevented, true);

  const inForm = field('input', { form: {} });
  const native = enter(inForm);
  assert.equal(handleReturnKey(native, rootOf([a, inForm])), 'native');
  assert.equal(native.prevented, false, 'the browser\'s implicit submission runs, disabled button and validation included');

  const blur = enter(b);
  assert.equal(handleReturnKey(blur, rootOf([a, b])), 'blur');
  assert.equal(b.blurred, true);
  assert.equal(blur.prevented, true);
});

test('handleReturnKey: React\'s event shape, IME and an earlier handler', () => {
  const { handleReturnKey } = lib();
  const a = field('input');
  const b = field('input');
  const root = rootOf([a, b]);
  // React: isComposing lives on the native event.
  const composing = enter(a, { nativeEvent: { isComposing: true } });
  assert.equal(handleReturnKey(composing, root), null);
  assert.equal(b.focused, false);
  assert.equal(handleReturnKey(enter(a, { keyCode: 229 }), root), null);
  // React: a handler nearer the field prevented it (the inner of two containers).
  assert.equal(handleReturnKey(enter(a, { isDefaultPrevented: () => true }), root), null);
  assert.equal(handleReturnKey(enter(a, { nativeEvent: { defaultPrevented: true } }), root), null);
  assert.equal(b.focused, false);
  // Root defaults to currentTarget, which is what returnKeyHandler passes.
  assert.equal(handleReturnKey(enter(a, { currentTarget: root })), 'next');
  assert.equal(b.focused, true);
  // A combobox with its list open.
  const combo = field('input', { attrs: { 'aria-expanded': 'true' } });
  assert.equal(handleReturnKey(enter(combo), rootOf([combo, b])), null);
  // A textarea whose key says next moves on; Shift+Return there is a new line.
  const brief = field('textarea', { attrs: { enterkeyhint: 'next' } });
  const c = field('input');
  assert.equal(handleReturnKey(enter(brief, { shiftKey: true }), rootOf([brief, c])), null);
  assert.equal(handleReturnKey(enter(brief), rootOf([brief, c])), 'next');
  assert.equal(c.focused, true);
  // The property spelling works too.
  const brief2 = field('textarea', { enterKeyHint: 'next' });
  const d = field('input');
  assert.equal(handleReturnKey(enter(brief2), rootOf([brief2, d])), 'next');
});

test('returnKeyHandler and attachReturnKey use the container as the root; pressButton presses only what a tap could', () => {
  const { returnKeyHandler, attachReturnKey, pressButton } = lib();
  const a = field('input');
  const b = field('input');
  let sent = 0;
  const onKeyDown = returnKeyHandler({ submit: () => { sent += 1; } });
  onKeyDown(enter(b, { currentTarget: rootOf([a, b]) }));
  assert.equal(sent, 1);

  const listeners = [];
  const root = {
    ...rootOf([a, b]),
    addEventListener: (type, fn) => listeners.push([type, fn]),
    removeEventListener: (type, fn) => {
      const i = listeners.findIndex(([t, f]) => t === type && f === fn);
      if (i >= 0) listeners.splice(i, 1);
    },
  };
  const detach = attachReturnKey(root, { submit: () => { sent += 1; } });
  assert.equal(listeners.length, 1);
  assert.equal(listeners[0][0], 'keydown');
  listeners[0][1](enter(b));
  assert.equal(sent, 2);
  detach();
  assert.equal(listeners.length, 0);
  assert.equal(typeof attachReturnKey(null), 'function', 'nothing to attach to is a no-op');

  let clicks = 0;
  const button = (over) => ({ disabled: false, getClientRects: () => [{}], click() { clicks += 1; }, ...over });
  assert.equal(pressButton(button()), true);
  assert.equal(pressButton(button({ disabled: true })), false, 'a disabled button (in flight, or blocked) is not pressed');
  assert.equal(pressButton(button({ getClientRects: () => [] })), false, 'nor one that is hidden');
  assert.equal(pressButton(null), false);
  assert.equal(clicks, 1);
});

// ── the forms ──────────────────────────────────────────────────────────

/** Each field's id and enterKeyHint, in document order. */
function hints(html) {
  return [...html.matchAll(/<(?:input|textarea)\b[^>]*>/gi)]
    .map((m) => m[0])
    .filter((tag) => !/type="(?:file|checkbox)"/.test(tag))
    .map((tag) => {
      const id = /\bid="([^"]+)"/.exec(tag);
      const hint = /\benterkeyhint="([^"]+)"/i.exec(tag);
      return [id ? id[1] : '?', hint ? hint[1] : null];
    });
}

const SHOWN = { '../../lib/mount-on-reveal': { useMountedOnReveal: () => true } };

test('sign-in: the password form, every code step and both recovery paths say what Return does and do it', () => {
  const { LoginScreen } = loadTsx('frontend/src/features/auth/login.tsx', { stubs: SHOWN });
  assert.deepEqual(hints(renderToHtml(createElement(LoginScreen))), [
    ['login-username', 'next'],
    ['login-password', 'go'],
    ['otp-email', 'send'],
    ['otp-code', 'go'],
    ['otp-new-password', 'next'],
    ['otp-confirm-password', 'go'],
    ['recovery-new-password', 'next'],
    ['recovery-confirm-password', 'go'],
  ]);
  const src = read('frontend/src/features/auth/login.tsx');
  assert.match(src, /import \{ returnKeyHandler \} from '\.\.\/\.\.\/lib\/return-to-next';/);
  // Real forms submit themselves from the last field…
  assert.match(src, /id="login-form"[\s\S]{0,120}onSubmit=\{onLoginSubmit\}\s+onKeyDown=\{returnKeyHandler\(\)\}/);
  assert.match(src, /void onResetConfirm\(\);\s+\}\}\s+onKeyDown=\{returnKeyHandler\(\)\}/);
  // …and the steps that are not forms run their own button's action.
  assert.match(src, /id="otp-step-email"[\s\S]{0,160}returnKeyHandler\(\{ submit: \(\) => \{ if \(!cooldownLeft\) void otpRequestCode\(\); \} \}\)/);
  assert.match(src, /id="otp-step-code"[\s\S]{0,160}returnKeyHandler\(\{ submit: \(\) => \{ void onOtpVerify\(\); \} \}\)/);
  assert.match(src, /id="otp-step-password"[\s\S]{0,160}returnKeyHandler\(\{ submit: \(\) => \{ void onOtpSetPassword\(\); \} \}\)/);
  assert.match(src, /id="recovery-wallet"[\s\S]{0,200}returnKeyHandler\(\{ submit: \(\) => \{ void onWalletReset\(\); \} \}\)/);
  assert.match(src, /id="recovery-email"[\s\S]{0,200}returnKeyHandler\(\{ submit: \(\) => \{ if \(busy !== 'btn-email-reset'\) void onEmailReset\(\); \} \}\)/);
  // The fields drawn only on demand say it too.
  assert.match(src, /id="otp-username"[\s\S]{0,200}enterKeyHint="next"/);
  assert.match(src, /id="recovery-email-input"[\s\S]{0,120}enterKeyHint="send"/);
  assert.match(src, /id="reset-new-password"[\s\S]{0,80}enterKeyHint="next"/);
  assert.match(src, /id="reset-confirm-password"[\s\S]{0,80}enterKeyHint="go"/);
});

test('register: code, username, password, then Register', () => {
  const mod = loadTsx('frontend/src/features/auth/register.tsx', { stubs: SHOWN });
  const Screen = Object.values(mod).find((v) => typeof v === 'function' && /Register/.test(v.name));
  assert.deepEqual(hints(renderToHtml(createElement(Screen))), [
    ['reg-code', 'next'], ['reg-username', 'next'], ['reg-password', 'go'],
  ]);
  assert.match(read('frontend/src/features/auth/register.tsx'),
    /<form id="register-form" className="space-y-4" onSubmit=\{onSubmit\} onKeyDown=\{returnKeyHandler\(\)\}>/);
});

test('Change password: current, new, confirm, and confirm presses whichever submit is showing', () => {
  const html = renderComponent('frontend/src/features/settings/sections/password.tsx', 'PasswordSection');
  assert.deepEqual(hints(html), [['cp-current', 'next'], ['cp-new', 'next'], ['cp-confirm', 'done']]);
  const src = read('frontend/src/features/settings/sections/password.tsx');
  assert.match(src, /<div id="change-password-section" onKeyDown=\{returnKeyHandler\(\{ submit: submitShown \}\)\}>/);
  assert.match(src, /if \(!pressButton\(document\.getElementById\('cp-save'\)\)\) pressButton\(document\.getElementById\('cp-wallet-save'\)\);/);
});

test('Edit profile: Return in the name goes on to the bio, where it is a new line', () => {
  const Profile = {
    _user: () => ({ username: 'evan', displayName: 'Evan', bio: '', links: {} }),
    _dismissSheet: () => {}, MAX_DISPLAY_NAME: 40, MAX_BIO: 280, takeDraft: () => null,
  };
  const mod = loadTsx('frontend/src/features/profile/profile-edit-sheet.tsx', { stubs: { './profile.js': { Profile } } });
  const html = renderToHtml(createElement(mod.ProfileEditSheet, { avatarUrl: null, initial: 'E' }));
  assert.deepEqual(hints(html), [
    ['profile-edit-name', 'next'],
    ['profile-edit-bio', null],
    ['profile-edit-username', null],
  ]);
  assert.match(read('frontend/src/features/profile/profile-edit-sheet.tsx'),
    /<div id="profile-edit-sheet" ref=\{panelRef\} className=\{CARD_CLASS\} inert=\{cropping\} onKeyDown=\{returnKeyHandler\(\)\}>/);
});

test('Suggest an improvement: Return in the title goes on to the description; ⌘/Ctrl+Enter still posts', () => {
  const mod = loadTsx('frontend/src/features/dialogs/feedback.tsx', {
    stubs: { './feedback-controller': { Feedback: {}, init() {} } },
  });
  const html = renderToHtml(createElement(mod.FeedbackDialog));
  assert.deepEqual(hints(html), [['feedback-title', 'next'], ['feedback-text', null]]);
  assert.match(read('frontend/src/features/dialogs/feedback.tsx'), /<div id="feedback-form" onKeyDown=\{returnKeyHandler\(\)\}>/);
  const controller = read('frontend/src/features/dialogs/feedback-controller.js');
  assert.match(controller, /feedbackTitle\.addEventListener\('keydown', \(e\) => \{\s+if \(e\.key === 'Enter' && \(e\.metaKey \|\| e\.ctrlKey\)\)/);
  assert.match(controller, /feedbackText\.addEventListener\('keydown', \(e\) => \{\s+if \(e\.key === 'Enter' && \(e\.metaKey \|\| e\.ctrlKey\)\)/);
});

test('the secrets editor: Return walks the five fields and the last presses the submit, only while it can be pressed', () => {
  const { Secrets } = loadTsx('frontend/src/features/dialogs/app-secrets-controller.js');
  const saved = { document: globalThis.document, App: globalThis.App };
  try {
    for (const scope of ['app', 'platform']) {
      const listeners = [];
      const fields = [field('input'), field('input'), field('input'), field('input'), field('input')];
      const first = { addEventListener: (type, fn) => listeners.push([type, fn]), querySelectorAll: () => fields };
      const host = { classList: { remove() {} }, innerHTML: '', firstElementChild: first };
      let pressed = 0;
      const submit = { disabled: false, getClientRects: () => [{}], click() { pressed += 1; }, addEventListener() {} };
      globalThis.document = {
        getElementById: (id) => (id === 'app-secrets-declare' ? host : id === 'app-secrets-declare-submit' ? submit : null),
      };
      globalThis.App = { user: { canAdminWrite: true } };
      Secrets.declareOpen = true;
      Secrets.renderDeclareSection({ scope, secrets: [] });
      const last = scope === 'platform' ? 'decl-group' : 'decl-staging-default';
      assert.deepEqual(hints(host.innerHTML), [
        ['decl-key', 'next'], ['decl-description', 'next'], ['decl-value', 'next'], ['decl-default', 'next'], [last, 'done'],
      ], scope);
      const keydowns = listeners.filter(([type]) => type === 'keydown');
      assert.equal(keydowns.length, 1, 'one listener, on the node this render wrote');
      const onKey = keydowns[0][1];
      onKey(enter(fields[0]));
      assert.equal(fields[1].focused, true, 'key goes on to description');
      onKey(enter(fields[4]));
      assert.equal(pressed, 1, 'the last field presses the submit');
      submit.disabled = true;
      onKey(enter(fields[4]));
      assert.equal(pressed, 1, 'not while it is disabled (in flight, or blocked)');
    }
  } finally {
    globalThis.document = saved.document;
    globalThis.App = saved.App;
    if (saved.document === undefined) delete globalThis.document;
    if (saved.App === undefined) delete globalThis.App;
  }
});

test('agent files: name, then the description when a skill has one, then Save; the name\'s key follows the kind', () => {
  const html = renderComponent('frontend/src/features/settings/sections/agent-files.tsx', 'AgentFilesSection');
  assert.deepEqual(hints(html), [['agent-files-name', 'next'], ['agent-files-desc', 'done']]);
  const src = read('frontend/src/features/settings/sections/agent-files.tsx');
  assert.match(src, /id="agent-files-form"[\s\S]{0,200}onKeyDown=\{returnKeyHandler\(\{ submit: saveAgentFile \}\)\}/);
  assert.match(src, /pressButton\(document\.getElementById\('agent-files-save'\)\);/);
  assert.match(read('frontend/src/features/settings/settings.js'),
    /descWrap\.classList\.toggle\('hidden', kind !== 'skill'\);[\s\S]{0,200}nameInput\.enterKeyHint = kind === 'skill' \? 'next' : 'done';/);
});

test('OpenRouter: Return in the key tests and saves it; in the filter it goes on to the model list', () => {
  const html = renderComponent('frontend/src/features/settings/sections/openrouter.tsx', 'OpenRouterSection');
  assert.deepEqual(hints(html), [['settings-openrouter-key', 'done'], ['settings-openrouter-model-search', 'next']]);
  const src = read('frontend/src/features/settings/sections/openrouter.tsx');
  assert.match(src, /<div id="settings-openrouter-personal-controls" onKeyDown=\{returnKeyHandler\(\{ submit: saveKey \}\)\}>/);
  assert.match(src, /pressButton\(document\.getElementById\('settings-openrouter-save'\)\);/);
  assert.match(src, /<div id="settings-openrouter-models-wrap" className="hidden mt-4" onKeyDown=\{returnKeyHandler\(\)\}>/);
});

test('wallet Send: the address goes on to the amount, and the amount sends', () => {
  const src = read('frontend/src/features/header/wallet-sheet-body.tsx');
  const form = src.slice(src.indexOf('function SendForm('), src.indexOf('// ── the body'));
  assert.match(form, /onKeyDown=\{returnKeyHandler\(\{ submit: \(\) => \{ if \(!sending\) void submit\(\); \} \}\)\}/);
  assert.match(form, /aria-label="Recipient address"[\s\S]{0,80}enterKeyHint="next"/);
  assert.match(form, /aria-label="Amount" inputMode="numeric" enterKeyHint="send"/);
});

test('Email & recovery: the address goes on to the password when one is asked for; the last field sends', () => {
  const src = read('frontend/src/features/settings/sections/email.tsx');
  assert.match(src, /onSubmit=\{\(event\) => \{ event\.preventDefault\(\); void submit\(!!pending\); \}\}\s+onKeyDown=\{returnKeyHandler\(\)\}>/);
  assert.match(src, /id="account-email-code"[\s\S]{0,160}enterKeyHint="go"/);
  assert.match(src, /id="account-email-address"[\s\S]{0,120}enterKeyHint=\{account\.passwordRequired \? 'next' : 'send'\}/);
  assert.match(src, /id="account-email-password" autoComplete="current-password" enterKeyHint="send"/);
});

test('create a project: Return in what it should do goes on to the name, and the name makes it; an import checks, then names', () => {
  // The create dialog is retired; Create opens the make screen
  // (features/first-session/make.tsx), whose two fields are one sequence.
  const src = read('frontend/src/features/first-session/make.tsx');
  assert.match(src, /id="first-session-brief"[\s\S]{0,200}enterKeyHint="next"/);
  assert.match(src, /if \(e\.key !== 'Enter' \|\| e\.shiftKey \|\| e\.nativeEvent\.isComposing\) return;\s+e\.preventDefault\(\);\s+nameRef\.current\?\.focus\(\{ preventScroll: true \}\);/,
    'Return goes on to the name; Shift+Return is a new line');
  assert.match(src, /id="first-session-name"[\s\S]{0,120}enterKeyHint="go"/);
  // The import form: Return in the URL checks it, and once checked goes on to the name, which imports it.
  const imp = read('frontend/src/features/first-session/import-repo.tsx');
  assert.match(imp, /if \(state === 'ok'\) nameRef\.current\?\.focus\(\{ preventScroll: true \}\);\s+else void check\(\);/);
  assert.match(imp, /id="make-import-name"[\s\S]{0,120}enterKeyHint="go"/);
});

test('admin sign-in providers: Return walks the single-line fields; the key and the client IDs keep their new lines', () => {
  const { ProviderCard } = loadTsx('frontend/src/features/admin/admin-sign-in.tsx');
  const view = (provider) => ({
    provider, label: provider, enabled: false, complete: false, offered: false, nativeOffered: false, missing: [],
    clientId: null, teamId: null, keyId: null, appClientIds: [], secretSaved: false, secretUnreadable: false,
    callbackUrl: null, updatedAt: null, updatedBy: null,
  });
  const card = (provider) => hints(renderToHtml(createElement(ProviderCard, { view: view(provider), canWrite: true, onSaved() {} })));
  assert.deepEqual(card('google'), [
    ['admin-sign-in-google-client-id', 'next'],
    ['admin-sign-in-google-secret', 'next'],
    ['admin-sign-in-google-app-client-ids', null],
  ]);
  assert.deepEqual(card('apple'), [
    ['admin-sign-in-apple-client-id', 'next'],
    ['admin-sign-in-apple-team-id', 'next'],
    ['admin-sign-in-apple-key-id', 'next'],
    ['admin-sign-in-apple-secret', null],
    ['admin-sign-in-apple-app-client-ids', null],
  ]);
  const src = read('frontend/src/features/admin/admin-sign-in.tsx');
  assert.match(src, /<div className="space-y-4" onKeyDown=\{returnKeyHandler\(\)\}>/);
  // The console's own rule: nothing from the shell's primitives.
  assert.doesNotMatch(src, /@\/components\/ui\//);
});
