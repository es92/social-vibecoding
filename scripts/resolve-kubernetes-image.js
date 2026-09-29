'use strict';

// Resolve previously published worker/capture images by their complete tracked
// build inputs, not by the preceding commit or an expiring Actions artifact.
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');

const WORKFLOW = '.github/workflows/build-kubernetes-images.yml';
const RESOLVER = 'scripts/resolve-kubernetes-image.js';
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const NPM_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function command(file, args, cwd) {
  return execFileSync(file, args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000,
  }).trim();
}

// Registry lookups that failed for a reason a second attempt can fix: the
// connection dropped, the blob CDN reset it, a gateway timed out, GHCR asked
// us to slow down. One "read: connection reset by peer" from
// pkg-containers.githubusercontent.com failed the worker lookup for #2589's
// merge, which skipped the Helm release, which left production a commit
// behind with nothing on the platform saying so. Authentication (401/403)
// and cache misses (404, handled before this) are deterministic and are not
// here; a bad token does not get better with waiting.
const TRANSIENT_REGISTRY_ERROR = new RegExp([
  'connection reset', 'connection refused', 'broken pipe', '\\bEOF\\b',
  'i/o timeout', 'timed out', 'timeout', 'TLS handshake',
  'no such host', 'temporary failure', 'temporarily unavailable', 'server misbehaving',
  'too many requests', 'internal server error', 'bad gateway', 'service unavailable',
  'gateway time-?out', 'unexpected status(?: code)?:? (?:429|5\\d\\d)\\b',
].join('|'), 'i');
const INSPECT_ATTEMPTS = 3;
const INSPECT_RETRY_BASE_MS = 2000;

function isTransientRegistryError(error) {
  if (error?.code === 'ETIMEDOUT') return true; // execFileSync's own 60s deadline
  return TRANSIENT_REGISTRY_ERROR.test(`${error?.stderr || ''}\n${error?.message || ''}`);
}

// Block the (synchronous, single-purpose) resolver between attempts without
// spawning anything.
function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function inputKey({ component, revision, ref, claudeCodeVersion }, { cwd, run = command } = {}) {
  // The Git tree includes names, contents, executable modes, Dockerfiles and
  // .dockerignore. The worker's floating Claude Code dependency is resolved
  // before this lookup and becomes an exact external input too. Workflow/
  // resolver changes invalidate the build recipe. Keep candidate branches
  // separate from main, even for identical inputs.
  const componentInputs = component === 'capture'
    ? ['capture', 'evidence']
    : [component];
  const objects = [...componentInputs, WORKFLOW, RESOLVER].map(path =>
    run('git', ['rev-parse', `${revision}:${path}`], cwd));
  const inputs = {
    component, ref, platform: 'linux/amd64', objects,
  };
  if (component === 'worker') inputs.claudeCodeVersion = claudeCodeVersion;
  return createHash('sha256').update(JSON.stringify(inputs)).digest('hex');
}

function inspectImage(tag, {
  cwd, run = command, sleep = pause, warn = message => console.warn(message),
} = {}) {
  let output;
  for (let attempt = 1; ; attempt += 1) {
    try {
      output = run('docker', ['buildx', 'imagetools', 'inspect', tag,
        '--format', '{{json .Manifest}}'], cwd);
      break;
    } catch (error) {
      // Missing/removed registry artifacts are a normal cache miss.
      // Authentication and rate-limit errors must still fail rather than
      // masquerading as one. A dropped connection is retried a couple of
      // times first, and only then fails the same way: a transient error
      // may not become a cache miss either, or a blip would rebuild an
      // image whose inputs have not changed.
      if (/manifest unknown|not found|\b404\b/i.test(String(error.stderr || ''))) return null;
      if (attempt >= INSPECT_ATTEMPTS || !isTransientRegistryError(error)) throw error;
      const delay = INSPECT_RETRY_BASE_MS * attempt;
      const reason = String(error.stderr || error.message || '').trim().split('\n').pop();
      warn(`${tag}: registry lookup failed (attempt ${attempt}/${INSPECT_ATTEMPTS}), `
        + `retrying in ${delay}ms: ${reason}`);
      sleep(delay);
    }
  }
  const manifest = JSON.parse(output);
  if (!DIGEST.test(manifest.digest || '') || !manifest.manifests?.some(entry =>
    entry.platform?.os === 'linux' && entry.platform?.architecture === 'amd64')) {
    throw new Error('Reusable image must have a valid index digest and a linux/amd64 manifest');
  }
  return manifest.digest;
}

function resolveImage({
  component, owner, revision, ref, forceRebuild = 'none', claudeCodeVersion,
  reuseCurrentPlatform = false,
}, dependencies = {}) {
  if (!['platform', 'worker', 'capture'].includes(component)) throw new Error('Invalid component');
  if (!/^[a-f0-9]{40}$/.test(revision || '')) throw new Error('Invalid source revision');
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(owner || '')) throw new Error('Invalid registry owner');
  if (!ref?.startsWith('refs/heads/')) throw new Error('Image releases require a branch ref');
  if (!['none', 'worker', 'capture', 'all'].includes(forceRebuild)) throw new Error('Invalid force_rebuild selection');
  if (reuseCurrentPlatform && component !== 'platform') {
    throw new Error('Only the platform image can reuse the current source release');
  }
  if (component === 'worker' && !NPM_VERSION.test(claudeCodeVersion || '')) {
    throw new Error('Worker image releases require an exact CLAUDE_CODE_VERSION');
  }

  const image = `ghcr.io/${owner.toLowerCase()}/social-vibecoding-${component}`;
  const refresh = forceRebuild === 'all' || forceRebuild === component;
  const result = { image, reuse_tag: '', digest: '', refresh: String(refresh), reason: 'platform-build' };
  // Platform source identity and generated assets remain tied to this release.
  if (component === 'platform') {
    if (!reuseCurrentPlatform) return result;
    if (refresh) throw new Error('A scheduled dependency refresh cannot force-rebuild the platform');
    const reuseTag = `${image}:sha-${revision}`;
    const digest = inspectImage(reuseTag, dependencies);
    if (!digest) {
      throw new Error(`Current platform image is missing: ${reuseTag}. Run the normal main workflow first.`);
    }
    return {
      ...result, reuse_tag: reuseTag, digest, refresh: 'false', reason: 'current-source-release',
    };
  }

  result.reuse_tag = `${image}:inputs-${inputKey({
    component, revision, ref, claudeCodeVersion,
  }, dependencies)}`;
  if (refresh) return { ...result, reason: 'forced-refresh' };
  const digest = inspectImage(result.reuse_tag, dependencies);
  if (!digest) return { ...result, reason: 'image-not-found' };
  return { ...result, digest, reason: 'matching-build-inputs' };
}

if (require.main === module) {
  try {
    const result = resolveImage({
      component: process.env.COMPONENT,
      owner: process.env.GITHUB_REPOSITORY_OWNER,
      revision: process.env.GITHUB_SHA,
      ref: process.env.GITHUB_REF,
      forceRebuild: process.env.FORCE_REBUILD || 'none',
      claudeCodeVersion: process.env.CLAUDE_CODE_VERSION,
      reuseCurrentPlatform: process.env.REUSE_CURRENT_PLATFORM === 'true',
    });
    fs.appendFileSync(process.env.GITHUB_OUTPUT,
      Object.entries(result).map(([key, value]) => `${key}=${value}\n`).join(''));
    console.log(`${process.env.COMPONENT}: ${result.reason}${result.digest ? ` (${result.digest})` : ''}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { inputKey, resolveImage, isTransientRegistryError };
