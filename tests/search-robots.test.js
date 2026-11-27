'use strict';

// What a search engine is told about the addresses the platform answers for
// (src/services/search-robots.js), and that each place it is said still
// says it: the app-host gate (behaviour in tests/app-gate-proxy.test.js),
// the shared asset server, the shell's front page, the starter app and the
// conventions an app is built from.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const express = require('express');

const robots = require('../src/services/search-robots');
const template = require('../src/services/template');
const { platformOrigin } = require('../src/services/app-identity-env');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

test('an app host: API routes and the platform’s own paths are noindex, pages are left alone', () => {
  const on = (url, host = 'reloop-a41163.onhomeroom.com') => robots.appHostRobots({ host, url });
  for (const url of ['/api', '/api/', '/api/my/items', '/api/pins?pubkey=', '/__usernode/cache/', '/__usernode_access',
    '/usernode-bridge/v1/bridge.js', '/usernode-native/v1/native.css', '/usernode-tailwind/v1/tailwind.js']) {
    assert.equal(on(url), 'noindex', url);
  }
  for (const url of ['/', '/read/12?c=4', '/apiary', '/api-docs', '/my-list', '/usernode-bridge', '']) {
    assert.equal(on(url), null, url || '(empty)');
  }
});

test('a preview host is noindex whatever the path; an app whose name merely looks close is not', () => {
  for (const host of ['viatales-125912--s13423.onhomeroom.app', 'a--s1.onhomeroom.com:443', 'A--S7--abc.onhomeroom.app']) {
    assert.equal(robots.appHostRobots({ host, url: '/' }), 'noindex', host);
    assert.equal(robots.isPreviewHost(host), true, host);
  }
  for (const host of ['viatales-125912.onhomeroom.com', 'a--staging.onhomeroom.com', 'a-s12.onhomeroom.com', '', undefined]) {
    assert.equal(robots.appHostRobots({ host, url: '/' }), null, String(host));
  }
});

test('an app’s own X-Robots-Tag is kept, and noindex is added once', () => {
  assert.equal(robots.withRobots(undefined, 'noindex'), 'noindex');
  assert.equal(robots.withRobots('', 'noindex'), 'noindex');
  assert.equal(robots.withRobots('nofollow', 'noindex'), 'nofollow, noindex');
  assert.equal(robots.withRobots('NoIndex, nofollow', 'noindex'), 'NoIndex, nofollow');
  assert.equal(robots.withRobots(['nofollow', 'noarchive'], 'noindex'), 'nofollow, noarchive, noindex');
  assert.equal(robots.withRobots('nofollow', null), 'nofollow');
});

test('the shell asks search engines in on the front page, and out of every other address', () => {
  assert.equal(robots.shellRobots({ path: '/' }), null);
  for (const path of ['/app/x', '/app/x/workshop', '/thread/1', '/invite/abc', '/needs', '/messages']) {
    assert.equal(robots.shellRobots({ path }), 'noindex', path);
  }
  assert.equal(robots.shellRobots({}), 'noindex', 'no path is not the front page');
});

test('server.js’s catch-all sends that header, and the shell has one description and no canonical', () => {
  const source = read('server.js');
  const at = source.indexOf("app.get('*', (req, res)");
  assert.ok(at > 0);
  const handler = source.slice(at, source.indexOf('\n});', at));
  assert.match(handler, /shellRobots\(\{ path: req\.path \}\)/);
  assert.match(handler, /res\.setHeader\('X-Robots-Tag', robots\)/);

  const head = read('frontend/src/head.html');
  assert.equal((head.match(/<meta name="description"/g) || []).length, 1);
  assert.match(head, /<meta name="description" content="Homeroom is where people make apps together: suggest a change, vote on it, and see it go live\.">/);
  assert.doesNotMatch(head, /rel="canonical"/, 'the front page’s canonical stays a Link header');
});

test('an invite link asks search engines out from its own route, not the catch-all', () => {
  for (const file of ['src/routes/community-invites.js', 'src/routes/access-links.js']) {
    assert.match(read(file), /res\.setHeader\('X-Robots-Tag', require\('\.\.\/services\/search-robots'\)\.NOINDEX\)/, file);
  }
});

test('a new app says it was made on Homeroom, in a tag only browsers and crawlers read', () => {
  const files = template.getTemplateFiles('Demo', { slug: 'demo-1' });
  const index = (Array.isArray(files) ? files : Object.values(files)).find((f) => f.path === 'public/index.html').content;
  assert.match(index, /<meta name="generator" content="Homeroom">/);
});

test('the shell’s front page names one address; nothing else, and nothing on a staging copy', () => {
  const link = (over) => robots.shellCanonicalLink({ method: 'GET', path: '/', origin: 'https://app.onhomeroom.com', ...over });
  assert.equal(link(), '<https://app.onhomeroom.com/>; rel="canonical"');
  assert.equal(link({ method: 'HEAD' }), '<https://app.onhomeroom.com/>; rel="canonical"');
  assert.equal(link({ method: 'POST' }), null);
  assert.equal(link({ path: '/app/some-project' }), null, 'a project page carries its own');
  assert.equal(link({ path: '/invite/abc' }), null);
  assert.equal(link({ staging: true }), null);
  assert.equal(link({ origin: null }), null);
  assert.equal(link({ origin: 'https://evil.example/>; rel="x' }), null, 'only a plain origin is ever written into the header');
});

test('server.js sends that header ahead of the static handler, from the configured address and never the Host', async (t) => {
  const source = read('server.js');
  const at = source.indexOf('shellCanonicalLink(');
  assert.ok(at > 0, 'server.js asks for the front page’s canonical');
  assert.ok(at < source.indexOf("app.use(express.static(path.join(__dirname, 'public'), {"),
    'before express.static, which is what answers `/`');
  const call = source.slice(at, source.indexOf('});', at));
  assert.match(call, /origin: require\('\.\/src\/services\/app-identity-env'\)\.platformOrigin\(\)/);
  assert.doesNotMatch(call, /requestOrigin|req\.headers|req\.get\(|req\.hostname/, 'nothing request-derived names the address');

  // The same middleware, driven for real with a forged Host.
  const before = process.env.USERNODE_DOMAIN;
  t.after(() => { if (before === undefined) delete process.env.USERNODE_DOMAIN; else process.env.USERNODE_DOMAIN = before; });
  const app = express();
  app.use((req, res, next) => {
    const value = robots.shellCanonicalLink({
      method: req.method, path: req.path, origin: platformOrigin(), staging: false,
    });
    if (value) res.setHeader('Link', value);
    next();
  });
  app.get('*', (req, res) => res.send('shell'));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const get = (p, headers = {}) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p, headers }, (res) => { res.resume(); resolve(res.headers.link || null); })
      .on('error', reject);
  });
  try {
    process.env.USERNODE_DOMAIN = 'app.example.com';
    assert.equal(await get('/?report=app'), '<https://app.example.com/>; rel="canonical"');
    assert.equal(await get('/', { host: 'evil.example', 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'http' }),
      '<https://app.example.com/>; rel="canonical"', 'a forged Host or X-Forwarded-Host changes nothing');
    assert.equal(await get('/app/some-project'), null);
    delete process.env.USERNODE_DOMAIN;
    assert.equal(await get('/', { host: 'evil.example', 'x-forwarded-host': 'evil.example' }), null,
      'no configured address: no header, never the request’s');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('the shared asset server marks everything it sends noindex', () => {
  const source = read('scripts/serve-platform-assets.js');
  assert.match(source, /require\('\.\.\/src\/services\/search-robots'\)/);
  // Its three ways out: send(), the streamed 200, and a sleeping preview's page.
  assert.equal(source.split("'X-Robots-Tag': searchRobots.NOINDEX").length - 1, 3);
});

test('the gate asks the same module, after the app has answered', () => {
  const source = read('scripts/app-gate.js');
  assert.match(source, /searchRobots\.appHostRobots\(\{ host: req\.headers\.host, url: req\.url \}\)/);
  assert.match(source, /searchRobots\.withRobots\(headers\['x-robots-tag'\], robots\)/);
});

test('a public project’s page, its og:url and its sitemap entry are one address', () => {
  const preview = require('../src/services/project-preview');
  const { sitemapXml } = require('../src/routes/project-preview');
  const origin = 'https://app.onhomeroom.com';
  const app = { slug: 'crabtopia-92bdbe', name: 'Crabtopia', description: 'A crab town.' };
  const address = preview.pageUrl(origin, app.slug);
  const tags = preview.previewTags(app, origin);
  assert.ok(tags.includes(`<link rel="canonical" href="${address}">`));
  assert.ok(tags.includes(`<meta property="og:url" content="${address}">`));
  assert.ok(sitemapXml(origin, [app]).includes(`<loc>${address}</loc>`));
  // The hidden record names it too, and all three follow the configured
  // origin when the request came with another Host; pictures stay put.
  const record = (html) => JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1].replace(/\\u003c/g, '<'));
  assert.equal(record(tags).url, address);
  const asked = preview.previewTags(app, 'https://forged.example', { canonical: origin });
  assert.ok(asked.includes(`<link rel="canonical" href="${address}">`));
  assert.ok(asked.includes(`<meta property="og:url" content="${address}">`));
  assert.equal(record(asked).url, address);
  assert.equal(record(asked).isPartOf.url, `${origin}/`);
  assert.equal((asked.match(/forged\.example\/app\//g) || []).length, 0, 'no second address for the page');
  assert.match(asked, /og:image" content="https:\/\/forged\.example\//);
  // Not an origin: ignored, never written into the page.
  const odd = preview.previewTags(app, origin, { canonical: 'https://evil.example/"><x' });
  assert.ok(odd.includes(`<link rel="canonical" href="${address}">`));
  assert.doesNotMatch(odd, /evil\.example/);
});

// The starter app's canonical, run as the generated server runs it: the two
// snippets are cut out of the generated file and evaluated with a request.
function starterCanonical({ slug, platformOrigin: origin, host, path: reqPath, forwardedHost }) {
  const files = template.getTemplateFiles('Demo', { slug: 'demo-1' });
  const server = (Array.isArray(files) ? files : Object.values(files)).find((f) => f.path === 'server.js').content;
  const hosts = server.match(/const CANONICAL_HOSTS = [\s\S]*?\}\)\(\);/);
  const send = server.match(/const pageHost = [\s\S]*?rel="canonical"'\);\n  \}/);
  assert.ok(hosts && send, 'the generated server has both halves');
  const run = new Function('APP_SLUG', 'PLATFORM_ORIGIN', 'req', 'res', `${hosts[0]}\n${send[0]}`);
  let link = null;
  run(slug, origin, { headers: { host, 'x-forwarded-host': forwardedHost }, path: reqPath }, { set: (name, value) => { if (name === 'Link') link = value; } });
  return link;
}

test('the starter app names its own address without the query string, and only at its own address', () => {
  const hosted = { slug: 'viatales-125912', platformOrigin: 'https://app.onhomeroom.com', path: '/read/12' };
  assert.equal(starterCanonical({ ...hosted, host: 'viatales-125912.onhomeroom.com' }),
    '<https://viatales-125912.onhomeroom.com/read/12>; rel="canonical"', 'the platform has a name of its own: apps sit under its parent');
  assert.equal(starterCanonical({ ...hosted, host: 'VIATALES-125912.onhomeroom.com' }),
    '<https://viatales-125912.onhomeroom.com/read/12>; rel="canonical"');
  assert.equal(starterCanonical({ slug: 'x', platformOrigin: 'https://homeroom.example', host: 'x.homeroom.example', path: '/' }),
    '<https://x.homeroom.example/>; rel="canonical"', 'apps beside the platform');

  // Anything else gets no canonical at all.
  assert.equal(starterCanonical({ ...hosted, host: 'evil.example' }), null, 'a forged Host');
  assert.equal(starterCanonical({ ...hosted, host: 'evil.example', forwardedHost: 'viatales-125912.onhomeroom.com' }), null,
    'X-Forwarded-Host is never read');
  assert.equal(starterCanonical({ ...hosted, host: 'viatales-125912.onhomeroom.com.evil.example' }), null);
  assert.equal(starterCanonical({ ...hosted, host: 'other-app.onhomeroom.com' }), null, 'another app’s address');
  assert.equal(starterCanonical({ ...hosted, host: 'viatales-125912--s77.onhomeroom.app' }), null, 'a preview');
  assert.equal(starterCanonical({ ...hosted, host: 'tales.example.org' }), null, 'a custom domain: the app sets its own');
  assert.equal(starterCanonical({ ...hosted, host: 'viatales-125912.onhomeroom.com', path: '/a>; rel="x' }), null,
    'a path that could break out of the header');
  assert.equal(starterCanonical({ ...hosted, platformOrigin: '', host: 'viatales-125912.onhomeroom.com' }), null,
    'outside the platform: no address is known');
  assert.equal(starterCanonical({ ...hosted, slug: 'Bad_Slug.evil', host: 'Bad_Slug.evil.onhomeroom.com' }), null);
});

test('the conventions say it: a canonical without state or paging parameters, no per-visitor state in URLs, API routes noindex', () => {
  const doc = read('src/prompts/app-conventions.md');
  const at = doc.indexOf('### Search engines: one address per page');
  assert.ok(at > 0);
  const section = doc.slice(at, doc.indexOf('\n## Database', at));
  assert.match(section, /carries a\s+canonical without it/);
  assert.match(section, /Never put per-visitor state in a URL a crawler can follow/);
  assert.match(section, /API routes are never pages/);
  assert.match(section, /Do not block these URLs in `robots\.txt`/);
  assert.match(section, /Never write the request's host into a canonical/);
  assert.match(section, /only when the request's `Host` is exactly one of\s+them/);
  assert.ok(section.length < 2200, 'kept short: it is read on every build');
});
