'use strict';

// server_errors: a route of Homeroom's API that keeps answering with a
// server error (platform signals, wave 2).
//
// Reads server_error_minutes, which every process fills from what it
// answered (services/server-error-counts.js): each 5xx by its route
// template, status, error type and first frame in this repository. One
// problem is one (method, route, status class, error type, frame's file)
// with at least MIN_ERRORS in the last hour; it clears when the hour holds
// fewer, and its request closes after the kind's quiet window (6 hours).
//
// The frame's FILE, not its line, is part of the problem's identity:
// Homeroom merges many times a day, and an edit above the throw moves its
// line, which would otherwise close one request and file the same bug
// again. The lines seen are in the evidence.
//
// Everything public here is typed: the route as Express declared it, the
// statuses, the error's constructor and code, counts, minutes and a
// `file:line`. The one scrubbed message a row keeps can still echo what a
// person sent, so the samples go to evidencePrivate only.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');

// At least this many in the last hour is a problem; fewer is a blip.
const MIN_ERRORS = 3;
const MAX_ITEMS = 50;

// Where a route's errors belong: the first prefix that matches, by whole
// segments, or infra. The prefixes are the routes' own (src/routes/).
const TOPIC_PREFIXES = Object.freeze([
  ['/api/auth', 'onboarding'],
  ['/api/me/first-session', 'onboarding'],
  ['/api/me/tour-done', 'onboarding'],
  ['/api/me/waitlist', 'onboarding'],
  ['/api/invite-links', 'onboarding'],
  ['/api/apps/:slug/first-version', 'onboarding'],
  ['/api/sessions', 'proposal-pipeline'],
  ['/api/me/proposals', 'proposal-pipeline'],
  ['/api/apps/:slug/proposals', 'proposal-pipeline'],
  ['/api/apps/:slug/proposal-handoffs', 'proposal-pipeline'],
  ['/api/apps/:slug/promoted', 'proposal-pipeline'],
  ['/api/apps/:slug/merged', 'proposal-pipeline'],
  ['/api/apps/:slug/changes', 'proposal-pipeline'],
  ['/api/apps/:slug/main-check', 'proposal-pipeline'],
  ['/api/apps/:slug/pr-import', 'proposal-pipeline'],
  ['/api/admin/homeroom-bot', 'homeroom-bot'],
  ['/api/apps/:slug/homeroom-bot', 'homeroom-bot'],
  ['/api/apps/:slug/my-bot-requests', 'homeroom-bot'],
  ['/api/bot-bench', 'homeroom-bot'],
  ['/api/bot-configs', 'homeroom-bot'],
]);

/** Pure: the topic a route's server errors are filed under. */
function topicOf(route) {
  const r = String(route || '');
  for (const [prefix, topic] of TOPIC_PREFIXES) {
    if (r === prefix || r.startsWith(`${prefix}/`)) return topic;
  }
  return 'infra';
}

// The file that declares each route: src/routes/ (its subfolders too) and
// server.js, scanned once, when first needed, for the routes they declare
// with a literal path (`router.get('/api/...'`, `app.post("/health"`):
// `METHOD path` -> its file. A route declared from a variable or a template
// is not found, and its frame alone says where. When two files declare the
// same route (a middleware on one path, say), the last one read is kept.
const ROUTE_DECLARATION = /\b(?:router|app)\.(get|post|put|patch|delete)\(\s*['"`](\/[^'"`]+)['"`]/g;

function routeSources() {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (entry.name.endsWith('.js')) files.push(rel);
    }
  };
  files.push('server.js');
  try { walk('src/routes'); } catch { /* no routes folder: server.js alone */ }
  return files;
}

let routeFiles = null;
function routeFileOf(method, route) {
  if (!routeFiles) {
    routeFiles = new Map();
    for (const file of routeSources()) {
      let text;
      try {
        text = fs.readFileSync(path.join(ROOT, file), 'utf8');
      } catch {
        continue; // unreadable: the frame alone says where
      }
      for (const m of text.matchAll(ROUTE_DECLARATION)) {
        routeFiles.set(`${m[1].toUpperCase()} ${m[2]}`, file);
      }
    }
  }
  return routeFiles.get(`${method} ${route}`) || null;
}

// A frame names a file in this repository, or it is not said: a frame is
// read from a stack, and only one this checkout has is worth sending the
// bot to.
function realFrame(frame) {
  const m = /^((?:src|worker|scripts|tools)\/[A-Za-z0-9_./-]+|server\.js):\d+$/.exec(String(frame || ''));
  if (!m || m[1].includes('..')) return null;
  try {
    return fs.statSync(path.join(ROOT, m[1])).isFile() ? frame : null;
  } catch {
    return null;
  }
}

const iso = (v) => (v ? new Date(v).toISOString().replace(/:\d{2}\.\d+Z$/, 'Z') : 'unknown');
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// One row per (method, route, status, error type, frame) that failed in the
// last hour, with its last 24 hours; the status class is folded below.
const ERRORS_SQL = `
  SELECT method, route, status, err_type, frame,
         COALESCE(SUM(count) FILTER (WHERE minute >= NOW() - interval '1 hour'), 0)::int AS last_hour,
         COALESCE(SUM(count), 0)::int AS last_day,
         MIN(minute) AS first_minute,
         MAX(minute) AS last_minute,
         ARRAY_AGG(DISTINCT pod) FILTER (WHERE minute >= NOW() - interval '1 hour') AS pods,
         (ARRAY_AGG(sample ORDER BY minute DESC)
            FILTER (WHERE sample IS NOT NULL AND minute >= NOW() - interval '1 hour'))[1:3] AS samples
    FROM server_error_minutes
   WHERE minute >= NOW() - interval '24 hours'
   GROUP BY method, route, status, err_type, frame
  HAVING SUM(count) FILTER (WHERE minute >= NOW() - interval '1 hour') > 0
   ORDER BY last_hour DESC
   LIMIT 500`;

const fileOf = (frame) => String(frame || '').replace(/:\d+$/, '');

/** Pure: the rows folded into problems, each with at least MIN_ERRORS in the hour. */
function groupRows(rows, { min = MIN_ERRORS } = {}) {
  const groups = new Map();
  for (const r of rows || []) {
    const status = Number(r.status) || 500;
    const frame = String(r.frame || '');
    const g = {
      method: String(r.method || 'GET'),
      route: String(r.route || '(unmatched)'),
      statusClass: Math.floor(status / 100),
      errType: String(r.err_type || ''),
      file: fileOf(frame),
    };
    const key = JSON.stringify([g.method, g.route, g.statusClass, g.errType, g.file]);
    let acc = groups.get(key);
    if (!acc) {
      acc = { ...g, lastHour: 0, lastDay: 0, statuses: new Set(), first: null, last: null, pods: new Set(), samples: [], frames: new Map() };
      groups.set(key, acc);
    }
    acc.lastHour += Number(r.last_hour) || 0;
    acc.lastDay += Number(r.last_day) || 0;
    acc.statuses.add(status);
    if (frame) acc.frames.set(frame, (acc.frames.get(frame) || 0) + (Number(r.last_hour) || 0));
    const first = r.first_minute ? new Date(r.first_minute).getTime() : null;
    const last = r.last_minute ? new Date(r.last_minute).getTime() : null;
    if (first != null && (acc.first == null || first < acc.first)) acc.first = first;
    if (last != null && (acc.last == null || last > acc.last)) acc.last = last;
    for (const p of r.pods || []) if (p) acc.pods.add(p);
    for (const s of r.samples || []) if (s && !acc.samples.includes(s) && acc.samples.length < 3) acc.samples.push(s);
  }
  return [...groups.values()]
    .filter((g) => g.lastHour >= min)
    .sort((a, b) => b.lastHour - a.lastHour)
    .map((g) => ({
      ...g,
      statuses: [...g.statuses].sort((a, b) => a - b),
      pods: [...g.pods].sort(),
      // Most of the hour's first: the line the running code throws at.
      frames: [...g.frames.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f),
    }));
}

/** Pure: one problem as a signal item. */
function itemOf(g) {
  const statuses = g.statuses.join(', ');
  const unmatched = g.route === '(unmatched)';
  const frames = g.frames.map(realFrame).filter(Boolean).slice(0, 3);
  const routeFile = routeFileOf(g.method, g.route);
  const where = [...new Set([...frames, routeFile].filter(Boolean))];
  const on = unmatched ? `${g.method} before any route answered` : `${g.method} ${g.route}`;
  return {
    kind: 'server_errors',
    key: `${g.method} ${g.route}:${g.errType}:${g.file}`,
    subject: { method: g.method, route: g.route, statusClass: g.statusClass, errType: g.errType, file: g.file },
    topic: topicOf(g.route),
    title: `Server errors on ${on}: ${g.errType || statuses}`,
    summary: `Homeroom's API answered ${unmatched ? `${g.method} requests` : `${g.method} ${g.route}`} with a server error `
      + `(${statuses}) ${plural(g.lastHour, 'time', 'times')} in the last hour, so whoever called it got an error `
      + 'instead of what they asked for.',
    occurrences: g.lastHour,
    evidence: {
      lines: [
        `${plural(g.lastHour, 'server error', 'server errors')} in the last hour, ${g.lastDay} in the last 24 hours.`,
        `${g.statuses.length === 1 ? 'Status' : 'Statuses'}: ${statuses}.`,
        `First in the last 24 hours at ${iso(g.first)}, the last at ${iso(g.last)} (by the minute).`,
        `From ${plural(g.pods.length, 'process', 'processes')} in the last hour.`,
        unmatched ? 'No route matched: a middleware threw before one could.' : null,
        g.errType
          ? `Error type: ${g.errType}${frames.length ? `, thrown at ${frames.join(', ')}` : ''}.`
          : 'The route answered the error itself (a catch block), so no error type or frame was recorded; '
            + 'its log line says what was caught.',
      ].filter(Boolean),
      where,
    },
    evidencePrivate: g.samples.length ? { samples: g.samples } : null,
  };
}

async function run(pool) {
  const { rows } = await pool.query(ERRORS_SQL);
  return groupRows(rows).slice(0, MAX_ITEMS).map(itemOf);
}

module.exports = {
  run,
  groupRows,
  itemOf,
  topicOf,
  routeFileOf,
  realFrame,
  ERRORS_SQL,
  MIN_ERRORS,
  TOPIC_PREFIXES,
};
