'use strict';

// Open requests that look like the one somebody is about to file. When the
// bot offers to file a request (the DM chat's offer_request, a thread's), it
// names the project's open requests whose titles share most of their words
// with the new one, so it can offer to add the person's words to that request
// instead of a second copy for the group to sort out. It only says so: File
// it stays theirs to tap.
//
// Cheap on purpose: titles only, from the board the platform already caches
// (github.fetchPublicIssues, five minutes per repository), and plain words
// rather than a model. A title shares a word when both say it; a request
// looks the same when at least two of its words are shared and they are most
// of the shorter title's.

const MIN_SHARED = 2;
const MIN_OVERLAP = 0.6;
const MAX_SIMILAR = 3;

// Words that say nothing about what a request is for.
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'into', 'onto', 'that', 'this', 'there', 'their', 'when', 'what', 'which',
  'should', 'would', 'could', 'can', 'will', 'please', 'add', 'make', 'let', 'lets', 'allow', 'show', 'new', 'more',
  'app', 'page', 'screen', 'button', 'feature', 'option', 'able', 'want', 'need', 'not', 'are', 'its', 'our', 'your',
  'yang', 'dan', 'untuk', 'dengan', 'dari', 'agar', 'bisa', 'tambah', 'tambahkan', 'fitur', 'ini', 'itu',
]);

/** A title's words: lower case, three letters or more, the plain ones left out, a plural's trailing s dropped. */
function titleWords(title) {
  const words = String(title || '').toLowerCase().normalize('NFKC').match(/[\p{L}\p{N}]+/gu) || [];
  const out = new Set();
  for (const word of words) {
    if (word.length < 3 || STOP_WORDS.has(word)) continue;
    out.add(word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word);
  }
  return out;
}

/**
 * Pure: the open requests in `issues` ({ number, title }) whose titles look
 * like `title`, closest first, at most `limit`. [] when the title has too few
 * words to tell.
 */
function similarRequests(issues, title, { limit = MAX_SIMILAR } = {}) {
  const mine = titleWords(title);
  if (mine.size < MIN_SHARED) return [];
  const scored = [];
  for (const issue of Array.isArray(issues) ? issues : []) {
    const number = Number(issue?.number);
    if (!Number.isInteger(number) || number <= 0) continue;
    const theirs = titleWords(issue.title);
    if (theirs.size < MIN_SHARED) continue;
    let shared = 0;
    for (const word of mine) if (theirs.has(word)) shared += 1;
    const overlap = shared / Math.min(mine.size, theirs.size);
    if (shared >= MIN_SHARED && overlap >= MIN_OVERLAP) scored.push({ number, title: String(issue.title || '').trim(), shared, overlap });
  }
  scored.sort((a, b) => b.overlap - a.overlap || b.shared - a.shared || b.number - a.number);
  return scored.slice(0, limit).map(({ number, title: t }) => ({ number, title: t }));
}

/**
 * The open requests on `app` that look like `title`, from its cached board.
 * Never throws; [] when the board cannot be read.
 */
async function openSimilar(app, title, { github = require('./github'), parseRepo = null } = {}) {
  try {
    const parse = parseRepo || require('./homeroom-bot').parseRepo;
    const repo = parse(app?.repo_url);
    if (!repo || typeof github.fetchPublicIssues !== 'function') return [];
    const { issues } = await github.fetchPublicIssues(repo.owner, repo.repo);
    return similarRequests(issues, title);
  } catch {
    return [];
  }
}

module.exports = {
  MAX_SIMILAR,
  similarRequests,
  openSimilar,
  titleWords,
};
