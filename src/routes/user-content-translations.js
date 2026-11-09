'use strict';

// #6081: translate a person's words into the reader's language, when the
// reader asks for it. The table and the model call are in
// services/user-content-translations.js; this is the one endpoint:
//
//   POST /api/translations  { texts: string[], language?: string, auto?: boolean }
//     -> { language, results: [{ state: 'translated'|'same'|'failed', text?, from? }] }
//
// At most two texts, each 1 to 8000 characters: a request's title and its
// words. Errors are a code the client can word itself, never English the page
// shows. Only a signed-in person may ask; each person's new translations are
// capped per day by the service, and the platform's system budget bounds it
// too. A cached translation still answers once either bound is reached.
//
// `auto: true` (#6525) is a chat translating itself as it comes into view. A
// bound that stops an automatic ask still answers 200 with a failed result per
// text, never 429/503: the browser records a failed load in its console, and
// turning the page must not read as a broken page. A tap keeps its status.

const { Router } = require('express');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const translations = require('../services/user-content-translations');

const MAX_PER_MINUTE = 30;

function userContentTranslationRoutes(config, deps = {}) {
  const router = Router();
  const pool = deps.pool || getPool(config);
  const service = deps.service || translations;
  const ask = deps.translate || service.translate;
  const targetLanguage = deps.targetLanguage || service.targetLanguage;
  const languageOf = (req) => targetLanguage(req.body?.language, req.user, req.get('accept-language'),
    deps.source !== undefined ? { source: deps.source } : undefined);
  // #6525: a chat translating itself as it is read says so. A bound that
  // stops it is answered as a quiet, failed result per text rather than an
  // error status: the browser records a non-2xx response in its console, and
  // a page that simply cannot translate must not look broken. A tap keeps
  // its status, because its note says why (#6081).
  const isAuto = (req) => req.body?.auto === true;
  const quietMiss = (req, res, language) => {
    const texts = Array.isArray(req.body?.texts) ? req.body.texts : [];
    return res.json({ language, results: texts.map(() => ({ state: 'failed' })) });
  };

  const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: MAX_PER_MINUTE,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => (req.user?.id ? `user:${req.user.id}` : ipKeyGenerator(req.ip)),
    handler: (req, res) => {
      log.warn('user-content-translations', 'Rate-limited', { userId: req.user?.id });
      if (isAuto(req)) return quietMiss(req, res, languageOf(req));
      res.status(429).json({ error: 'rate_limited' });
    },
  });

  const signedIn = (req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    if (!req.user?.id) return res.status(401).json({ error: 'sign_in_required' });
    return next();
  };

  router.post('/api/translations', signedIn, limiter, async (req, res) => {
    const texts = req.body?.texts;
    if (!Array.isArray(texts) || texts.length < 1 || texts.length > service.MAX_TEXTS) {
      return res.status(400).json({ error: 'invalid_texts' });
    }
    if (texts.some((text) => typeof text !== 'string' || !text.trim() || text.length > service.MAX_TEXT)) {
      return res.status(400).json({ error: 'invalid_texts' });
    }

    const language = languageOf(req);

    let outcome;
    try {
      outcome = await ask(pool, { texts, language, userId: req.user.id }, {
        ...deps.deps,
        ...(deps.source !== undefined ? { source: deps.source } : {}),
      });
    } catch (err) {
      log.warn('user-content-translations', 'Could not translate', { userId: req.user.id, message: err.message });
      return res.status(503).json({ error: 'translation_unavailable' });
    }

    const results = Array.isArray(outcome?.results) ? outcome.results : [];
    const blocked = outcome?.blocked;
    if (blocked && results.length && results.every((result) => result.state === 'failed')) {
      if (isAuto(req)) return res.json({ language, results });
      const status = blocked === 'translation_unavailable' ? 503 : 429;
      return res.status(status).json({ error: blocked });
    }
    return res.json({ language, results });
  });

  return router;
}

module.exports = { MAX_PER_MINUTE, userContentTranslationRoutes };
