// Forwarder snippet injected into every scaffolded app's public/index.html.
// Captures console.log/info/warn/error/debug + uncaught errors +
// unhandled promise rejections and posts them to `window.parent` via
// postMessage. The Usernode platform shell listens for these to power
// the in-app developer console (header icon + log panel).
//
// Existing apps (created before this feature) won't have this block. The
// easiest fix is to paste this `<script>` near the top of `<body>` in
// public/index.html — or ask the coding agent in dev chat.
// Sentinel: usernode-dev-console@1 (keep this marker so updates/tooling
// can locate and replace the block in the future).
const DEV_CONSOLE_FORWARDER = `
  <script>
  // usernode-dev-console@1
  (function () {
    if (window.__usernodeDevConsole) return;
    window.__usernodeDevConsole = true;
    var S = '__usernodeDevConsole';
    function serialize(v, depth) {
      depth = depth || 0;
      try {
        if (v === undefined) return 'undefined';
        if (v === null) return 'null';
        if (typeof v === 'string') return v;
        if (typeof v === 'number' || typeof v === 'boolean') return String(v);
        if (typeof v === 'function') return '[Function ' + (v.name || 'anonymous') + ']';
        if (v instanceof Error) return (v.stack || (v.name + ': ' + v.message));
        if (depth > 3) return '[…]';
        var seen = new WeakSet();
        return JSON.stringify(v, function (k, val) {
          if (typeof val === 'object' && val !== null) {
            if (seen.has(val)) return '[Circular]';
            seen.add(val);
          }
          if (typeof val === 'function') return '[Function ' + (val.name || 'anonymous') + ']';
          if (val instanceof Error) return val.stack || (val.name + ': ' + val.message);
          return val;
        });
      } catch (e) { try { return String(v); } catch (_) { return '[unserializable]'; } }
    }
    function post(level, args, meta) {
      try {
        var payload = {
          sentinel: S,
          level: level,
          args: Array.prototype.slice.call(args).map(function (a) { return serialize(a); }),
          ts: Date.now(),
          url: location.href,
        };
        if (meta) for (var k in meta) payload[k] = meta[k];
        if (window.parent && window.parent !== window) {
          window.parent.postMessage(payload, '*');
        }
      } catch (_) {}
    }
    ['log','info','warn','error','debug'].forEach(function (level) {
      var orig = console[level] ? console[level].bind(console) : function () {};
      console[level] = function () { post(level, arguments); orig.apply(null, arguments); };
    });
    window.addEventListener('error', function (e) {
      var msg = (e.error && (e.error.stack || e.error.message)) || e.message || 'Error';
      post('error', [msg], { source: e.filename || '', line: e.lineno || 0, col: e.colno || 0, kind: 'error' });
    });
    window.addEventListener('unhandledrejection', function (e) {
      var r = e.reason;
      var msg = (r && (r.stack || r.message)) || String(r);
      post('error', [msg], { kind: 'unhandledrejection' });
    });
    try { post('info', ['[dev-console ready]'], { kind: 'ready' }); } catch (_) {}
  })();
  </script>`;

// Resolved at module-load: which Usernode platform domain do we
// inject into scaffolded apps? Apps need to point users back to the
// platform that hosts them (the "Open in Usernode" landing page) and
// reference its `/claude.md` URL. Driven by USERNODE_DOMAIN env so a
// fork running at a different domain templates the right URL into its
// child apps. Fallback is the canonical standalone deploy.
const PLATFORM_DOMAIN = process.env.USERNODE_DOMAIN || 'social-vibecoding.usernodelabs.org';
const PLATFORM_BASE_URL = `https://${PLATFORM_DOMAIN}`;

// The hosted connector's canonical name and the read-only allow rules built
// from it, taken from the one place that defines them so a scaffolded repo
// can never drift from the server that answers those calls. See #1218 and
// the long note in services/mcp-connect-constants.js.
const {
  SERVER_NAME: CONNECTOR_SERVER_NAME,
  READ_ONLY_ALLOW_RULES: CONNECTOR_ALLOW_RULES,
} = require('./mcp-connect-constants');

// The `.claude/` scaffold, on its own so every path that creates a repo can
// place it — not just the one that writes the whole template.
//
// A fresh create gets these through getTemplateFiles() below. An IMPORT of an
// existing repo and a FORK of another app never called getTemplateFiles() at
// all, so before #1218's follow-up neither ended up with the allow rules, and
// their users kept getting a prompt per read forever. Both now call this.
//
// It is the single source of the two entries: getTemplateFiles() spreads the
// result rather than repeating it, so a create, an import and a fork cannot
// scaffold three different `.claude/` directories.
function getConnectorScaffoldFiles() {
  return [
    {
      // Project-level Claude Code settings. #1218: every hosted-connector
      // call used to raise its own permission prompt, read-only ones
      // included, and in a Claude Code WEB session the grant does not
      // survive the container — so the same prompts came back next
      // session, for every user, and the calls that genuinely deserve a
      // confirmation drowned in the noise.
      //
      // An MCP server cannot reduce its own prompting, and should not be
      // able to. Prompt reduction is client-side, via `permissions.allow`
      // rules — so the platform ships them where every user of every app
      // picks them up with no setup: the repo it scaffolds.
      //
      // Three entries, NOT `mcp__${CONNECTOR_SERVER_NAME}__*`, and the
      // reason is the scaffold rather than the tools: this file is committed
      // into every app repo, and "every call this connector can make" is not
      // something a repo should grant on a stranger's machine on their
      // behalf. Reads are reviewable in the trust dialog; the rest is the
      // user's own call, on their own account.
      //
      // JSON has no comments, so the reasoning lives in .claude/README.md
      // next to it.
      path: '.claude/settings.json',
      content: `${JSON.stringify({ permissions: { allow: CONNECTOR_ALLOW_RULES } }, null, 2)}\n`,
    },
    {
      path: '.claude/README.md',
      content: `# \`.claude/\` — Claude Code settings for this repo

## Why \`settings.json\` is here

This app is built on **Usernode**, and Usernode has a hosted MCP connector
that Claude and ChatGPT can talk to. Without an allow rule, Claude Code asks
permission on **every** connector call — including read-only ones like
\`whoami\`, \`get_proposal\` and \`list_requests\`. In a Claude Code web session
that grant does not persist, so the prompts come back next session. The
calls that genuinely deserve a confirmation — \`submit_work\` puts a change to
a group vote — end up buried in that noise and approved by reflex.

\`settings.json\` allows the read-only connector calls and **nothing else**:

\`\`\`json
${JSON.stringify({ permissions: { allow: CONNECTOR_ALLOW_RULES } }, null, 2)}
\`\`\`

Deliberately not \`mcp__${CONNECTOR_SERVER_NAME}__*\`. This file is committed
into the repo, so it grants on behalf of everyone who opens it — and "every
call this connector can make" is not something one repo should decide for a
stranger's machine. These three entries can only ever match reads.

If you want the acting calls (\`submit_work\`, \`create_request\`,
\`prepare_work\`, \`start_platform_build\`, \`submit_platform_build\`) allowed
too, grant that on your own account rather than here — set the connector to
allow-always in Claude's connector settings, or add the rules to your own
\`~/.claude/settings.json\`, where the decision covers your machine only.

## You will still see one trust dialog

\`permissions.allow\` rules in a project's \`.claude/settings.json\` grant
capability, so Claude Code applies them only after you accept the
**workspace trust dialog** for this workspace. Until then it reads the rules
but does not apply them. The dialog lists the rules, so you can review them
before accepting. One reviewable consent instead of dozens of per-call
prompts is the whole trade — and a repo silently granting a connector
permission on your behalf is exactly what that check exists to prevent.

## If you are still being prompted

The server segment of a permission rule is a **literal** — \`mcp__*__get_*\`
is not a thing — so these rules only match a connector named exactly
\`${CONNECTOR_SERVER_NAME}\` or \`Usernode\` — the two spellings the shipped
list covers. Claude.ai's "Add custom connector" dialog takes
whatever **name you type**, and a rule aimed at a different one fails
silently: no error, you just keep getting prompted.

**Read the name off your own tool list rather than trusting this file.** The
tool names you actually see are either \`mcp__<server>__whoami\` or
\`mcp__claude_ai_<server>__whoami\` — the prefix differs by surface. Copy the
\`<server>\` segment you see and edit the rules to match, or reconnect
the connector naming it \`${CONNECTOR_SERVER_NAME}\` exactly.

## Adding your own rules

This file is yours — add project rules alongside the connector ones. Just
keep the connector entries narrow: never widen them to a whole-server
wildcard, for the version reason above.

To stop the prompts in **every** repo at once rather than one at a time, put
the same rules under \`permissions.allow\` in your personal
\`~/.claude/settings.json\`. Usernode's Settings → Connectors page has the
exact block, a copy button, and a field that rewrites the rules for a
connector registered under some other name.
`,
    },
  ];
}

function getTemplateFiles(appName, slug, dbUrl) {
  return [
    {
      path: 'CLAUDE.md',
      content: `# ${appName} — notes for Claude Code

This app runs on **Usernode Social Vibecoding**. If you're Claude Code
editing this repo, read the platform conventions before making
changes:

**Platform conventions (authoritative, always current):**
${PLATFORM_BASE_URL}/claude.md

Fetch that URL at the start of each session — it's the single source
of truth for platform-wide behavior (auth model, \`USERNODE_ENV\`,
public/private tables, "don't \`git push\`", etc.). The hosted copy is
updated in place when platform rules change, so fetching it gives you
today's rules, not a stale snapshot.

When running inside Usernode's dev-chat, those same conventions are
already injected into your system prompt, so the fetch is a no-op in
that path — but it's the right reflex when someone runs Claude Code
against this repo locally or from another harness.

## Connector permission prompts

This repo ships \`.claude/settings.json\`, which allows the **read-only**
Usernode connector calls (\`mcp__${CONNECTOR_SERVER_NAME}__get_*\`,
\`…__list_*\`, \`…__whoami\`) so they stop prompting one at a time. Everything
that acts — filing a request, opening or advancing a proposal — still asks.
Claude Code applies those rules only after you accept the
workspace trust dialog, which lists them for review. See \`.claude/README.md\`
for the whole story, including what to do if you are still being prompted
(usually: your connector is registered under a different name than the rules
assume).

If a rule below this line conflicts with the hosted conventions, the
hosted conventions win. This file is **app-specific** — write down
things about *this* app that belong in the repo: product intent,
data-model quirks, style preferences, opt-in policies (e.g. which
tables you've marked private), etc.

---

## About ${appName}

_(add a sentence or two of product context here so Claude Code has a
shared understanding of what this app is for)_

## App-specific conventions

_(optional — e.g. "all currency values stored as integer cents, not
floats"; "the \`posts\` table is append-only"; "avoid adding new
dependencies"; etc.)_
`,
    },
    {
      path: 'package.json',
      content: JSON.stringify({
        name: slug,
        version: '1.0.0',
        private: true,
        description: appName,
        main: 'server.js',
        scripts: { start: 'node server.js' },
        dependencies: {
          express: '^4.21.0',
          pg: '^8.13.0',
          jsonwebtoken: '^9.0.2',
        },
      }, null, 2),
    },
    {
      path: 'Dockerfile',
      content: `# Stage 1 — compile this app's Tailwind stylesheet.
#
# Runs on every image build (production deploys AND staging previews), so
# public/tailwind.css is always generated from the markup in THIS commit.
# That is why there is no committed CSS artifact to keep in sync and no
# rebuild step for you to remember: add a class, push, it is in the next
# build. tailwindcss lives only in this stage, so the runtime image below
# stays exactly as small as it was.
FROM node:22-alpine AS css
WORKDIR /build
COPY tailwind.config.js ./
COPY styles ./styles
COPY public ./public
RUN npm install tailwindcss@3.4.17 --no-audit --no-fund \\
 && ./node_modules/.bin/tailwindcss \\
      -c tailwind.config.js -i styles/tailwind-input.css \\
      -o public/tailwind.css --minify

# Stage 2 — the app itself (unchanged apart from the one COPY at the end).
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY . .
# After COPY . . so the compiled stylesheet is not overwritten by the
# source tree (which deliberately does not contain one).
COPY --from=css /build/public/tailwind.css ./public/tailwind.css
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \\
  CMD wget -qO- http://localhost:3000/health || exit 1
CMD ["node", "server.js"]
`,
    },
    {
      path: 'tailwind.config.js',
      content: `// Tailwind config for this app's precompiled stylesheet.
//
// The Dockerfile's builder stage runs the Tailwind CLI over the globs below
// and writes public/tailwind.css, which public/index.html links as
// /tailwind.css. Nothing is committed — every image build regenerates it.
//
// To build it locally (optional; the image build does this for you):
//   npm install --no-save tailwindcss@3.4.17
//   npx tailwindcss -c tailwind.config.js -i styles/tailwind-input.css \\
//     -o public/tailwind.css --minify
module.exports = {
  // Every file that can contain a class name. Tailwind's extractor is a
  // regex over source text, so it finds class names written as whole
  // literals — including ones inside JS strings in these files.
  content: [
    './public/**/*.html',
    './public/**/*.js',
  ],

  // Classes this app builds dynamically (if it ever does) go here, since the
  // extractor cannot see them. Prefer whole literals in the markup instead.
  safelist: [],

  // Matches the <html class="dark"> in public/index.html: dark: variants key
  // off that class rather than the OS colour-scheme preference.
  darkMode: 'class',

  // Stops hover: styles sticking after a tap on touch screens. Required by
  // the usernode-native UI kit and harmless without it.
  future: { hoverOnlyWhenSupported: true },

  theme: { extend: {} },
  plugins: [],
};
`,
    },
    {
      path: 'styles/tailwind-input.css',
      content: `/* Input stylesheet for this app's Tailwind build.
 *
 * Deliberately OUTSIDE public/ so it is never served — the @tailwind lines
 * are build-time directives and mean nothing to a browser. The Dockerfile
 * compiles this to public/tailwind.css.
 *
 * "base" is the preflight layer (the cross-browser reset). Keep all three
 * layers, in this order; dropping base changes every heading, list and form
 * control.
 */
@tailwind base;
@tailwind components;
@tailwind utilities;
`,
    },
    {
      path: '.dockerignore',
      content: `.env
.env.*
.git
.claude
node_modules
`,
    },
    {
      // Per-app secrets manifest. Empty by default — apps that need
      // env vars beyond the platform-injected DATABASE_URL/
      // USERNODE_JWT_PUBLIC_KEY/USERNODE_APP_ID/PORT/USERNODE_ENV add
      // entries here. The Usernode platform
      // reads this on every deploy and refuses to start the container
      // if a required key has no stored value (see
      // src/services/app-secrets.js + app-manifest.js in the platform).
      //
      // Schema:
      //   {
      //     "secrets": [
      //       {
      //         "key": "MY_API_KEY",
      //         "description": "Human help text shown in the Secrets UI",
      //         "required": true,
      //         "private": true,   // encrypted at rest, redacted from
      //                            // API, and not propagated into
      //                            // staging (`sensitive: true` is
      //                            // accepted as a BC alias)
      //         "default": "..."   // applied if no stored value
      //       }
      //     ]
      //   }
      // Reserved keys (DATABASE_URL, USERNODE_JWT_PUBLIC_KEY,
      // USERNODE_APP_ID, JWT_SECRET, PORT, USERNODE_ENV,
      // USERNODE_MISSING_SECRETS) are managed by the platform and
      // can't appear in this list.
      path: 'dapp.json',
      content: JSON.stringify({ secrets: [] }, null, 2),
    },
    // The two `.claude/` entries come from the shared helper above, which an
    // import and a fork also call — see its note.
    ...getConnectorScaffoldFiles(),
    {
      path: 'server.js',
      content: `const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// The platform signs user-identity tokens with an RSA private key it never
// shares. Containers get only the PUBLIC half, so this app can verify who a
// user is but cannot mint an identity — and neither can any other app.
const JWT_PUBLIC_KEY = (process.env.USERNODE_JWT_PUBLIC_KEY || '')
  .replace(/\\\\n/g, '\\n');

// Tokens are minted for one app: the audience is this app's numeric id, so a
// token issued for a different app is rejected below rather than accepted as
// a valid user.
const APP_AUDIENCE = process.env.USERNODE_APP_ID
  ? 'usernode:app:' + process.env.USERNODE_APP_ID
  : null;

// Paths that stay open without authentication. Add a path here (and add it
// with \`app.get\`/\`app.post\` below) if you deliberately want it public.
// Everything else requires a valid platform-issued JWT.
const PUBLIC_API_PATHS = new Set(['/health']);

app.use(express.json());

// Verify platform-issued JWT if one was passed, then enforce auth on
// anything not explicitly marked public. The iframe adds \`?token=…\`
// on load; the frontend script forwards the token via \`x-usernode-token\`
// on subsequent fetches.
app.use((req, res, next) => {
  const token = req.query.token || req.headers['x-usernode-token'];
  if (token && JWT_PUBLIC_KEY && APP_AUDIENCE) {
    try {
      // Pin the algorithm, issuer and audience. Without \`algorithms\` a
      // caller could hand us an HS256 token signed with the public PEM
      // (which every app knows) and forge any user.
      const claims = jwt.verify(token, JWT_PUBLIC_KEY, {
        algorithms: ['RS256'],
        issuer: 'usernode',
        audience: APP_AUDIENCE,
      });
      // \`pur\` names what the token is for. Only user-identity tokens
      // authenticate a person here.
      if (claims && claims.pur === 'iframe') req.user = claims;
    } catch {}
  }

  // Static assets (CSS/JS/images) are always served; the API and the HTML
  // shell are gated so direct hits to the staging/prod subdomain don't
  // leak app data to the public internet.
  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    if (PUBLIC_API_PATHS.has(req.path)) return next();
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// The template ships no favicon file; index.html carries an inline SVG
// icon instead. Answer 204 here so anything that still probes
// /favicon.ico (older browsers, direct visits) doesn't fall through to
// the auth-gated catch-all and surface a 401 in the console on every
// fresh load.
app.get('/favicon.ico', (_req, res) => res.status(204).end());

// Button press
app.post('/api/press', async (req, res) => {
  try {
    await pool.query(\`
      INSERT INTO presses (user_id, username) VALUES ($1, $2)
    \`, [req.user.id, req.user.username]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Leaderboard
app.get('/api/leaderboard', async (_req, res) => {
  try {
    const { rows } = await pool.query(\`
      SELECT username, COUNT(*) as presses
      FROM presses
      GROUP BY username
      ORDER BY presses DESC
      LIMIT 50
    \`);
    res.json({ leaderboard: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

// HTML shell: serve the app if authenticated. Unauthenticated top-level
// visits (share links pasted into a browser — Sec-Fetch-Dest: document)
// are sent to the platform's chromeless view of this app, where the shell
// embeds it with a real token so the link just works. Every other
// tokenless case (iframe loads with an expired token, old browsers
// without Sec-Fetch-*) gets the "open in Usernode" landing page instead
// of a redirect, so the platform shell is never loaded INSIDE its own
// app iframe and stray visits still don't reveal the app.
app.get('*', (req, res) => {
  if (!req.user) {
    // Deep-link pass-through (platform #743): carry the visited
    // path+query into the chromeless view so share links land on the
    // shared screen, not Home. \`path\` must stay the FINAL fragment
    // param and its value goes verbatim (wire-encoded; the shell
    // validates relative-only before use). The character test keeps the
    // value attribute-safe for the landing anchor below — anything
    // unusual falls back to the bare link.
    const deepPath = /^\\/[A-Za-z0-9\\-._~!$&()*+,;=:@\\/%?]*$/.test(req.originalUrl)
      ? '?path=' + req.originalUrl : '';
    if (req.get('sec-fetch-dest') === 'document') {
      return res.redirect(302, '${PLATFORM_BASE_URL}/#app/${slug}/full' + deepPath);
    }
    return res.status(401).send(\`<!doctype html><meta charset=utf-8><title>Open in Usernode</title>
<body style="font-family:system-ui;background:#09090b;color:#e4e4e7;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
  <div style="max-width:24rem;padding:2rem;text-align:center">
    <h1 style="font-size:1.25rem;margin:0 0 0.5rem">Open this app inside Usernode</h1>
    <p style="color:#a1a1aa;font-size:0.9rem;margin:0 0 1.25rem">This page is served via the platform; direct visits aren't authenticated.</p>
    <a href="${PLATFORM_BASE_URL}/#app/${slug}/full\${deepPath}" style="display:inline-block;padding:0.5rem 1rem;background:#7c3aed;color:white;border-radius:0.5rem;text-decoration:none;font-size:0.9rem">Open in Usernode</a>
  </div>
</body>\`);
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function start() {
  await pool.query(\`
    CREATE TABLE IF NOT EXISTS presses (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  \`);
  app.listen(port, () => console.log(\`Listening on :\${port}\`));
}

start().catch(err => { console.error(err); process.exit(1); });
`,
    },
    {
      path: 'public/index.html',
      content: `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  ${DEV_CONSOLE_FORWARDER}
  <title>${escapeHtml(appName)}</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><circle cx='50' cy='50' r='45' fill='%237c3aed'/><circle cx='50' cy='50' r='18' fill='white'/></svg>">
  <!-- Tailwind, PRECOMPILED for this app (was cdn.tailwindcss.com's
       in-browser engine plus an inline tailwind.config here). The config
       moved to tailwind.config.js in the repo root; the Dockerfile's builder
       stage compiles it to public/tailwind.css on every image build, so the
       stylesheet is regenerated from THIS commit's markup every deploy and
       can never drift behind the code. ~7 KB of CSS instead of a ~400 KB
       engine, and no flash of unstyled content.
       Writing class names as whole literals is what keeps this working — a
       class assembled from fragments at runtime (e.g. "bg-" + tone + "-500")
       is invisible to the compiler. If you genuinely need runtime-generated
       classes, swap this link for the platform-hosted engine instead:
       <script src="${PLATFORM_BASE_URL}/usernode-tailwind/v1/tailwind.js"></script> -->
  <link rel="stylesheet" href="/tailwind.css">
</head>
<body class="bg-zinc-950 text-zinc-100 min-h-screen flex flex-col items-center justify-center gap-8 p-4">
  <h1 class="text-2xl font-bold">${escapeHtml(appName)}</h1>

  <button id="press-btn" class="w-32 h-32 rounded-full bg-violet-600 hover:bg-violet-500 active:scale-95 transition-all text-white text-xl font-bold shadow-lg shadow-violet-600/30">
    Press!
  </button>

  <div id="count" class="text-lg text-zinc-400">0 total presses</div>

  <div class="w-full max-w-sm">
    <h2 class="text-sm font-medium text-zinc-500 mb-2 text-center">Leaderboard</h2>
    <div id="leaderboard" class="space-y-1"></div>
  </div>

  <script>
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token') || '';
    const headers = token ? { 'x-usernode-token': token } : {};

    async function loadLeaderboard() {
      const res = await fetch('/api/leaderboard', { headers });
      if (!res.ok) return;
      const { leaderboard } = await res.json();
      const el = document.getElementById('leaderboard');
      if (!leaderboard.length) {
        el.innerHTML = '<p class="text-center text-zinc-600 text-sm">No presses yet</p>';
        return;
      }
      el.innerHTML = leaderboard.map((r, i) =>
        '<div class="flex justify-between px-3 py-1 rounded ' + (i === 0 ? 'bg-violet-600/20 text-violet-300' : 'text-zinc-400') + '">' +
        '<span>' + (i + 1) + '. ' + r.username + '</span>' +
        '<span class="font-mono">' + r.presses + '</span></div>'
      ).join('');
      const total = leaderboard.reduce((s, r) => s + parseInt(r.presses), 0);
      document.getElementById('count').textContent = total + ' total presses';
    }

    document.getElementById('press-btn').addEventListener('click', async () => {
      try {
        const res = await fetch('/api/press', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...headers },
        });
        if (res.ok) loadLeaderboard();
        else if (res.status === 401) document.getElementById('count').textContent = 'Sign in to press!';
      } catch {}
    });

    loadLeaderboard();
  </script>
</body>
</html>
`,
    },
  ];
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

module.exports = { getTemplateFiles, getConnectorScaffoldFiles };
