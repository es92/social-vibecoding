'use strict';

// #5104: Settings › Privacy: "Who can message or invite me" and "Let people
// find my profile".
//
// What this pins about the pane (frontend/src/features/settings/sections/
// privacy.tsx), the registry row that offers it and the words the shell
// says when the server refuses:
//
//   - it is a part of the Account group, at #settings/contact-privacy, with
//     its own keywords, and its wrapper ships hidden like every part;
//   - the prerendered markup carries no choice: neither radio is checked and
//     the switch is off until the account's settings are read in an effect,
//     so hydration matches whatever the account says;
//   - it reads and writes GET/POST /api/me/contact-privacy, the route the
//     server rules sit behind;
//   - a refusal (code contact_restricted) is said in the screen's own words
//     on Messages, Friends and the Members dialog.
//
// The server side of both settings is pinned by
// tests/contact-privacy-postgres.test.js.
//
// Run with: node --test tests/settings-privacy-pane.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const escape = (text) => text.replace(/&/g, '&amp;').replace(/'/g, '&#x27;').replace(/"/g, '&quot;');
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const PANE = read('frontend/src/features/settings/sections/privacy.tsx');
const SETTINGS = read('frontend/src/features/settings/settings.js');
const AUTH = read('src/routes/auth.js');

test('Privacy is a part of the Account group with its own address and keywords', () => {
  assert.match(
    SETTINGS,
    /\{ key: 'contact-privacy', label: 'settings:nav\.part\.contactPrivacy', group: 'settings:nav\.group\.account' \}/
  );
  assert.match(SETTINGS, /'contact-privacy': 'settings:nav\.keywords\.contactPrivacy'/);
  assert.equal(message('settings:nav.part.contactPrivacy'), 'Privacy');
  assert.match(message('settings:nav.keywords.contactPrivacy'), /\bprivacy\b.*\bmessage\b/);
});

test('the prerendered pane is hidden and carries no choice', () => {
  const { PrivacySection } = loadTsx('frontend/src/features/settings/sections/privacy.tsx');
  const html = renderToHtml(createElement(PrivacySection, {}));
  assert.match(html, /^<div data-settings-section="contact-privacy" class="hidden">/);
  assert.match(html, /id="settings-who-can-message"/);
  assert.match(html, /id="settings-profile-discoverable"/);
  assert.doesNotMatch(html, /checked/, 'nothing is chosen before the account is read');
  assert.ok(html.includes(escape(message('settings:privacy.whoCanMessage.shared'))));
  assert.ok(html.includes(escape(message('settings:privacy.whoCanMessage.anyone'))));
  assert.ok(html.includes(escape(message('settings:privacy.discoverable.label'))));
  assert.equal(message('settings:privacy.whoCanMessage.shared'), "People in projects I'm in");
  assert.equal(message('settings:privacy.discoverable.label'), 'Let people find my profile');
});

test('the line under each choice says what is true now (#5926)', () => {
  const { PrivacySection } = loadTsx('frontend/src/features/settings/sections/privacy.tsx');
  const html = renderToHtml(createElement(PrivacySection, {}));
  // The switch is off until the account is read, and its line says so.
  assert.ok(html.includes(escape(message('settings:privacy.discoverable.descriptionOff'))));
  assert.ok(!html.includes(escape(message('settings:privacy.discoverable.descriptionOn'))));
  assert.match(PANE, /settings\?\.discoverable\s*\?\s*'settings:privacy\.discoverable\.descriptionOn'\s*:\s*'settings:privacy\.discoverable\.descriptionOff'/);
  assert.match(message('settings:privacy.discoverable.descriptionOn'), /^Anyone on Homeroom can find your username/);
  assert.doesNotMatch(message('settings:privacy.discoverable.descriptionOff'), /When this is off/);
  // "Anyone" says what it means in practice.
  assert.match(message('settings:privacy.whoCanMessage.anyoneDescription'), /people you don't know/);
});

test('finding your profile is its own section, not part of messaging (#5926 item 6)', () => {
  const { PrivacySection } = loadTsx('frontend/src/features/settings/sections/privacy.tsx');
  const html = renderToHtml(createElement(PrivacySection, {}));
  const headings = [...html.matchAll(/<h3[^>]*>([^<]*)<\/h3>/g)].map((m) => m[1]);
  assert.deepEqual(headings, [
    escape(message('settings:privacy.whoCanMessage.title')),
    escape(message('settings:privacy.discoverable.title')),
    escape(message('settings:privacy.contact.title')),
    escape(message('settings:privacy.usageAnalytics.title')),
  ], 'four sections: messaging, finding, email & texts (#6044), usage data');
  assert.equal(message('settings:privacy.discoverable.title'), 'Who can find me');
  // The switch sits under its own heading, after the messaging radios.
  const findAt = html.indexOf(escape(message('settings:privacy.discoverable.title')));
  assert.ok(findAt > html.indexOf('id="settings-who-can-message"'));
  assert.ok(findAt < html.indexOf('id="settings-profile-discoverable"'));
  assert.ok(html.includes(escape(message('settings:privacy.discoverable.intro'))));
});

test('the pane reads and writes the route the rules sit behind', () => {
  assert.match(PANE, /const ENDPOINT = '\/api\/me\/contact-privacy';/);
  assert.match(PANE, /method: 'POST'/);
  assert.match(PANE, /useEffect\(\(\) => \{ void load\(\); \}, \[load\]\);/, 'read in an effect, never during render');
  assert.match(AUTH, /router\.get\('\/api\/me\/contact-privacy'/);
  assert.match(AUTH, /router\.post\('\/api\/me\/contact-privacy', sameOriginBrowserOnly/);
});

test('a refusal is said in the screen\'s own words', () => {
  const messagesApi = read('frontend/src/features/messages/api.ts');
  const friendsApi = read('frontend/src/features/friends/api.ts');
  const members = read('frontend/src/features/dialogs/members-controller.js');
  assert.match(messagesApi, /pick\(body, 'code'\) === 'contact_restricted'[\s\S]{0,200}t\('messages:api\.contactRestricted'\)/);
  assert.match(friendsApi, /body\.code === 'contact_restricted'[\s\S]{0,80}t\('messages:api\.contactRestricted'\)/);
  assert.match(members, /data\.code === 'contact_restricted'[\s\S]{0,120}'dialogs:members\.invite\.contactRestricted'/);
  for (const id of ['messages:api.contactRestricted', 'dialogs:members.invite.contactRestricted']) {
    const text = message(id);
    assert.match(text, /invite link/, `${id} says what to do instead`);
    assert.doesNotMatch(text, /block/i, `${id} says nothing about blocking`);
  }
});

// #5926 items 1 and 2: helper text you can read on the dark card, and
// switches whose state is said in words as well as colour.
test('helper text is 13px in rem and lighter in the dark theme (#5926)', () => {
  const { HELP } = loadTsx('frontend/src/features/settings/sections/privacy-text.tsx');
  // rem, so Settings › Accessibility's text size scales it.
  assert.match(HELP, /\btext-\[0\.8125rem\]/);
  assert.doesNotMatch(HELP, /px\]/);
  assert.match(HELP, /\bdark:text-zinc-400\b/);
  assert.match(HELP, /\bmax-w-\[65ch\]/);
  const { PrivacySection } = loadTsx('frontend/src/features/settings/sections/privacy.tsx');
  const html = renderToHtml(createElement(PrivacySection, {}));
  assert.doesNotMatch(html, /dark:text-zinc-500/, 'no line on the page keeps the dim dark-theme ink');
  // The headings' blurbs keep SectionHeading's size; only their dark ink is
  // lifted. Every other small line wears the shared helper style.
  assert.doesNotMatch(html, /class="(?![^"]*\bmb-3\b)[^"]*\btext-xs text-zinc-500/, 'no helper line keeps the 12px size');
  const count = html.split(HELP).length - 1;
  // Usage data adds one: what is kept, recorded and never recorded, and
  // where to write to be left out. It has no switch. The three switches'
  // lines are their rows' second lines since the switches became the shared
  // ListRow: the row's own size, in rem as this rule asks, and its dark ink.
  assert.equal(count, 3, `both choices and what usage data keeps wear the helper style, found ${count}`);
});

test('both switches are announced as switches and say Off before the account is read (#5926)', () => {
  const { PrivacySection } = loadTsx('frontend/src/features/settings/sections/privacy.tsx');
  const html = renderToHtml(createElement(PrivacySection, {}));
  for (const id of ['settings-profile-discoverable', 'settings-contact-marketing-email', 'settings-contact-activity-email']) {
    const input = html.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`));
    assert.ok(input, `#${id} is rendered`);
    assert.match(input[0], /role="switch"/, `#${id} is announced as a switch`);
    assert.match(input[0], /class="un-switch"/);
    assert.doesNotMatch(input[0], /checked/);
  }
  // In the row's semibold title, so the word says its normal weight itself.
  const off = `<span aria-hidden="true" class="ms-2 text-[0.8125rem] font-normal text-zinc-500 dark:text-zinc-400">${message('settings:privacy.state.off')}</span>`;
  assert.equal(html.split(off).length - 1, 3, 'every switch, the two Email & texts ones (#6044) too');
  assert.ok(!html.includes(`>${message('settings:privacy.state.on')}</span>`));
  assert.doesNotMatch(html, /id="settings-usage-analytics"/, 'usage data has no switch');
});

test('a switch that is on is checked and says On (#5926)', () => {
  const { PrivacySwitch } = loadTsx('frontend/src/features/settings/sections/privacy-text.tsx');
  const render = (checked) => renderToHtml(createElement(PrivacySwitch, {
    id: 'settings-profile-discoverable',
    label: message('settings:privacy.discoverable.label'),
    checked,
    disabled: false,
    onChange: () => {},
  }));
  const on = render(true);
  const input = on.match(/<input[^>]*>/)[0];
  assert.match(input, /role="switch"/);
  assert.match(input, /checked=""/);
  assert.match(on, new RegExp(`<span aria-hidden="true"[^>]*>${message('settings:privacy.state.on')}</span>`));
  assert.ok(!on.includes(`>${message('settings:privacy.state.off')}</span>`));
  const off = render(false);
  assert.doesNotMatch(off.match(/<input[^>]*>/)[0], /checked/);
  assert.match(off, new RegExp(`<span aria-hidden="true"[^>]*>${message('settings:privacy.state.off')}</span>`));
  assert.ok(on.includes(escape(message('settings:privacy.discoverable.label'))));
  assert.equal(message('settings:privacy.state.on'), 'On');
  assert.equal(message('settings:privacy.state.off'), 'Off');
});

// #5926 item 8: the radios show keyboard focus, a save that worked says so,
// and a switch's whole row toggles it.
test('a radio shows keyboard focus on the mark drawn beside it (#5926 item 8)', () => {
  const { PrivacySection } = loadTsx('frontend/src/features/settings/sections/privacy.tsx');
  const html = renderToHtml(createElement(PrivacySection, {}));
  const radios = [...html.matchAll(/<input[^>]*type="radio"[^>]*>(<span[^>]*>)/g)];
  assert.equal(radios.length, 2);
  for (const [whole, mark] of radios) {
    assert.match(whole, /class="peer sr-only"/, 'the hidden input is the peer');
    assert.match(mark, /peer-focus-visible:outline-\[color:var\(--accent\)\]/);
    assert.match(mark, /peer-focus-visible:outline-offset-2/);
  }
  // The chosen radio is drawn by the other branch, which a prerender never reaches.
  assert.equal(PANE.split('${RADIO_FOCUS}').length - 1, 2, 'both of Radio\'s branches wear it');
});

test('every switch\'s description is inside its label and describes it (#5926 item 8)', () => {
  const { PrivacySection } = loadTsx('frontend/src/features/settings/sections/privacy.tsx');
  const html = renderToHtml(createElement(PrivacySection, {}));
  const described = {
    'settings-profile-discoverable': 'settings-profile-discoverable-description',
    'settings-contact-marketing-email': 'settings-contact-marketing-email-help',
    'settings-contact-activity-email': 'settings-contact-activity-email-help',
  };
  const labels = [...html.matchAll(/<label[^>]*>.*?<\/label>/g)].map((m) => m[0]);
  for (const [id, descriptionId] of Object.entries(described)) {
    const label = labels.find((text) => text.includes(`id="${id}"`));
    assert.ok(label, `#${id} is in a label`);
    assert.ok(label.includes(`id="${descriptionId}"`), `#${descriptionId} is inside that label`);
    assert.ok(label.includes(`aria-describedby="${descriptionId}"`));
    assert.doesNotMatch(label, /<(p|div)\b/, 'a label holds spans');
  }
});

test('the switch\'s name stays its label when the description joins the label (#5926 item 8)', () => {
  const { PrivacySwitch } = loadTsx('frontend/src/features/settings/sections/privacy-text.tsx');
  const html = renderToHtml(createElement(PrivacySwitch, {
    id: 's', label: 'Name', checked: false, disabled: false, onChange: () => {},
    describedBy: 's-help', description: 'Longer words',
  }));
  assert.match(html.match(/<input[^>]*>/)[0], /aria-label="Name"/);
  // The description is the shared row's second line (its classes are the
  // row's), wrapped in the span that carries its id.
  assert.match(html, /<span id="s-help">Longer words<\/span>/);
  const bare = renderToHtml(createElement(PrivacySwitch, {
    id: 's', label: 'Name', checked: false, disabled: false, onChange: () => {},
  }));
  assert.doesNotMatch(bare, /aria-describedby/, 'no description, nothing points at one');
});

test('the status lines are there, empty, before anything is saved (#5926 item 8)', () => {
  const { PrivacySection } = loadTsx('frontend/src/features/settings/sections/privacy.tsx');
  const html = renderToHtml(createElement(PrivacySection, {}));
  assert.ok(html.includes('<p id="settings-contact-privacy-status" role="status"></p>'));
  assert.equal(html.split('<p role="status"></p>').length - 1, 1, 'Email & texts; usage data saves nothing');
  assert.ok(!html.includes(`>${message('settings:privacy.saved')}<`));
  assert.equal(message('settings:privacy.saved'), 'Saved');

  const { SaveStatus } = loadTsx('frontend/src/features/settings/sections/privacy-text.tsx');
  const status = (props) => renderToHtml(createElement(SaveStatus, props));
  assert.match(status({ id: 'x', saved: true }), new RegExp(`^<p id="x" role="status" class="[^"]*">${message('settings:privacy.saved')}</p>$`));
  const failed = status({ saved: false, error: 'It broke' });
  assert.match(failed, /text-red-700/);
  assert.match(failed, />It broke</);
  assert.ok(!status({ saved: true, error: 'It broke' }).includes(message('settings:privacy.saved')), 'an error wins');
});

// ── The same modules run, effects and all, on a React stepped by hand ─────
function createSteppedReact() {
  const slots = [];
  let cursor = 0;
  let component = null;
  let dirty = false;
  let queued = [];
  const h = { tree: null, setCalls: 0 };
  const changed = (prev, next) => !prev || prev.some((value, i) => !Object.is(value, next[i]));
  const slot = (init) => {
    const i = cursor++;
    if (!(i in slots)) slots[i] = init();
    return slots[i];
  };
  h.React = {
    useRef: (current) => slot(() => ({ current })),
    useState(initial) {
      const s = slot(() => {
        const state = { value: initial };
        state.set = (next) => {
          h.setCalls += 1;
          if (!Object.is(next, state.value)) { state.value = next; dirty = true; }
        };
        return state;
      });
      return [s.value, s.set];
    },
    useCallback(fn, deps) {
      const s = slot(() => ({ fn, deps }));
      if (changed(s.deps, deps)) { s.fn = fn; s.deps = deps; }
      return s.fn;
    },
    useEffect(effect, deps) {
      const s = slot(() => ({ effect: true, deps: null, cleanup: null }));
      if (!changed(s.deps, deps)) return;
      s.deps = deps;
      queued.push(() => {
        if (s.cleanup) s.cleanup();
        s.cleanup = effect();
      });
    },
    forwardRef: (render) => render,
  };
  const paint = () => {
    cursor = 0;
    dirty = false;
    queued = [];
    h.tree = component({});
    for (const run of queued) run();
  };
  h.mount = (fn) => { component = fn; paint(); };
  h.settle = async () => {
    for (let i = 0; i < 6; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
      if (dirty) paint();
    }
  };
  h.unmount = () => {
    for (const s of slots) if (s && s.effect && s.cleanup) s.cleanup();
    component = () => null;
  };
  return h;
}

function loadStepped(entry) {
  const h = createSteppedReact();
  const t = (id) => id;
  const mod = loadTsx(entry, {
    stubs: {
      react: h.React,
      '../../../lib/i18n/react': { useMessages: () => t },
      '../../../lib/legacy-dom': { useWindowEvent: () => {} },
      '@/components/ui/field': { SectionHeading: () => null },
      '@/components/ui/switch': { Switch: () => null },
      // The usage data block's address (./usage-analytics.tsx): the default
      // until the options arrive, which these pages never wait for.
      '../../auth/waitlist-shared': { useWaitlistOptions: () => null },
    },
  });
  return { h, mod };
}

function findAll(node, wanted, out = []) {
  if (Array.isArray(node)) { for (const item of node) findAll(item, wanted, out); return out; }
  if (!node || typeof node !== 'object' || !node.props) return out;
  if (wanted(node)) out.push(node);
  findAll(node.props.children, wanted, out);
  return out;
}

const SECTIONS = [
  {
    name: 'Who can find me',
    entry: 'frontend/src/features/settings/sections/privacy.tsx',
    component: 'PrivacySection',
    control: 'settings-profile-discoverable',
    read: { whoCanContact: 'shared', discoverable: false },
    wrote: { whoCanContact: 'shared', discoverable: true },
  },
  {
    name: 'Email & texts',
    entry: 'frontend/src/features/settings/sections/contact-preferences.tsx',
    component: 'ContactPreferencesSection',
    control: 'settings-contact-activity-email',
    read: { activityEmail: false, email: true },
    wrote: { activityEmail: true, email: true },
  },
];

for (const section of SECTIONS) {
  test(`${section.name}: "Saved" follows a save that worked, for three seconds (#5926 item 8)`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const realFetch = globalThis.fetch;
    const realWindow = globalThis.window;
    t.after(() => { globalThis.fetch = realFetch; globalThis.window = realWindow; });
    globalThis.window = {};
    let refuse = false;
    globalThis.fetch = async (_url, options) => {
      const writing = options && options.method && options.method !== 'GET';
      if (writing && refuse) return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => (writing ? section.wrote : section.read) };
    };

    const { h, mod } = loadStepped(section.entry);
    h.mount(mod[section.component]);
    await h.settle();
    const status = () => findAll(h.tree, (el) => el.props.saved !== undefined)[0];
    const flip = () => findAll(h.tree, (el) => el.props.id === section.control)[0]
      .props.onChange({ currentTarget: { checked: true } });

    assert.equal(status().props.saved, false, 'nothing is said before a save');

    flip();
    await h.settle();
    assert.equal(status().props.saved, true);
    t.mock.timers.tick(2999);
    await h.settle();
    assert.equal(status().props.saved, true, 'still there just before three seconds');
    t.mock.timers.tick(1);
    await h.settle();
    assert.equal(status().props.saved, false, 'gone at three seconds');

    refuse = true;
    flip();
    await h.settle();
    assert.equal(status().props.saved, false, 'a refused save says no such thing');
  });
}

test('the Saved timer restarts on each save and stops with the page (#5926 item 8)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { h, mod } = loadStepped('frontend/src/features/settings/sections/privacy-text.tsx');
  h.mount(() => mod.useSavedFlash());

  h.tree.flash();
  await h.settle();
  t.mock.timers.tick(2000);
  h.tree.flash();
  await h.settle();
  t.mock.timers.tick(2000);
  await h.settle();
  assert.equal(h.tree.saved, true, 'the second save has its own three seconds');

  h.tree.clear();
  await h.settle();
  assert.equal(h.tree.saved, false, 'the next save takes it away at once');
  h.tree.flash();
  await h.settle();
  assert.equal(h.tree.saved, true, 'so the next Saved is a change to announce');

  const { flash } = h.tree;
  h.unmount();
  const before = h.setCalls;
  t.mock.timers.tick(5000);
  assert.equal(h.setCalls, before, 'leaving the page cleared the timer');
  flash();
  t.mock.timers.tick(5000);
  assert.equal(h.setCalls, before, 'a save that lands after leaving starts nothing');
});

test('the pane reads again only when its own page is opened (#6591)', () => {
  assert.match(
    PANE,
    /useWindowEvent\('usernode:settings-section', \(event\) => \{\s*if \(\(event as CustomEvent<\{ section\?: string \}>\)\.detail\?\.section === 'contact-privacy'\) void load\(\);\s*\}\);/,
    'another page of Settings opening does not re-read it hidden'
  );
});
