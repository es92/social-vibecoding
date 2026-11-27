// Settings and Profile in the brand's editorial voice (#7072): the standard
// look's block of app.css, "SETTINGS AND PROFILE, THE EDITORIAL PAGES". It
// holds the block's own rules:
//
//   1. Every rule is scoped to the standard look, so the brand look and the
//      frame's looks keep their own drawing of both pages.
//   2. Every colour is a token, declared once in the block's first rule and
//      given its dark value in the second.
//   3. Source Serif 4 ships its variable weight range; headings use 600.
//   4. Nothing is hidden but the page's head on a phone's open page, whose
//      name the top bar already says.
//
// It also holds the two things the block leans on in the markup: Settings'
// head and the hooks on the profile card.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (...parts) => fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8');
const css = read('public', 'css', 'app.css');
const SCOPE = 'html:root';

function block() {
  const start = css.indexOf('── SETTINGS AND PROFILE, THE EDITORIAL PAGES');
  const end = css.indexOf('END OF THE EDITORIAL PAGES.');
  assert.ok(start > 0 && end > start, 'app.css has the editorial block, start to end');
  assert.ok(start > css.indexOf('END OF STANDARD (WIP).'), 'after the look\'s own block, which it is no part of');
  return css.slice(css.indexOf('*/', start) + 2, css.lastIndexOf('/*', end)).replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Every `selector { body }` of the block, media queries flattened. */
function rules() {
  const flat = block().replace(/@media[^{]*\{/g, '').replace(/\}\s*\}/g, '}');
  return [...flat.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map((m) => ({ selector: m[1].trim().replace(/\s+/g, ' '), body: m[2] }));
}

/** A selector list's members: split on the commas outside every bracket. */
function members(selector) {
  const out = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < selector.length; i += 1) {
    const ch = selector[i];
    if (ch === '(' || ch === '[') depth += 1;
    else if (ch === ')' || ch === ']') depth -= 1;
    else if (ch === ',' && depth === 0) { out.push(selector.slice(from, i)); from = i + 1; }
  }
  out.push(selector.slice(from));
  return out.map((s) => s.trim()).filter(Boolean);
}

test('every rule of the editorial pages is the standard look\'s alone', () => {
  const all = rules();
  assert.ok(all.length > 30, 'the block has its rules');
  for (const rule of all) {
    for (const one of members(rule.selector)) {
      assert.ok(one.startsWith(SCOPE), `scoped to the standard look: ${one}`);
    }
  }
  assert.ok(!/data-skin="brand"/.test(block()), 'the brand look keeps its own drawing');
});

test('Profile and Settings leave the shared header and platform navigation untouched', () => {
  const editorial = block();
  assert.doesNotMatch(editorial, /#platform-(?:header|tabs)/, 'the global shell controls its own header and navigation');
  assert.doesNotMatch(editorial, /--wip-nav-[\w-]+\s*:/, 'the pages do not override shared navigation tokens');
  assert.doesNotMatch(editorial, /--wip-nav-w\s*:/, 'the pages do not change the shared rail width');
});

test('its colours are tokens, declared once in light and once in dark', () => {
  const all = rules();
  const [light, dark, ...rest] = all;
  assert.equal(light.selector, SCOPE);
  assert.equal(dark.selector, `${SCOPE}.dark`);
  for (const token of ['--ed-serif', '--ed-paper', '--ed-line', '--ed-sky', '--ed-sky-veil', '--ed-sky-ink', '--ed-lit-bg', '--ed-lit-ink', '--ed-stat-bg']) {
    assert.match(light.body, new RegExp(`${token}:`), `${token} is declared`);
  }
  // The words on the sky, the paper and the green row all change in the dark.
  for (const token of ['--ed-paper', '--ed-line', '--ed-sky-veil', '--ed-sky-ink', '--ed-lit-bg', '--ed-lit-ink', '--ed-stat-bg']) {
    assert.match(dark.body, new RegExp(`${token}:`), `${token} has a dark value`);
  }
  for (const rule of rest) {
    assert.ok(!/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i.test(rule.body), `no colour of its own: ${rule.selector}`);
    assert.ok(!/--ed-[a-z-]+\s*:/.test(rule.body), `no token declared outside the first two rules: ${rule.selector}`);
  }
  assert.match(light.body, /--ed-sky: url\('\/brand\/bg\/sky\.webp'\)/, 'the sky is the brand\'s own picture');
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'public', 'brand', 'bg', 'sky.webp')));
});

test('the editorial serif uses the shipped variable weight', () => {
  const serif = rules().filter((rule) => /font-family: var\(--ed-serif\)/.test(rule.body));
  assert.ok(serif.length >= 6, 'headings on both pages are in the serif');
  for (const rule of serif) {
    assert.match(rule.body, /font-weight: 460;/, `shipped weight: ${rule.selector}`);
  }
  assert.match(css, /@font-face \{\s*font-family: 'Source Serif 4';[^}]*font-weight: 200 900;/, 'the face ships the heading weight');
});

test('only duplicate Settings profile summary decoration is hidden beside the real editor', () => {
  const hidden = rules().filter((rule) => /display:\s*none|visibility:\s*hidden/.test(rule.body)).map((rule) => rule.selector);
  // The card is the shared ListRow: its name and handle are the row's text
  // column (.ui-lrow-tx), and its chevron the row's own (> svg).
  assert.deepEqual(hidden, [`${SCOPE} #settings-root:has(#settings-section-content:not(.hidden)) > .settings-frame-head`, `${SCOPE} #settings-profile-card .ui-lrow-tx`, `${SCOPE} #settings-profile-card > svg`]);
  assert.match(block(), /@media \(max-width: 1023\.98px\) \{\s*html:root #settings-root:has\(#settings-section-content:not\(\.hidden\)\) > \.settings-frame-head \{ display: none; \}/);
});

test('Settings opens under its name on the sky, and its parts are cards', () => {
  const b = block();
  assert.match(b, /html:root #settings-root > \.settings-frame-head \{\s*display: flex;/, 'the head is drawn');
  assert.match(b, /background: var\(--ed-sky-veil\), var\(--ed-sky\) center \/ cover no-repeat;/, 'under a veil, so its words read');
  assert.match(b, /#settings-screen #settings-root \{ max-width: none; \}/, 'the page runs the window\'s width');
  assert.match(b, /#settings-section-content > \[data-settings-section\]:not\(\.hidden\):has\(> :not\(\.hidden\)\) \{[^}]*border: 1px solid var\(--ed-line\);[^}]*background: var\(--ed-paper\);/, 'a part is a paper card');
  // Username, Email & recovery and Password stay one group under "Sign-in" (#5281).
  assert.match(b, /~ :is\(\[data-settings-section="email"\], \[data-settings-section="password"\]\):not\(\.hidden\):has\(> :not\(\.hidden\)\) \{[^}]*border-top: 0;/);
  assert.match(b, /#settings-sidebar-col\.settings-side-sheet \{[^}]*--lit-tint: var\(--ed-lit-bg\);[^}]*--lit-ink: var\(--ed-lit-ink\);/, 'the page you are on is the green row');
  const src = read('frontend', 'src', 'features', 'settings', 'index.tsx');
  assert.match(src, /<header className="settings-frame-head">/, 'the head is in the document for it');
});

test('the sky starts at the top bar\'s line on a computer and a tablet', () => {
  const b = block();
  // The screen closes the bar's 8px foot; the root gives it back as padding,
  // so the cards stay put and only the sky's top edge moves up.
  assert.match(
    b,
    /@media \(min-width: 768px\) \{\s*html:root :is\(#profile-screen:has\(#profile-identity-card\), #settings-screen\) \{ margin-top: -0\.5rem; \}\s*html:root :is\(#profile-screen #profile-root:has\(#profile-identity-card\), #settings-screen #settings-root\) \{ padding-top: 0\.5rem; \}/,
    'the screen tucks up and the root pads the same 8px back',
  );
  // Under 1024px the sky is placed from the padding edge, so the same 8px
  // comes off its position; above it the border-box origin needs no move.
  assert.match(
    b,
    /@media \(min-width: 768px\) and \(max-width: 1023\.98px\) \{\s*html:root :is\(#profile-screen #profile-root:has\(#profile-identity-card\), #settings-screen #settings-root\) \{ background-position: center -0\.5rem; \}/,
    'the tablet sky is moved up with the padding',
  );
});

test('Profile opens on who you are, across the page', () => {
  const b = block();
  assert.match(b, /#profile-root > div > div:has\(> #profile-identity-card\) \{ display: contents; \}/);
  assert.match(b, /#profile-root #profile-identity-card \{ grid-column: 1 \/ -1; grid-row: 1; \}/);
  assert.match(b, /#profile-root #profile-stats \{ grid-column: 1 \/ -1; grid-row: 2; \}/);
  // Only a page that holds your own card is widened: somebody else's keeps its column.
  assert.match(b, /#profile-screen #profile-root:has\(#profile-identity-card\) \{ max-width: none; \}/);
  // A hidden strip (every figure a zero) stays hidden.
  assert.match(b, /#profile-root #profile-stats:not\(\.hidden\) \{\s*display: flex;/);
  assert.match(b, /#profile-stats > \[data-profile-stat\]:not\(\.hidden\) \{/);
  const view = read('frontend', 'src', 'features', 'profile', 'profile-view.tsx');
  // (Its grey sub-line under the name was the other looks', removed 26 Nov
  // 2026; the bio is the inline editor's, identity-inline-edit.tsx.)
  const inline = read('frontend', 'src', 'features', 'profile', 'identity-inline-edit.tsx');
  for (const hook of ['profile-id-avatar', 'profile-id-name', 'profile-id-bio']) {
    assert.ok(view.includes(hook) || inline.includes(hook), `the card carries ${hook}`);
    assert.ok(b.includes(`.${hook}`), `and the block reads ${hook}`);
  }
  assert.ok(!view.includes('profile-id-sub'), 'no sub-line under the name');
  // #7135: the picture is the uploaded photo or the account's generated one,
  // clipped to the editorial square by the same avatar class and its own
  // overflow, so it never spills past the radius.
  assert.match(view, /profile-id-avatar[^"`]*rounded-full[^"`]*object-cover/,
    'a real picture keeps the round frame and its crop');
  assert.match(view, /profile-id-avatar[^"`]*overflow-hidden/,
    'the empty frame still clips itself to the radius');
  assert.doesNotMatch(view, /\/brand\/groups\/avatar-/, 'the two-person drawing no longer stands in for a photo');
  assert.match(b, /#profile-identity-card #profile-edit-btn \{[^}]*background: var\(--wip-btn-1-bg\);/, 'Edit profile is the main action');
});


test('project cards show every project with a live change, in the order given', () => {
  const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
  const { ProfileLiveProjects } = loadTsx('frontend/src/features/profile/profile-live-projects.tsx', {
    stubs: { '../../lib/i18n/react': { useMessages: () => (id, params) => params?.title || id } },
  });
  const html = renderToHtml(createElement(ProfileLiveProjects, { projects: [
    { sessionId: 4, title: 'Newest <change>', appSlug: 'garden', appName: 'Garden', appIconUrl: '/app-icons/abc' },
    { sessionId: 3, title: 'Another project', appSlug: 'tides', appName: 'Tides', appIconEmoji: '🌊' },
    { sessionId: 2, title: 'Third project', appSlug: 'notes', appName: 'Notes' },
    { sessionId: 1, title: 'Oldest project', appSlug: 'runs', appName: 'Runs', appIconUrl: null },
  ] }));
  assert.equal((html.match(/class="profile-project-card"/g) || []).length, 4, 'four projects, not three');
  assert.match(html, /Newest &lt;change&gt;/);
  assert.match(html, /Oldest project/);
  const slugs = [...html.matchAll(/href="#app\/([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(slugs, ['garden', 'tides', 'notes', 'runs'], 'newest first, as given');
  // A project with a logo shows it inside the card's square; one without
  // keeps its emoji, then its first letter (#7153).
  assert.match(html, /<span class="profile-project-icon" aria-hidden="true"><img src="\/app-icons\/abc" alt="" loading="lazy"\/><\/span>/, 'the uploaded logo fills the square');
  assert.match(html, /<span class="profile-project-icon" aria-hidden="true">🌊<\/span>/, 'no logo: the emoji');
  assert.equal((html.match(/profile-project-icon" aria-hidden="true">[A-Z]<\/span>/g) || []).length, 2, 'no logo and no emoji: the first letter');
  // The image fills the square at both radii, and the square clips it.
  assert.match(block(), /#profile-live-projects \.profile-project-icon \{[^}]*overflow: hidden/);
  assert.match(block(), /#profile-live-projects \.profile-project-icon img \{[^}]*object-fit: cover/);
  const empty = renderToHtml(createElement(ProfileLiveProjects, { projects: [] }));
  assert.match(empty, /profile:projects.empty/);
  assert.doesNotMatch(empty, /class="profile-project-card"/);
});


test('Settings keeps the one profile form, and the profile screen edits in its hero', () => {
  const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
  const user = { username: 'builder', displayName: 'A <builder>', bio: 'Making things together' };
  const { ProfileDetailsCard } = loadTsx('frontend/src/features/profile/profile-details-card.tsx', {
    stubs: {
      './profile.js': { Profile: { _user: () => user, MAX_BIO: 280 } },
      '../../lib/i18n/react': { useMessages: () => (id) => id },
    },
  });
  // #7156: the profile screen no longer mounts it, so Settings is its only
  // page and it brings no heading of its own there.
  const html = renderToHtml(createElement(ProfileDetailsCard, { user, id: 'settings-profile-details', embedded: true }));
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  for (const field of ['name', 'handle', 'bio']) {
    assert.ok(html.includes(`for="settings-profile-details-${field}"`));
    assert.ok(ids.includes(`settings-profile-details-${field}`));
  }
  assert.match(html, /A &lt;builder&gt;/);
  assert.match(html, /maxLength="40"/);
  assert.match(html, /maxLength="280"/);
  assert.equal((html.match(/<form/g) || []).length, 1);
  assert.equal((html.match(/<h2/g) || []).length, 0, 'the retired heading is gone');
  const view = read('frontend', 'src', 'features', 'profile', 'profile-view.tsx');
  assert.doesNotMatch(view, /ProfileDetailsCard/, 'the profile screen no longer mounts the card');
  assert.match(view, /<InlineNameEdit/, 'the hero keeps the pencil');
  assert.match(view, /<InlineBioEdit/, 'and the bio with its link');
});

test('the name and the bio are edited where they are shown', () => {
  const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
  const { InlineBioEdit, InlineNameEdit } = loadTsx('frontend/src/features/profile/identity-inline-edit.tsx', {
    stubs: {
      './profile.js': { Profile: { MAX_BIO: 280 } },
      '../../lib/i18n/react': { useMessages: () => (id) => id },
    },
  });
  const user = { displayName: 'A <builder>', bio: 'Building <small> tools' };
  const closed = renderToHtml(createElement('div', null,
    createElement(InlineNameEdit, { user, open: false, onOpen() {}, onClose() {} }),
    createElement(InlineBioEdit, { user, open: false, onOpen() {}, onClose() {} }),
  ));
  assert.match(closed, /id="profile-name-edit"/, 'a pencil beside the name');
  assert.match(closed, /profile:identity\.editName/, 'announced as Edit name');
  assert.match(closed, /id="profile-bio-edit"/);
  assert.match(closed, /profile:identity\.editBio/);
  assert.match(closed, /Building &lt;small&gt; tools/, 'the bio is a text child, escaped');
  assert.match(closed, /class="profile-id-bio[^"]*"/, 'and keeps the hook the block draws');
  assert.doesNotMatch(closed, /<form/, 'nothing is open');

  const noBio = renderToHtml(createElement(InlineBioEdit, { user: { displayName: 'x' }, open: false, onOpen() {}, onClose() {} }));
  assert.match(noBio, /profile:identity\.addBio/);
  assert.doesNotMatch(noBio, /profile-id-bio/, 'no empty bio line');

  const open = renderToHtml(createElement('div', null,
    createElement(InlineNameEdit, { user, open: true, onOpen() {}, onClose() {} }),
    createElement(InlineBioEdit, { user, open: true, onOpen() {}, onClose() {} }),
  ));
  assert.equal((open.match(/<form class="profile-inline-form">/g) || []).length, 2);
  assert.match(open, /for="profile-name-input"/);
  assert.match(open, /id="profile-name-input"/);
  assert.match(open, /for="profile-bio-input"/);
  assert.match(open, /id="profile-bio-input"/);
  assert.match(open, /maxLength="40"/, 'the name keeps its limit');
  assert.match(open, /maxLength="280"/, 'and the bio its own');
  assert.match(open, /A &lt;builder&gt;/, 'the box starts on what is stored');
  assert.match(open, /Building &lt;small&gt; tools/);
  assert.match(open, /profile-inline-count/, 'the bio counts its characters');
  assert.match(open, /profile:details\.save/);
  assert.match(open, /core:common\.cancel/);
  assert.doesNotMatch(open, /profile-name-edit|profile-bio-edit/, 'the link gives way to the box');
});

test('the editorial block draws the inline editors and no profile details card', () => {
  const b = block();
  assert.doesNotMatch(b, /#profile-details\b/, 'the in-page card is gone from the standard profile');
  assert.doesNotMatch(b, /#profile-root \.profile-details-card/);
  assert.match(b, /#profile-identity-card #profile-name-edit \{/, 'the pencil');
  assert.match(b, /#profile-identity-card #profile-bio-edit \{/, 'the bio link');
  assert.match(b, /#profile-identity-card \.profile-inline-form \{/, 'the box both open');
  assert.match(b, /\.profile-inline-form button\[type="submit"\]/, 'Save changes wears the sun');
  assert.ok(b.includes('var(--ed-well)') && b.includes('var(--ed-muted)') && b.includes('var(--state-blocked)'),
    'its box, its counter and its alerts are the block\'s tokens');
});


test('recent activity links real changes and leaves out unknown times', () => {
  const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
  const { ProfileRecentActivity } = loadTsx('frontend/src/features/profile/profile-recent-activity.tsx', {
    stubs: { '../../lib/i18n/react': { useMessages: () => (id) => id } },
  });
  const html = renderToHtml(createElement(ProfileRecentActivity, { changes: [
    { sessionId: 12, prNumber: 3, title: 'A <change>', appSlug: 'garden', appName: 'Garden', mergedAt: null },
  ] }));
  assert.match(html, /href="#app\/garden\/dev\/changes\/3\/12"/);
  assert.match(html, /A &lt;change&gt;/);
  assert.doesNotMatch(html, /<time/);
  assert.equal(renderToHtml(createElement(ProfileRecentActivity, { changes: [] })), '');
  // #7134: the Activity tab asks for up to five; the overview keeps three.
  const many = Array.from({ length: 6 }, (_, i) => ({
    sessionId: i + 1, title: `Change ${i + 1}`, appSlug: 'garden', appName: 'Garden', mergedAt: null,
  }));
  assert.equal((renderToHtml(createElement(ProfileRecentActivity, { changes: many })).match(/<li>/g) || []).length, 3);
  assert.equal((renderToHtml(createElement(ProfileRecentActivity, { changes: many, limit: 5 })).match(/<li>/g) || []).length, 5);
  // #7134 review: the Activity tab keeps its heading and says so in the card
  // when there is nothing to list; the overview still renders nothing.
  const none = renderToHtml(createElement(ProfileRecentActivity, { changes: [], empty: true }));
  assert.match(none, /id="profile-recent-activity"/);
  assert.match(none, /profile:recent\.title/);
  assert.match(none, /<ul><li class="profile-recent-empty">messages:ai\.history\.empty<\/li><\/ul>/);
});

// #7235: Settings stands on Profile's page geometry. The list of pages is
// Profile's left column, the head starts at the inset your name does, and a
// card and its heading are the sizes Profile's are. Profile's own rules are
// the source of each value, so the two pages cannot drift apart.
test('Settings stands on Profile\'s grid and head', () => {
  const all = rules();
  /** The declaration's value, from the last rule of that selector that has it. */
  function declared(selector, property) {
    const bodies = all.filter((rule) => members(rule.selector).includes(selector))
      .map((rule) => rule.body)
      .filter((body) => new RegExp(`(?:^|;)\\s*${property}:`).test(body));
    assert.ok(bodies.length > 0, `${selector} declares ${property}`);
    const match = bodies[bodies.length - 1].match(new RegExp(`(?:^|;)\\s*${property}:\\s*([^;]+);`));
    return match[1].trim();
  }

  const profileGrid = 'html:root #profile-root > div:has(> div > #profile-identity-card)';
  const settingsGrid = 'html:root #settings-root > div:has(> #settings-sidebar-col)';
  assert.equal(declared(settingsGrid, 'display'), 'grid', 'Settings uses Profile\'s two columns');
  assert.equal(declared(settingsGrid, 'grid-template-columns'), declared(profileGrid, 'grid-template-columns'),
    'the left column is Profile\'s width');
  assert.equal(declared(settingsGrid, 'column-gap'), declared(profileGrid, 'column-gap'),
    'and the gap beside it is Profile\'s');

  // The head sits at the same inset from the page's edge as Profile's name.
  assert.equal(declared('html:root body #settings-screen #settings-root:has(> div > #settings-sidebar-col)', 'padding-inline-start'),
    declared('html:root #profile-screen #profile-root:has(#profile-identity-card)', 'padding-inline-start'),
    'the page starts where Profile\'s does');
  assert.equal(declared('html:root #settings-root > .settings-frame-head', 'padding'),
    declared('html:root #profile-root #profile-identity-card', 'padding'),
    'and "Settings" is padded as your name on Profile is');

  // A part's card is Profile's size: its inner padding, the gap between two,
  // and the heading above its form.
  const card = 'html:root #settings-section-content > [data-settings-section]:not(.hidden):has(> :not(.hidden))';
  assert.equal(declared(card, 'padding'), '1.25rem', 'a part is padded as Profile\'s groups are');
  assert.equal(declared('html:root #settings-section-content > [data-settings-section]:not(.hidden) ~ [data-settings-section]:not(.hidden):has(> :not(.hidden))', 'margin-top'),
    '1.5rem', 'two parts are as far apart as Profile\'s groups');
  const h3Sizes = all.filter((rule) => rule.selector === 'html:root #settings-section-content h3')
    .map((rule) => (rule.body.match(/(?:^|;)\s*font-size:\s*([^;]+);/) || [])[1])
    .filter(Boolean);
  assert.equal(h3Sizes[0], 'var(--ed-head-size)', 'a card\'s heading is Profile\'s heading size');
  assert.equal(h3Sizes[h3Sizes.length - 1], 'var(--ed-head-size-phone)', 'a phone keeps the smaller heading');
  assert.match(declared('html:root #settings-section-content h3', 'letter-spacing'), /-0\.035em/, 'and its tracking');

  // The list's group names are serif headings, where they were small capitals.
  const groupName = 'html:root :is(#settings-nav-desktop, #settings-mobile-menu-host) .ui-cap';
  assert.equal(declared(groupName, 'font-family'), 'var(--ed-serif)', 'a group\'s name is the serif');
  assert.equal(declared(groupName, 'font-weight'), '460', 'at the shipped weight');
  assert.equal(declared(groupName, 'text-transform'), 'none', 'in sentence case');
  assert.equal(declared(groupName, 'font-size'), '1.125rem', 'a step under a card\'s heading');
  assert.equal(declared('html:root #settings-mobile-menu-host .ui-cap button', 'text-transform'), 'none',
    'the phone\'s fold button loses its capitals too');
});
