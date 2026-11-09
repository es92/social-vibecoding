'use strict';
// Build a missing PR-base inventory only after a candidate has a potentially
// blocking finding. Fresh inventory avoids trusting caches written by PR code;
// Docker's normal layer reuse still makes an unchanged base inexpensive.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { sbomPackages } = require('./security-findings');

const COMPONENTS = {
  platform: ['Dockerfile.kubernetes', '.'], standalone: ['Dockerfile', '.'],
  worker: ['worker/Dockerfile', 'worker'], capture: ['capture/Dockerfile', '.'], starter: null,
};

function buildBaseline({ component, revision, output, root = path.join(__dirname, '..'),
  platform = process.env.SECURITY_SCAN_PLATFORM || 'linux/amd64',
  run = execFileSync }) {
  if (!Object.hasOwn(COMPONENTS, component) || !/^[a-f0-9]{40}$/.test(revision)
    || !/^linux\/(amd64|arm64)$/.test(platform)) throw new Error('Invalid baseline component, revision or architecture');
  const started = Date.now();
  let sbom;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'security-baseline-'));
  const image = `security-baseline-${component}:${revision}-${process.pid}`;
  const exec = (command, args, cwd = root) => run(command, args, { cwd, stdio: 'inherit', timeout: 15 * 60 * 1000 });
  try {
    try { run('git', ['cat-file', '-e', `${revision}^{commit}`], { cwd: root, stdio: 'ignore' }); }
    catch { exec('git', ['fetch', '--no-tags', '--depth=1', 'origin', revision]); }
    const source = path.join(dir, 'source');
    fs.mkdirSync(source);
    exec('git', ['archive', '--format=tar', '--output', path.join(dir, 'source.tar'), revision]);
    exec('tar', ['-xf', path.join(dir, 'source.tar'), '-C', source]);
    let [dockerfile, context] = COMPONENTS[component] || [];
    if (component === 'starter') {
      context = path.join(dir, 'starter');
      exec(process.execPath, [path.join(source, 'scripts/security-starter.js'), context], source);
      dockerfile = path.join(context, 'Dockerfile');
    } else {
      dockerfile = path.join(source, dockerfile);
      context = path.join(source, context);
    }
    exec('docker', ['buildx', 'build', '--load', '--pull', '--platform', platform, '-t', image, '-f', dockerfile, context]);
    const inventory = path.join(dir, 'sbom.spdx.json');
    exec('sh', [path.join(root, 'scripts/create-image-sbom.sh'), image, inventory]);
    sbom = JSON.parse(fs.readFileSync(inventory, 'utf8'));
    sbomPackages(sbom);
  } finally {
    try { run('docker', ['image', 'rm', image], { stdio: 'ignore', timeout: 30000 }); } catch { /* no built image on a failed build */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(sbom));
  const ms = Date.now() - started;
  const note = `${component} baseline ${revision.slice(0, 9)} (${platform}): built in ${ms}ms`;
  console.log(note);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${note}\n\n`);
  return { ms };
}
if (require.main === module) {
  try {
    const [component, revision, output] = process.argv.slice(2);
    buildBaseline({ component, revision, output });
  } catch (err) { console.error(`Baseline comparison unavailable: ${err.message}`); process.exitCode = 1; }
}
module.exports = { buildBaseline };
