'use strict';

const fs = require('node:fs');
const vm = require('node:vm');
const ORIGIN = 'https://platform.test';
const SCOPE_HEADER = 'X-Usernode-Cache-Scope';
const A = 'a'.repeat(64), B = 'b'.repeat(64);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const json = (body, scope = A, { status = 200, policy = 'private', headers = {} } = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': policy, [SCOPE_HEADER]: scope, ...headers },
});

// Real worker code and native Request/Response/streams, with only the browser
// storage/network/lifecycle APIs replaced. Cache handles survive deletion,
// matching Cache Storage's behavior rather than hiding late-write races.
// `timers` replaces setTimeout/clearTimeout, so a test can fire a deadline
// on demand instead of waiting it out.
function worker({ source = fs.readFileSync(require.resolve('../../public/sw.js'), 'utf8'), fetcher,
  timers = { setTimeout, clearTimeout } } = {}) {
  const stores = new Map(), handlers = {}, messages = [], requests = [], lifetime = [];
  let network = fetcher || (async () => json({ fake: 'A' }));
  const requestOf = key => typeof key === 'string' ? new Request(new URL(key, ORIGIN)) : key;
  const keyOf = key => requestOf(key).url;
  const matches = (entry, request, options = {}) => options.ignoreVary
    || (entry.response.headers.get('Vary') || '').split(',').filter(Boolean)
      .every(name => name.trim() !== '*' && entry.request.headers.get(name.trim()) === request.headers.get(name.trim()));
  const caches = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const data = stores.get(name);
      return {
        async match(key, options) {
          return data.get(keyOf(key))?.find(entry => matches(entry, requestOf(key), options))?.response.clone();
        },
        async put(key, response) {
          const request = requestOf(key), variants = data.get(keyOf(key)) || [];
          data.set(keyOf(key), [...variants.filter(entry => !matches(entry, request)),
            { request: request.clone(), response: response.clone() }]);
        },
        async delete(key, options) {
          const variants = data.get(keyOf(key)) || [];
          const keep = variants.filter(entry => !matches(entry, requestOf(key), options));
          if (keep.length) data.set(keyOf(key), keep); else data.delete(keyOf(key));
          return keep.length !== variants.length;
        },
        async keys() { return [...data.values()].flat().map(entry => entry.request.clone()); },
      };
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); },
  };
  const fetch = async (request, init) => {
    const req = new Request(typeof request === 'string' ? new URL(request, ORIGIN) : request, init);
    requests.push(req);
    return network(req);
  };
  vm.runInNewContext(source, {
    self: { location: { origin: ORIGIN }, addEventListener(name, fn) { handlers[name] = fn; },
      clients: { claim: async () => {}, matchAll: async () => [{ postMessage: m => messages.push(m) }] },
      skipWaiting: async () => {} },
    URL, Headers, Request, Response, ReadableStream, DOMException,
    caches, fetch, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
  });
  const waitUntil = promise => { lifetime.push(Promise.resolve(promise)); };
  return {
    stores, caches, handlers, requests, messages,
    setNetwork(fn) { network = fn; },
    async get(scope = A, path = '/api/private-fixture', init = {}) {
      const headers = new Headers(init.headers);
      if (scope) headers.set(SCOPE_HEADER, scope);
      const request = new Request(new URL(path, ORIGIN), { cache: 'reload', ...init, headers });
      let result;
      handlers.fetch({ request, waitUntil, respondWith(promise) { result = promise; } });
      return result === undefined ? fetch(request) : result;
    },
    async message(data) {
      handlers.message({ data, waitUntil });
      await this.drain();
    },
    async activate() {
      handlers.activate({ waitUntil });
      await this.drain();
    },
    async drain() {
      let handled = 0;
      while (handled < lifetime.length) {
        const batch = lifetime.slice(handled); handled = lifetime.length;
        await Promise.all(batch);
      }
    },
  };
}

module.exports = { worker, json, deferred, A, B, ORIGIN, SCOPE_HEADER };
