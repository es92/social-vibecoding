'use strict';

// The fixed list of app kinds, and the lenient reader for dapp.json's
// optional top-level `category` (#3962, #6585).
//
// This lives in a module of its own, and requires nothing, because
// services/template.js writes a category into every new project and
// scripts/security-starter.js loads template.js in the starter image with
// only the starter's packages installed. app-manifest.js pulls in
// server-only modules (through services/ui-telemetry.js and services/logger),
// so template.js must not import it just to know the keys. app-manifest.js
// re-exports both names, so its callers never changed.
//
// The list is the source of truth for the chips' keys and order. The
// client's copies are frontend/src/features/guest/guest-data.ts CATEGORIES,
// which tests/guest-discover.test.js pins to this list, and the chip labels
// in frontend/locales/en/auth.json (`guest.category.*`). `other` is for an
// app that fits none of the kinds; it is what a new project's dapp.json
// starts with when nothing better is known, a line its group can change by
// proposal like any other.

const APP_CATEGORIES = Object.freeze([
  'games', 'social', 'tools', 'learning', 'creative', 'money', 'health', 'food', 'other',
]);
const APP_CATEGORY_SET = new Set(APP_CATEGORIES);

// services/logger is required on the first unknown value, never at load, so
// this module stays loadable without the server's packages. The warn itself
// is the same one app-manifest.js always wrote for a typo.
let logger = null;
function warnIgnored(value) {
  if (logger === null) {
    try {
      logger = require('./logger');
    } catch {
      logger = false;
    }
  }
  if (logger) logger.warn('app-manifest', 'Ignoring unknown category', { value });
}

// Normalize `"category": "games"`. Lenient like `visibility` and
// `screenshot`: case and surrounding space are forgiven, and anything else
// (an unknown word, a list, a number) is ignored with a warn and reads as
// null, which is the same as saying nothing: the app is listed under All
// types only. Never throws, so a typo never fails a deploy.
//
// `other` is a real key the reader keeps, but it means "not chosen": the
// public directory sorts such an app by the kind it worked out from its name
// and description (services/app-category.js), so Other keeps only the apps
// nothing else fits.
function readCategory(parsed) {
  const raw = parsed?.category;
  if (raw == null) return null;
  const key = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (APP_CATEGORY_SET.has(key)) return key;
  warnIgnored(raw);
  return null;
}

module.exports = {
  APP_CATEGORIES,
  readCategory,
};
