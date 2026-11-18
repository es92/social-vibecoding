// A LIST payload's copy of each proposal's check results: the checks that did
// not pass, and a count of the ones that did.
//
// Why this exists: `test_results` holds one row per declared check, and the
// platform's own dapp.json declares 800+. Every proposal row in the
// Workshop's lists carried all of them — measured on production, GET
// /api/apps/:slug/promoted was 1.9 MB for 8 open proposals and /merged 5.1 MB
// for its first 20, 97% of it passing rows, and /shared-sessions and the
// imported rows of /api/me/active-sessions carried the same. Opening the
// Workshop, or any item in it, downloaded all of that before the page could
// settle, for cards whose only use of the list is to count and name the
// failures ("Checks failing · 3", the merge-status line, the requirements
// detail).
//
// The one reader of the passing rows is the checks verdict on an item's own
// page (AppView._checksVerdictView), and it lists them only inside the
// "N passing" fold. So the item's own row (GET /api/apps/:slug/proposals/:id,
// /api/sessions/:id/details) comes in the same form (`forItem`) — on
// production a proposal's row was 265 KB, 255 KB of it the names of checks
// that passed — and the verdict counts the passes in `test_results_omitted`.
// Opening the fold reads the row once more without the flag
// (AppView._loadCheckNames), so the names arrive when someone asks for them.
//
// Opt-in, by `?results=failing`, so every other reader of these endpoints —
// the CLI, the connector, an agent reading /promoted — still gets the whole
// list exactly as before. The shell asks for the list form.
function wantsFailingResults(req) {
  return !!(req && req.query && req.query.results === 'failing');
}

// A shallow copy of `row` with its passing results dropped and counted.
// A row with no results, or none passing, comes back unchanged.
function failingResultsOnly(row) {
  if (!row || typeof row !== 'object' || !Array.isArray(row.test_results)) return row;
  const kept = row.test_results.filter((r) => !(r && r.status === 'pass'));
  const omitted = row.test_results.length - kept.length;
  if (!omitted) return row;
  // The few passes with something to say stay readable beside the count,
  // in a field of their own so the count of omitted passes stays the whole
  // count: one that passed only on a retry (and why: the run's fault or
  // the check's), and one this proposal adds or changes that needed a
  // fresh load after its address change (services/check-signals.js). The
  // Checks step names them (AppView._checksVerdictView `noted`).
  const noted = row.test_results.filter(notedPass).slice(0, MAX_NOTED_PASSES);
  return {
    ...row, test_results: kept, test_results_omitted: omitted,
    ...(noted.length ? { test_results_noted: noted } : {}),
  };
}

const MAX_NOTED_PASSES = 20;
function notedPass(r) {
  return !!(r && r.status === 'pass' && (r.passedOnRetry || (r.cohortFallback && r.authored === true)));
}

// #3978: a failing unit-suite row carries its per-test excerpts (up to
// ~20 KB). The item's own row keeps them — the verdict's "Why it failed"
// fold and the connector read them there — but a LIST payload is counted
// and named only, so a board of failing proposals does not grow by every
// excerpt again. Stripped here, in the list projection, not inside
// failingResultsOnly: forItem reuses that to shed passing rows and must
// keep the failing ones intact.
const DETAIL_FIELDS = ['failureDetails', 'failureDetailsTruncated'];
function withoutFailureDetails(row) {
  if (!row || typeof row !== 'object' || !Array.isArray(row.test_results)) return row;
  if (!row.test_results.some((r) => r && (r.failureDetails || r.failureDetailsTruncated))) return row;
  return {
    ...row,
    test_results: row.test_results.map((r) => {
      if (!r || !(r.failureDetails || r.failureDetailsTruncated)) return r;
      const copy = { ...r };
      delete copy.failureDetails;
      delete copy.failureDetailsTruncated;
      return copy;
    }),
  };
}

// ── #6793: the list form, made in the database ─────────────────────────
//
// The filter above ran in JavaScript, after Postgres had sent every passing
// row and node had parsed it: 800+ rows a proposal, on the event loop, for a
// list that keeps a handful. The list's own queries now ask Postgres for the
// list form: one pass over the array that keeps what did not pass (without
// its excerpts), counts what did, and sets aside the noted passes and the
// unit suite's own row.
//
// `listedResultsSql(alias)` is that SELECT fragment. It yields two columns:
// `test_results_listed` ({ kept, omitted, noted, unit }) for an array, and
// `test_results`, which is NULL for an array and the stored value for
// anything else (so a malformed column reads as it always did).
// `unpackListed(rows)` then gives each row the same fields
// failingResultsOnly + withoutFailureDetails would have: `test_results`,
// `test_results_omitted` when something passed, `test_results_noted` when a
// pass has something to say. The unit suite's row is kept beside them as
// `test_results_unit_row` for the server alone (listedRowForServer): the
// merge requirements ask whether that suite passed, and a passing row is
// exactly what the list form leaves out.
const { UNIT_CHECK_NAME, UNIT_CHECK_PATH, UNIT_CHECK_INDEX } = require('./unit-suite-row');

const sqlText = (value) => `'${String(value).replace(/'/g, "''")}'`;
// JavaScript truthiness of a JSON value, in SQL.
const sqlTruthy = (expr) => `COALESCE(${expr} NOT IN ('false'::jsonb, 'null'::jsonb, '0'::jsonb, '""'::jsonb), false)`;

function listedResultsSql(alias) {
  const col = `${alias}.test_results`;
  const passed = `(e.v->>'status' = 'pass')`;
  const noted = `(${passed} AND (${sqlTruthy("e.v->'passedOnRetry'")}
                 OR (${sqlTruthy("e.v->'cohortFallback'")} AND e.v->'authored' = 'true'::jsonb)))`;
  const unit = `(jsonb_typeof(e.v) = 'object' AND (e.v->'index' = '${UNIT_CHECK_INDEX}'::jsonb
                 OR (e.v->>'name' = ${sqlText(UNIT_CHECK_NAME)} AND e.v->>'path' = ${sqlText(UNIT_CHECK_PATH)})))`;
  return `CASE WHEN jsonb_typeof(${col}) = 'array' THEN (
             SELECT jsonb_build_object(
               'kept', COALESCE(jsonb_agg(
                   CASE WHEN jsonb_typeof(e.v) = 'object'
                        THEN e.v - 'failureDetails' - 'failureDetailsTruncated' ELSE e.v END
                   ORDER BY e.n) FILTER (WHERE ${passed} IS NOT TRUE), '[]'::jsonb),
               'omitted', count(*) FILTER (WHERE ${passed}),
               'noted', jsonb_agg(e.v ORDER BY e.n) FILTER (WHERE ${noted}),
               'unit', (jsonb_agg(e.v - 'failureDetails' - 'failureDetailsTruncated' ORDER BY e.n) FILTER (WHERE ${unit}))->0)
               FROM jsonb_array_elements(${col}) WITH ORDINALITY AS e(v, n)
           ) END AS test_results_listed,
           CASE WHEN jsonb_typeof(${col}) = 'array' THEN NULL ELSE ${col} END AS test_results`;
}

// What a list's query selects for the check results: the list form when the
// request asked for it, the stored column otherwise.
function resultsSelect(req, alias) {
  return wantsFailingResults(req) ? listedResultsSql(alias) : `${alias}.test_results`;
}

// Rows read with listedResultsSql, given the list form's fields. A row read
// without it is left alone.
function unpackListed(rows) {
  if (!Array.isArray(rows)) return rows;
  for (const row of rows) {
    if (!row || typeof row !== 'object' || !('test_results_listed' in row)) continue;
    const listed = row.test_results_listed;
    delete row.test_results_listed;
    if (!listed || typeof listed !== 'object') continue;
    row.test_results = Array.isArray(listed.kept) ? listed.kept : [];
    const omitted = Number(listed.omitted) || 0;
    if (omitted) row.test_results_omitted = omitted;
    const noted = Array.isArray(listed.noted) ? listed.noted.slice(0, MAX_NOTED_PASSES) : [];
    if (omitted && noted.length) row.test_results_noted = noted;
    if (listed.unit && typeof listed.unit === 'object') row.test_results_unit_row = listed.unit;
  }
  return rows;
}

// A PAGED list reads the list form for its page alone. In a query that ends
// in ORDER BY and LIMIT, Postgres works a select-list subquery out for every
// row that matches before it sorts and cuts: with listedResultsSql in
// /merged's own SELECT, each read unpacked the check results of every merged
// change the project ever had, to keep twenty (measured on production with
// Server-Timing, 18 Nov 2026: 245 ms became about 1,050 ms). So the paged
// query selects LISTED_LATER in the column's place, and attachListed reads
// the list form by id for the rows that came back.
const LISTED_LATER = 'NULL::jsonb AS test_results';

// What a paged list's query selects for the check results.
function pagedResultsSelect(req, alias) {
  return wantsFailingResults(req) ? LISTED_LATER : `${alias}.test_results`;
}

async function attachListed(pool, req, rows) {
  if (!wantsFailingResults(req) || !Array.isArray(rows) || !rows.length) return rows;
  const ids = [...new Set(rows.map((row) => Number(row && row.id)).filter((id) => Number.isInteger(id) && id > 0))];
  const byId = new Map();
  if (ids.length) {
    const { rows: listed } = await pool.query(
      `SELECT cs.id, ${listedResultsSql('cs')} FROM chat_sessions cs WHERE cs.id = ANY($1::int[])`,
      [ids]
    );
    for (const row of listed) byId.set(Number(row.id), row);
  }
  for (const row of rows) {
    const listed = row ? byId.get(Number(row.id)) : null;
    if (listed) {
      row.test_results_listed = listed.test_results_listed;
      row.test_results = listed.test_results;
    } else if (row && row.test_results == null) {
      // No stored row to read (a change deleted between the two reads).
      row.test_results = [];
    }
  }
  return unpackListed(rows);
}

// The row as a server reader that asks about the unit suite needs it
// (merge-requirements levelAndGreen): a passing suite's row, which the list
// form left out, is put back. Never sent.
function listedRowForServer(row) {
  const unit = row && row.test_results_unit_row;
  if (!unit || unit.status !== 'pass' || !Array.isArray(row.test_results)) return row;
  return { ...row, test_results: [unit, ...row.test_results] };
}

// What a list row carries that no list reader draws from: the merge record
// and the merged tree (the card reads `mergeRequirements` and `integration`,
// derived before this), and the whole shots record, of which a card reads
// one fact, whether the change has anything visible.
function slimListRow(row) {
  if (!row || typeof row !== 'object') return row;
  const copy = { ...row };
  delete copy.test_results_unit_row;
  delete copy.integration_merged_tree;
  delete copy.merge_requirements;
  if ('shots_detail' in copy) {
    const impact = copy.shots_detail && typeof copy.shots_detail === 'object'
      && copy.shots_detail.intent && typeof copy.shots_detail.intent === 'object'
      ? copy.shots_detail.intent.impact : null;
    copy.shots_detail = typeof impact === 'string' ? { intent: { impact } } : null;
  }
  return copy;
}

// The rows as this request asked for them. `slim` (the board's own lists)
// also drops what no list reader draws from. The filter is idempotent on a
// row the database already trimmed, and still trims the ones it did not (the
// staging demo's rows).
function forListing(req, rows, opts = null) {
  if (!wantsFailingResults(req) || !Array.isArray(rows)) return rows;
  const slim = !!(opts && opts.slim);
  return rows.map((row) => withoutFailureDetails(failingResultsOnly(slim ? slimListRow(row) : row)));
}

// One item's row as this request asked for it. A row with only a few passing
// checks keeps them: the verdict lists up to this many without a fold
// (AppView.PASS_FOLD_AT), so there is no fold to open for the names.
const ITEM_PASSES_LISTED = 8;
function forItem(req, row) {
  if (!wantsFailingResults(req) || !row || !Array.isArray(row.test_results)) return row;
  const passing = row.test_results.filter((r) => r && r.status === 'pass').length;
  return passing > ITEM_PASSES_LISTED ? failingResultsOnly(row) : row;
}

module.exports = {
  notedPass,
  MAX_NOTED_PASSES,
  wantsFailingResults,
  failingResultsOnly,
  withoutFailureDetails,
  forListing,
  listedResultsSql,
  resultsSelect,
  pagedResultsSelect,
  attachListed,
  LISTED_LATER,
  unpackListed,
  listedRowForServer,
  slimListRow,
  forItem,
  ITEM_PASSES_LISTED,
};
