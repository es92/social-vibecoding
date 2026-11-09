// #328: markdown rendering for group-chat message bodies + the 8000-char
// limit. Two concerns, two halves:
//
//  (A) Frontend — load public/js/group-chat.js into a vm sandbox (it's a
//      browser script, no module.exports) with a small but real DOM shim,
//      then exercise the new pure tokenizer and the text-node decoration
//      walker that layers @mentions / PR-#refs on top of sanitized markdown
//      HTML. The security-critical property is that decoration NEVER fires
//      inside <a>/<code>/<pre> and NEVER reintroduces raw HTML (spans are
//      built via DOM APIs; stray markup in a text node stays escaped).
//
//  (B) Backend — drive src/services/ws.js handleMessage for the 'chat' and
//      'edit' paths with a mock pool and assert a 9000-char body is capped
//      to MAX_CHAT_LEN (8000) before it reaches the INSERT/UPDATE.
//
// Run with: node --test tests/group-chat-markdown.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// ─── Minimal DOM shim ──────────────────────────────────────────────────────
// Just enough of the Node/Element/Fragment API for escapeHtml, the decoration
// walker, and HTML serialization (innerHTML getter). No HTML *parsing* — tests
// build trees by hand the way marked would emit them.

function escAttr(s) { return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;'); }
function escText(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function makeDom() {
  class TextNode {
    constructor(v) { this.nodeType = 3; this.nodeValue = String(v); this.parentNode = null; }
    get textContent() { return this.nodeValue; }
  }
  class Fragment {
    constructor() { this.__isFragment = true; this.childNodes = []; }
    appendChild(n) { n.parentNode = this; this.childNodes.push(n); return n; }
    removeChild(n) {
      const i = this.childNodes.indexOf(n);
      if (i >= 0) { this.childNodes.splice(i, 1); n.parentNode = null; }
      return n;
    }
  }
  class Element {
    constructor(tag) {
      this.nodeType = 1;
      this.tagName = String(tag).toUpperCase();
      this.childNodes = [];
      this.attributes = {};
      this.className = '';
      this.parentNode = null;
    }
    setAttribute(k, v) { this.attributes[k] = String(v); }
    getAttribute(k) { return this.attributes[k]; }
    appendChild(n) {
      if (n && n.__isFragment) { for (const c of n.childNodes.slice()) this.appendChild(c); return n; }
      if (n.parentNode) n.parentNode.removeChild(n);
      n.parentNode = this; this.childNodes.push(n); return n;
    }
    removeChild(n) {
      const i = this.childNodes.indexOf(n);
      if (i >= 0) { this.childNodes.splice(i, 1); n.parentNode = null; }
      return n;
    }
    replaceChild(newNode, oldNode) {
      const nodes = newNode && newNode.__isFragment ? newNode.childNodes.slice() : [newNode];
      for (const x of nodes) { if (x.parentNode) x.parentNode.removeChild(x); }
      const i = this.childNodes.indexOf(oldNode);
      if (i < 0) return;
      this.childNodes.splice(i, 1, ...nodes);
      for (const x of nodes) x.parentNode = this;
      oldNode.parentNode = null;
    }
    set textContent(v) {
      this.childNodes = [];
      this.appendChild(new TextNode(v));
    }
    get textContent() {
      return this.childNodes.map((c) => c.textContent).join('');
    }
    set innerHTML(v) {
      this.childNodes = [];
      const frag = parseHTML(String(v));
      for (const c of frag.childNodes.slice()) this.appendChild(c);
    }
    get innerHTML() {
      return this.childNodes.map(serialize).join('');
    }
  }
  function decodeEntities(s) {
    return String(s)
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  }
  // Tiny recursive-descent HTML parser — only what marked-style output needs:
  // open/close/self-closing tags, double-quoted attributes, nested children,
  // and text. Sufficient for the controlled fixtures in these tests.
  function parseHTML(html) {
    const frag = new Fragment();
    const stack = [frag];
    const tagRe = /<(\/?)([a-zA-Z0-9]+)((?:\s+[a-zA-Z-]+="[^"]*")*)\s*(\/?)>/g;
    let last = 0; let m;
    const pushText = (raw) => {
      if (raw) stack[stack.length - 1].appendChild(new TextNode(decodeEntities(raw)));
    };
    while ((m = tagRe.exec(html))) {
      if (m.index > last) pushText(html.slice(last, m.index));
      const isClose = m[1] === '/';
      const tag = m[2];
      if (isClose) {
        if (stack.length > 1) stack.pop();
      } else {
        const node = new Element(tag);
        const attrRe = /([a-zA-Z-]+)="([^"]*)"/g; let am;
        while ((am = attrRe.exec(m[3]))) {
          if (am[1] === 'class') node.className = am[2];
          else node.setAttribute(am[1], am[2]);
        }
        stack[stack.length - 1].appendChild(node);
        if (m[4] !== '/') stack.push(node);
      }
      last = tagRe.lastIndex;
    }
    if (last < html.length) pushText(html.slice(last));
    return frag;
  }
  function serialize(node) {
    if (node.nodeType === 3) return escText(node.nodeValue);
    const tag = node.tagName.toLowerCase();
    let attrs = '';
    if (node.className) attrs += ` class="${escAttr(node.className)}"`;
    for (const [k, v] of Object.entries(node.attributes)) attrs += ` ${k}="${escAttr(v)}"`;
    return `<${tag}${attrs}>${node.childNodes.map(serialize).join('')}</${tag}>`;
  }
  const document = {
    createElement: (t) => new Element(t),
    createTextNode: (v) => new TextNode(v),
    createDocumentFragment: () => new Fragment(),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    body: { appendChild() {} },
  };
  return { document, Element, TextNode };
}

function loadGroupChat(extra = {}) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'group-chat.js'), 'utf8');
  const { document } = makeDom();
  const sandbox = {
    location: { search: '', protocol: 'http:', host: 'localhost' },
    URLSearchParams,
    document,
    window: { matchMedia: () => ({ matches: false }) },
    navigator: {},
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    App: { user: { id: 1, username: 'alice' } },
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    Date, Math, JSON,
    ...extra,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(
    src + '\nglobalThis.__M = { GroupChat, renderMessageBody, renderWithMentions, '
      + 'tokenizeMentionsAndRefs, decorateMentionsAndRefs, renderRequestMentions, GC_MAX_MESSAGE_LEN, document };',
    sandbox
  );
  return sandbox.__M;
}

// ─── (A1) pure tokenizer ────────────────────────────────────────────────────

test('tokenizeMentionsAndRefs splits mentions, refs and text in order', () => {
  const { tokenizeMentionsAndRefs } = loadGroupChat();
  const segs = tokenizeMentionsAndRefs('hi @bob see PR#12 and #3', 'alice');
  assert.deepEqual(Array.from(segs, (s) => s.type),
    ['text', 'mention', 'text', 'ref', 'text', 'ref']);
  assert.equal(segs[1].name, 'bob');
  assert.equal(segs[1].isSelf, false);
  assert.equal(segs[3].isPr, true);
  assert.equal(segs[3].num, '12');
  assert.equal(segs[5].isPr, false);
  assert.equal(segs[5].num, '3');
  // boundary chars are preserved as text
  assert.equal(segs[0].value, 'hi ');
});

test('tokenizeMentionsAndRefs flags the viewer’s own mention', () => {
  const { tokenizeMentionsAndRefs } = loadGroupChat();
  const segs = tokenizeMentionsAndRefs('@Alice and @bob', 'alice');
  assert.equal(segs.find((s) => s.type === 'mention' && s.name === 'Alice').isSelf, true);
  assert.equal(segs.find((s) => s.type === 'mention' && s.name === 'bob').isSelf, false);
});

test('tokenizeMentionsAndRefs returns a single text segment when nothing matches', () => {
  const { tokenizeMentionsAndRefs } = loadGroupChat();
  const segs = tokenizeMentionsAndRefs('just plain words', 'alice');
  assert.deepEqual(Array.from(segs, (s) => ({ type: s.type, value: s.value })),
    [{ type: 'text', value: 'just plain words' }]);
});

test('tokenizeMentionsAndRefs does not chip @name fused to a word char', () => {
  const { tokenizeMentionsAndRefs } = loadGroupChat();
  // email-like "a@bob" — @ preceded by a word char, so not a mention (parity
  // with the server mention parser).
  const segs = tokenizeMentionsAndRefs('a@bob', 'alice');
  assert.deepEqual(Array.from(segs, (s) => s.type), ['text']);
});

// ─── (A2) decoration walker over a marked-style tree ────────────────────────

function el(document, tag, ...kids) {
  const e = document.createElement(tag);
  for (const k of kids) e.appendChild(typeof k === 'string' ? document.createTextNode(k) : k);
  return e;
}

test('decorateMentionsAndRefs chips mentions/refs in ordinary text nodes', () => {
  const { decorateMentionsAndRefs, document } = loadGroupChat();
  const p = el(document, 'p', 'hey @bob check PR#7');
  decorateMentionsAndRefs(p);
  const html = p.innerHTML;
  assert.match(html, /<a class="gc-mention" href="#leaderboard\/users\/bob" data-mention="bob">@bob<\/a>/);
  assert.match(html, /<span class="gc-ref gc-ref-pr" data-ref-type="pr" data-ref-number="7"/);
});

test('decorateMentionsAndRefs marks the viewer’s own mention', () => {
  const { decorateMentionsAndRefs, document } = loadGroupChat();
  const p = el(document, 'p', 'ping @alice');
  decorateMentionsAndRefs(p);
  assert.match(p.innerHTML, /gc-mention gc-mention-self/);
});

test('decorateMentionsAndRefs does NOT chip inside <code>, <pre> or <a>', () => {
  const { decorateMentionsAndRefs, document } = loadGroupChat();
  const root = el(
    document, 'div',
    el(document, 'code', '@bob #5'),                    // inline code — literal
    el(document, 'pre', el(document, 'code', '@carol PR#9')), // code block — literal
    el(document, 'a', '@dave #1'),                      // existing link — literal
    document.createTextNode(' but @eve and #2 here'),   // plain text — decorated
  );
  decorateMentionsAndRefs(root);
  const html = root.innerHTML;
  // nothing inside code/pre/a became a span
  assert.match(html, /<code>@bob #5<\/code>/);
  assert.match(html, /<pre><code>@carol PR#9<\/code><\/pre>/);
  assert.match(html, /<a>@dave #1<\/a>/);
  // the plain text run outside those got decorated
  assert.match(html, /<a class="gc-mention" href="#leaderboard\/users\/eve" data-mention="eve">@eve<\/a>/);
  assert.match(html, /data-ref-number="2"/);
});

test('decorateMentionsAndRefs never reintroduces raw HTML from a text node', () => {
  const { decorateMentionsAndRefs, document } = loadGroupChat();
  // A text node already sanitized by DOMPurify would never contain a live
  // tag, but prove the decorator escapes on output rather than injecting.
  const p = el(document, 'p', '<script>@bob</script> #5');
  decorateMentionsAndRefs(p);
  const html = p.innerHTML;
  assert.doesNotMatch(html, /<script>/, 'angle brackets stay escaped');
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<a class="gc-mention" href="#leaderboard\/users\/bob" data-mention="bob">@bob<\/a>/, 'mention still chipped');
  assert.match(html, /data-ref-number="5"/, 'ref still chipped');
});

// ─── #4668: a chip with a project behind it is a real link ──────────────────

test('decorateMentionsAndRefs emits anchor chips when the chat names a project', () => {
  const { decorateMentionsAndRefs, document } = loadGroupChat({
    AppView: { appData: { slug: 'lost-starways' } },
  });
  const p = el(document, 'p', 'closing issue #28 and PR#31');
  decorateMentionsAndRefs(p);
  const html = p.innerHTML;
  assert.match(html, /<a class="gc-ref gc-ref-issue" data-ref-type="issue" data-ref-number="28" href="#app\/lost-starways\/dev\/issues\/28">#28<\/a>/);
  assert.match(html, /<a class="gc-ref gc-ref-pr" data-ref-type="pr" data-ref-number="31" href="#app\/lost-starways\/dev\/changes\/31">PR#31<\/a>/);
  // an anchor is focusable and a link already — no role or tabindex
  assert.doesNotMatch(html, /role="link"|tabindex="0"/);
});

test('renderWithMentions emits the same anchor chips on the string fallback path', () => {
  const { renderWithMentions } = loadGroupChat({
    AppView: { appData: { slug: 'lost-starways' } },
  });
  const out = renderWithMentions('closing issue #28 and PR#31');
  assert.match(out, /<a class="gc-ref gc-ref-issue" href="#app\/lost-starways\/dev\/issues\/28" data-ref-type="issue" data-ref-number="28">#28<\/a>/);
  assert.match(out, /<a class="gc-ref gc-ref-pr" href="#app\/lost-starways\/dev\/changes\/31" data-ref-type="pr" data-ref-number="31">PR#31<\/a>/);
});

test('the mounting caller\'s app names the chip\'s address, not the app view\'s', () => {
  const { GroupChat, renderWithMentions } = loadGroupChat({
    AppView: { appData: { slug: 'lost-starways' } },
  });
  GroupChat._app = { slug: 'other' };
  assert.match(renderWithMentions('#28'), /href="#app\/other\/dev\/issues\/28"/);
});

test('with no project named, a chip stays today\'s plain span', () => {
  const { renderWithMentions } = loadGroupChat();
  const out = renderWithMentions('closing issue #28');
  assert.match(out, /<span class="gc-ref gc-ref-issue" data-ref-type="issue" data-ref-number="28" role="link" tabindex="0">#28<\/span>/);
  assert.doesNotMatch(out, /<a class="gc-ref/);
});

// A chip as the decoration builds it, with the `dataset` a real DOM gives.
function makeChip(document, isPr, num) {
  const chip = document.createElement('a');
  chip.className = isPr ? 'gc-ref gc-ref-pr' : 'gc-ref gc-ref-issue';
  chip.setAttribute('href', `#app/a/dev/${isPr ? 'changes' : 'issues'}/${num}`);
  chip.setAttribute('data-ref-type', isPr ? 'pr' : 'issue');
  chip.setAttribute('data-ref-number', String(num));
  chip.dataset = { refType: isPr ? 'pr' : 'issue', refNumber: String(num) };
  return chip;
}

test('_openRef: the chip naming the open request scrolls back up to it', () => {
  const scrolled = [];
  const AppView = {
    appData: { slug: 'a' },
    _devTopic: { kind: 'issue', id: 28 },
    revealInDrawer: () => scrolled.push('revealed'),
  };
  const loc = { hash: '' };
  const { GroupChat, document } = loadGroupChat({ AppView, location: loc });
  GroupChat._threadPinned = true;
  GroupChat._threadScrollEl = () => ({ scrollTo(opts) { scrolled.push(opts); } });
  GroupChat._openRef(makeChip(document, false, '28'));
  assert.equal(scrolled.length, 1, 'one scroll, nothing revealed');
  assert.equal(scrolled[0].top, 0);
  assert.equal(scrolled[0].behavior, 'smooth');
  assert.equal(GroupChat._threadPinned, false);
});

test('_openRef: another request in the same app still reveals in the drawer', () => {
  const calls = [];
  const AppView = { appData: { slug: 'a' }, revealInDrawer: (...a) => calls.push(a) };
  const loc = { hash: '' };
  const { GroupChat, document } = loadGroupChat({ AppView, location: loc });
  GroupChat._openRef(makeChip(document, false, '12'));
  assert.deepEqual(calls, [['issue', '12']]);
  assert.equal(loc.hash, '');
});

test('_openRef: a chip for a different project follows its own address', () => {
  const calls = [];
  const AppView = { appData: { slug: 'b' }, revealInDrawer: (...a) => calls.push(a) };
  const loc = { hash: '' };
  const { GroupChat, document } = loadGroupChat({ AppView, location: loc });
  GroupChat._app = { slug: 'a' };
  GroupChat._openRef(makeChip(document, false, '28'));
  assert.deepEqual(calls, []);
  assert.equal(loc.hash, '#app/a/dev/issues/28');
});

test('_attachQuoteHandlers: a modified click stands down before preventDefault, and both press paths route through _openRef', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'group-chat.js'), 'utf8');
  const clickBranch = src.slice(
    src.indexOf("const ref = e.target.closest('.gc-ref');"),
    src.indexOf('.gc-spec-pr'),
  );
  const keydownBranch = src.slice(src.indexOf('#130: chips are spans'));
  // The modified-click early return precedes preventDefault, so the browser
  // — not this handler — opens the new tab, and no reply is staged either
  // (the branch returns before the tap-to-quote tail).
  const modifiedAt = clickBranch.indexOf('e.metaKey || e.ctrlKey || e.shiftKey || e.altKey');
  assert.ok(modifiedAt > -1, 'a modified click is recognised');
  assert.ok(modifiedAt < clickBranch.indexOf('e.preventDefault()'), 'before preventDefault');
  assert.match(clickBranch, /GroupChat\._openRef\(ref\)/);
  assert.match(keydownBranch, /GroupChat\._openRef\(ref\)/);
});

// ─── (A3) renderMessageBody fallback (no DevChat / no markdown libs) ─────────

test('renderMessageBody falls back to escaped mention/ref rendering without DevChat', () => {
  const { renderMessageBody } = loadGroupChat(); // no DevChat in sandbox
  const out = renderMessageBody('plain @bob <b>not bold</b> #4');
  assert.match(out, /gc-mention/, 'mention chipped on the fallback path');
  assert.match(out, /gc-ref-issue/, 'ref chipped on the fallback path');
  assert.match(out, /&lt;b&gt;not bold&lt;\/b&gt;/, 'raw HTML stays escaped (no markdown rendered)');
});

test('renderMessageBody uses DevChat.renderMarkdown when available', () => {
  let receivedOpts = null;
  const DevChat = {
    renderMarkdown(text, opts) {
      receivedOpts = opts;
      // stand-in for marked+DOMPurify output: a <p> wrapper, mention left in text
      return `<p class="dc-p"><strong>bold</strong> @bob</p>`;
    },
  };
  const { renderMessageBody } = loadGroupChat({ DevChat });
  const out = renderMessageBody('**bold** @bob');
  assert.equal(receivedOpts && receivedOpts.breaks, true, 'breaks:true passed through');
  assert.match(out, /<strong>bold<\/strong>/, 'markdown formatting preserved');
  assert.match(out, /<a class="gc-mention" href="#leaderboard\/users\/bob" data-mention="bob">@bob<\/a>/, 'mention decorated atop markdown');
});

// ─── (A4) #4029: a mention is a link to the person's page ──────────────────

test('a person\'s mention links to their page on the fallback path; the viewer\'s own keeps -self', () => {
  const { renderWithMentions } = loadGroupChat();
  const out = renderWithMentions('hi @bob and @alice');
  assert.match(out, /<a class="gc-mention" href="#leaderboard\/users\/bob" data-mention="bob">@bob<\/a>/);
  assert.match(out, /<a class="gc-mention gc-mention-self" href="#leaderboard\/users\/alice" data-mention="alice">@alice<\/a>/);
});

test('Homeroom bot\'s mention stays text (no person page) on both paths', () => {
  const { renderWithMentions, decorateMentionsAndRefs, document } = loadGroupChat();
  for (const out of [renderWithMentions('ask @Homeroom bot and @homeroom_bot and @homeroombot'),
    (() => { const p = el(document, 'p', 'ask @Homeroom bot and @homeroom_bot and @homeroombot'); decorateMentionsAndRefs(p); return p.innerHTML; })()]) {
    assert.match(out, /<span class="gc-mention">@Homeroom bot<\/span>/);
    assert.match(out, /<span class="gc-mention">@homeroom_bot<\/span>/);
    assert.match(out, /<span class="gc-mention">@homeroombot<\/span>/);
    assert.doesNotMatch(out, /leaderboard\/users/, 'the bot is never a link');
  }
});

// ─── (A5) #3952: @mentions in a request's text ─────────────────────────────
//
// A request's body and its GitHub comments reach the page as GitHub stores
// them: everything Homeroom sent went through services/github.js safeMention,
// which puts a zero-width space after each `@`. That guard is what marks a
// name as typed on Homeroom, so it is what gets linked; a bare `@handle`
// came from GitHub itself and stays text.

const ZWSP = '​';
const github = require('../src/services/github');

test('a request names a person with the chat\'s mention link, guard removed', () => {
  const { renderRequestMentions } = loadGroupChat();
  // Exactly what GitHub holds for "Fix the header @snait lmk wyt".
  const stored = github.safeMention('Fix the header @snait lmk wyt');
  assert.ok(stored.includes(`@${ZWSP}snait`), 'the fixture is what safeMention writes');
  const out = renderRequestMentions(`<p class="dc-p">${stored}</p>`);
  assert.equal(out,
    '<p class="dc-p">Fix the header <a class="gc-mention" href="#leaderboard/users/snait" data-mention="snait">@snait</a> lmk wyt</p>');
  assert.ok(!out.includes(ZWSP), 'the guard is display-only and never shows');
});

test('a request\'s mentions keep chat\'s rules: self, the bot, emails, no refs', () => {
  const { renderRequestMentions } = loadGroupChat(); // the viewer is alice
  const text = github.safeMention('@alice and @Homeroom bot, mail me@example.com about #12 and PR#3');
  const out = renderRequestMentions(`<p>${text}</p>`);
  assert.match(out, /<a class="gc-mention gc-mention-self" href="#leaderboard\/users\/alice" data-mention="alice">@alice<\/a>/);
  assert.match(out, /<span class="gc-mention">@Homeroom bot<\/span>/, 'the bot has no person page');
  assert.match(out, /mail me@example\.com about #12 and PR#3/, 'an email is text, and so are refs here');
  assert.doesNotMatch(out, /gc-ref|data-ref-number|gc-channel-ref/, 'a request\'s #12 opens nothing on its page');
});

test('a bare @handle (written on GitHub) is not a person here, and stays text', () => {
  const { renderRequestMentions } = loadGroupChat();
  const html = `<p>cc @octocat, and @${ZWSP}bob from Homeroom</p>`;
  const out = renderRequestMentions(html);
  assert.match(out, /cc @octocat, and <a class="gc-mention" href="#leaderboard\/users\/bob" data-mention="bob">@bob<\/a> from Homeroom/);
  assert.doesNotMatch(out, /users\/octocat/);
  // Nothing guarded at all: the markup comes back exactly as it went in.
  const plain = '<p>cc @octocat</p>';
  assert.equal(renderRequestMentions(plain), plain);
});

test('code and links keep their text literal, without the guard in it', () => {
  const { renderRequestMentions } = loadGroupChat();
  const out = renderRequestMentions(
    `<p>run <code>npm i @${ZWSP}types/node</code> then ask <a href="https://example.com">@${ZWSP}carol</a></p>`
    + `<pre><code>@${ZWSP}Component\nclass A {}</code></pre>`,
  );
  assert.match(out, /<code>npm i @types\/node<\/code>/, 'a copied command is what was typed');
  assert.match(out, /<a href="https:\/\/example\.com">@carol<\/a>/, 'never a link inside a link');
  assert.match(out, /<pre><code>@Component\nclass A \{\}<\/code><\/pre>/);
  assert.doesNotMatch(out, /gc-mention/);
  assert.ok(!out.includes(ZWSP));
});

test('tokenizeMentionsAndRefs mentionsOnly leaves refs and channels as text', () => {
  const { tokenizeMentionsAndRefs } = loadGroupChat();
  const segs = tokenizeMentionsAndRefs('see #12, PR#3 and #general, @bob', 'alice',
    new Set(['general']), { mentionsOnly: true });
  assert.deepEqual(Array.from(segs, (s) => s.type), ['text', 'mention']);
  assert.equal(segs[0].value, 'see #12, PR#3 and #general, ');
  assert.equal(segs[1].name, 'bob');
});

test('GC_MAX_MESSAGE_LEN is 8000', () => {
  const { GC_MAX_MESSAGE_LEN } = loadGroupChat();
  assert.equal(GC_MAX_MESSAGE_LEN, 8000);
});

// ─── (A6) #6308: a link in a chat body is blue ──────────────────────────────
// The body is `.gc-msg-content`, drawn by the channel and the request thread
// alike. A markdown / bare-URL anchor used to inherit the body ink, so it was
// clickable and looked like prose. It now wears the same accent + underline as
// Messages' markdown; the `#N` / `PR#N` / `#channel` chips are excluded and
// keep their own inks.

const APP_CSS = fs.readFileSync(path.join(__dirname, '..', 'public/css/app.css'), 'utf8');

test('a link in a chat body wears the platform link blue, under a rule that leaves the ref chips alone', () => {
  assert.match(APP_CSS,
    /\.gc-msg-content a:not\(\.gc-ref\):not\(\.gc-channel-ref\) \{\s*color: var\(--accent\);\s*text-decoration: underline;\s*\}/);
});

test('the channel chip still draws itself, not as a body link', () => {
  assert.match(APP_CSS, /\.gc-channel-ref \{[^}]*color: var\(--accent\);[^}]*text-decoration: none;/);
  assert.match(APP_CSS, /\.gc-ref-pr \{[^}]*color: rgb\(90, 169, 255\);/);
  assert.match(APP_CSS, /\.gc-ref-issue \{[^}]*color: rgb\(52, 211, 153\);/);
});

// ─── (B) backend limit ──────────────────────────────────────────────────────
// ws.js requires 'ws' + 'jsonwebtoken' at module load (not installed in this
// hermetic env), so intercept them via Module._load like the other ws suites.

const Module = require('module');

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

function loadWs() {
  const _origLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === 'ws') return { WebSocketServer: class {} };
    if (request === 'jsonwebtoken') return { verify: () => ({}), sign: () => '' };
    return _origLoad.call(this, request, ...rest);
  };
  const ids = {
    pool: require.resolve('../src/db/pool'),
    logger: require.resolve('../src/services/logger'),
    notifications: require.resolve('../src/services/notifications'),
    events: require.resolve('../src/services/events'),
    appAccess: require.resolve('../src/services/app-access'),
    subject: require.resolve('../src/services/ws'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];
  stub(ids.pool, { getPool: () => ({ query: async () => ({ rows: [] }) }) });
  stub(ids.logger, { info() {}, warn() {}, error() {}, debug() {} });
  // Send path fans out reply/mention notifications + the read-clear; all are
  // wrapped in try/catch in ws.js, so empty stubs (methods undefined) are
  // swallowed as warnings and never affect the INSERT under test.
  stub(ids.notifications, {});
  stub(ids.events, { record() {}, EVENT_TYPES: {} });
  // #621: handleMessage's write gate consults checkAppAccess before every
  // mutating message — pass everyone so these tests keep exercising the
  // length-cap semantics (the gate has its own tests in
  // readonly-dev-access.test.js).
  stub(ids.appAccess, { checkAppAccess: async () => true });
  delete require.cache[ids.subject];
  const ws = require('../src/services/ws');
  Module._load = _origLoad;
  delete require.cache[ids.subject];
  for (const [k, id] of Object.entries(ids)) {
    if (orig[k]) require.cache[id] = orig[k]; else delete require.cache[id];
  }
  return ws;
}

test('ws.MAX_CHAT_LEN is 8000', () => {
  assert.equal(loadWs().MAX_CHAT_LEN, 8000);
});

test('handleMessage caps an over-length chat body at MAX_CHAT_LEN on insert', async () => {
  const ws = loadWs();
  let insertedContent = null;
  const pool = {
    async query(sql, params) {
      // #621: the write gate resolves the app first — answer collab-public.
      if (/FROM apps WHERE id/.test(sql)) {
        return { rows: [{ id: params[0], collab_visibility: 'public', view_visibility: 'public' }] };
      }
      if (/INSERT INTO chat_messages/.test(sql)) {
        insertedContent = params[2];
        return { rows: [{ id: 1, created_at: '2026-06-16T00:00:00.000Z' }] };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  const client = { appId: 1, user: { id: 2, username: 'bob' } };
  const result = await ws.handleMessage(pool, client, { type: 'chat', content: 'a'.repeat(9000) });
  assert.equal(insertedContent.length, ws.MAX_CHAT_LEN);
  assert.equal(result.ok, true);
  assert.equal(result.message.content.length, ws.MAX_CHAT_LEN);
});

test('handleMessage caps an over-length edit body at MAX_CHAT_LEN on update', async () => {
  const ws = loadWs();
  let updatedContent = null;
  const pool = {
    async query(sql, params) {
      // #621: the write gate resolves the app first — answer collab-public.
      if (/FROM apps WHERE id/.test(sql)) {
        return { rows: [{ id: params[0], collab_visibility: 'public', view_visibility: 'public' }] };
      }
      if (/SELECT user_id, msg_type/.test(sql)) {
        return { rows: [{ user_id: 2, msg_type: 'message', thread_type: null, thread_ref: null }] };
      }
      if (/UPDATE chat_messages SET content/.test(sql)) {
        updatedContent = params[0];
        return { rows: [{ edited_at: '2026-06-16T00:00:00.000Z' }] };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  const client = { appId: 1, user: { id: 2, username: 'bob' } };
  await ws.handleMessage(pool, client, { type: 'edit', messageId: 5, content: 'b'.repeat(9000) });
  assert.equal(updatedContent.length, ws.MAX_CHAT_LEN);
});
