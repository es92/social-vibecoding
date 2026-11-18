'use strict';

// Screenshot comparison is optional CPU work. It must never hold the web
// process's health responses or a conductor's lease renewals: one crop
// search stalled both conductors for minutes on 29 Oct 2026. Each comparison
// has a worker and a deadline; a busy process declines more comparisons.
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');

const TIMEOUT_MS = 5000;
const MAX_WORKERS = 2;
// The checks a still gets as it is saved (shots-diff.checkSave) answer the
// agent's save_shot, so they get less time: a check that cannot finish is
// left out, never waited for.
const CHECK_TIMEOUT_MS = 3000;
const failure = (code, message) => Object.assign(new Error(message), { code });

// Owned copy of one PNG for a worker, its storage transferred. Detaching a
// pg Buffer's backing array could detach other files in the same database
// response, so the bytes are always copied first.
function owned(data, transferList) {
  const copy = Uint8Array.from(data);
  transferList.push(copy.buffer);
  return copy;
}
const asBuffer = (data) => Buffer.from(data.buffer, data.byteOffset, data.byteLength);

// One task in a worker of its own, at most `maxWorkers` at a time.
function createRunner({ timeoutMs, maxWorkers, workerFile, busy }) {
  let active = 0;
  return function run(data, transferList, { signal } = {}) {
    const aborted = () => signal.reason instanceof Error ? signal.reason
      : failure('shots_diff_aborted', 'Screenshot comparison stopped');
    if (signal?.aborted) return Promise.reject(aborted());
    if (active >= maxWorkers) return Promise.reject(failure('shots_diff_busy', busy));
    active += 1;
    return new Promise((resolve, reject) => {
      let worker;
      let timer;
      let done = false;
      const onAbort = () => finish(aborted());
      const finish = (error, result) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        // Do not give the slot back until the worker has actually stopped,
        // including on a timeout, cancellation, error or a successful result.
        Promise.resolve(worker?.terminate()).then(() => {
          active -= 1;
          if (error) reject(error); else resolve(result);
        }, (err) => { active -= 1; reject(error || err); });
      };
      try {
        worker = new Worker(workerFile, {
          workerData: data, transferList,
          // No server/test preloads in this CPU-only worker.
          execArgv: [],
        });
        worker.once('message', (result) => finish(null, result));
        worker.once('error', (error) => finish(error));
        worker.once('exit', (code) => finish(failure('shots_diff_worker_exit', `Screenshot comparison exited without a result (${code})`)));
        timer = setTimeout(() => finish(failure('shots_diff_timeout', 'Screenshot comparison exceeded its time budget')), timeoutMs);
        signal?.addEventListener('abort', onAbort, { once: true });
      } catch (error) { finish(error); }
    });
  };
}

function createComparer({ timeoutMs = TIMEOUT_MS, maxWorkers = MAX_WORKERS, workerFile = __filename } = {}) {
  const run = createRunner({ timeoutMs, maxWorkers, workerFile, busy: 'Screenshot comparisons are at this process\'s limit' });
  return function screensFor(stories, files, { signal } = {}) {
    let transferList;
    let images;
    try {
      transferList = [];
      // Only the PNGs the matcher reads, never clips or dense originals.
      images = files.filter((f) => f.media === 'png' && ['context', 'focus'].includes(f.variant)).map((f) => {
        const { storyId, viewport, side, variant, media, sha256 } = f;
        return { storyId, viewport, side, variant, media, sha256, data: owned(f.data, transferList) };
      });
    } catch (error) { return Promise.reject(error); }
    return run({ shotsComparison: true, stories, files: images }, transferList, { signal });
  };
}

// shots-diff.checkSave in a worker: a dark screen against its light one, or
// an element shot against its screen shot. `job` names its PNGs (`light` and
// `dark`, or `screen` and `element`) with their densities.
function createChecker({ timeoutMs = CHECK_TIMEOUT_MS, maxWorkers = MAX_WORKERS, workerFile = __filename } = {}) {
  const run = createRunner({ timeoutMs, maxWorkers, workerFile, busy: 'Screenshot checks are at this process\'s limit' });
  return function checkSave(job, { signal } = {}) {
    const transferList = [];
    const copy = { ...job };
    try {
      for (const key of ['light', 'dark', 'screen', 'element']) {
        if (job[key] != null) copy[key] = owned(job[key], transferList);
      }
    } catch (error) { return Promise.reject(error); }
    return run({ shotsCheck: true, job: copy }, transferList, { signal });
  };
}

if (!isMainThread && workerData?.shotsComparison) {
  const files = workerData.files.map((f) => ({ ...f, data: asBuffer(f.data) }));
  require('./shots-diff').screensFor(workerData.stories, files).then((screens) => parentPort.postMessage(screens));
}
if (!isMainThread && workerData?.shotsCheck) {
  const job = { ...workerData.job };
  for (const key of ['light', 'dark', 'screen', 'element']) if (job[key] != null) job[key] = asBuffer(job[key]);
  parentPort.postMessage(require('./shots-diff').checkSave(job));
}

module.exports = {
  TIMEOUT_MS,
  CHECK_TIMEOUT_MS,
  MAX_WORKERS,
  createComparer,
  createChecker,
  screensFor: createComparer(),
  checkSave: createChecker(),
  unchangedStories: require('./shots-diff').unchangedStories,
};
