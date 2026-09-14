'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const {
  CLIENT_ID,
  IDENTITY_SCOPE,
  REQUIRED_SCOPES,
  PRODUCTION_ORIGIN,
  LOCAL_ORIGIN,
} = require('../services/cli-auth-constants');
const {
  isCanonicalSecret,
  isExactObject,
  parseStrictJson,
} = require('../services/cli-auth');

const PROFILE_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const CONFIG_KEYS = ['version', 'default_profile', 'profiles', 'credential_backends'];
const RECORD_KEYS = ['access_token', 'expires_at', 'scopes', 'client_id'];
const NATIVE_RECORD_KEYS = ['version', ...RECORD_KEYS];
let windowsApplicationData = null;

function windowsPowerShell(script, args = []) {
  const systemRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const executable = path.win32.join(
    systemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  );
  const result = spawnSync(executable, [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    script,
    ...args,
  ], {
    encoding: 'utf8',
    timeout: 10000,
    windowsHide: true,
    shell: false,
  });
  if (result.error || result.signal || result.status !== 0) {
    throw new Error('Windows security API operation failed');
  }
  return result.stdout.trim();
}

function windowsApplicationDataDirectory() {
  if (windowsApplicationData) return windowsApplicationData;
  const resolved = windowsPowerShell(
    "[Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData)"
  );
  if (!path.win32.isAbsolute(resolved) || resolved.includes('\u0000')) {
    throw new Error('Windows per-user application-data directory is unavailable');
  }
  windowsApplicationData = resolved;
  return resolved;
}

const WINDOWS_SET_PRIVATE_ACL = String.raw`
$ErrorActionPreference = 'Stop'
$target = $args[0]
$kind = $args[1]
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$sid = $identity.User
if ($kind -eq 'directory') {
  $acl = New-Object Security.AccessControl.DirectorySecurity
  $acl.SetOwner($sid)
  $acl.SetAccessRuleProtection($true, $false)
  $rule = [Security.AccessControl.FileSystemAccessRule]::new(
    $sid,
    [Security.AccessControl.FileSystemRights]::FullControl,
    ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
      [Security.AccessControl.InheritanceFlags]::ObjectInherit),
    [Security.AccessControl.PropagationFlags]::None,
    [Security.AccessControl.AccessControlType]::Allow
  )
  [void]$acl.AddAccessRule($rule)
  [IO.Directory]::SetAccessControl($target, $acl)
} elseif ($kind -eq 'file') {
  $acl = New-Object Security.AccessControl.FileSecurity
  $acl.SetOwner($sid)
  $acl.SetAccessRuleProtection($true, $false)
  $rule = [Security.AccessControl.FileSystemAccessRule]::new(
    $sid,
    [Security.AccessControl.FileSystemRights]::FullControl,
    [Security.AccessControl.AccessControlType]::Allow
  )
  [void]$acl.AddAccessRule($rule)
  [IO.File]::SetAccessControl($target, $acl)
} else {
  exit 20
}
`;

const WINDOWS_VERIFY_PRIVATE_ACL = String.raw`
$ErrorActionPreference = 'Stop'
$target = $args[0]
$kind = $args[1]
$item = Get-Item -LiteralPath $target -Force
if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { exit 21 }
if ($kind -eq 'directory' -and -not $item.PSIsContainer) { exit 22 }
if ($kind -eq 'file' -and $item.PSIsContainer) { exit 23 }
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$sid = $identity.User.Value
$acl = Get-Acl -LiteralPath $target
$owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
if ($owner -ne $sid -or -not $acl.AreAccessRulesProtected) { exit 24 }
$rules = $acl.GetAccessRules(
  $true,
  $true,
  [Security.Principal.SecurityIdentifier]
)
$hasFullControl = $false
foreach ($rule in $rules) {
  if ($rule.IsInherited) { exit 25 }
  if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow) {
    if ($rule.IdentityReference.Value -ne $sid) { exit 26 }
    if (($rule.FileSystemRights -band
      [Security.AccessControl.FileSystemRights]::FullControl) -eq
      [Security.AccessControl.FileSystemRights]::FullControl) {
      $hasFullControl = $true
    }
  }
}
if (-not $hasFullControl) { exit 27 }
`;

function setPrivateWindowsAcl(target, kind) {
  try {
    windowsPowerShell(WINDOWS_SET_PRIVATE_ACL, [target, kind]);
  } catch {
    throw new Error(
      `Could not secure ${target}; a current-user-only Windows ACL is required`
    );
  }
  verifyPrivateWindowsAcl(target, kind);
}

function verifyPrivateWindowsAcl(target, kind) {
  try {
    windowsPowerShell(WINDOWS_VERIFY_PRIVATE_ACL, [target, kind]);
  } catch {
    throw new Error(
      `Unsafe ownership or permissions on ${target}; require a current-user-only Windows ACL`
    );
  }
}

function userConfigDirectory() {
  if (process.platform === 'win32') {
    return path.join(windowsApplicationDataDirectory(), 'social-vibecoding');
  }
  const home = os.userInfo().homedir;
  if (!path.isAbsolute(home)) throw new Error('Operating-system account home is unavailable');
  return path.join(home, '.config', 'social-vibecoding');
}

function pathsForState() {
  const directory = userConfigDirectory();
  return {
    directory,
    config: path.join(directory, 'config.json'),
    credentials: path.join(directory, 'credentials.json'),
    stateLock: path.join(directory, 'state.lock'),
    operationDirectory: path.join(directory, 'operations'),
  };
}

function canonicalOrigin(value, { allowLoopbackHttp = true } = {}) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) return null;
    if (url.pathname !== '' && url.pathname !== '/') return null;
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:'
        && !(allowLoopbackHttp && loopback && url.protocol === 'http:')) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function defaultConfig() {
  return {
    version: 1,
    default_profile: 'production',
    profiles: {},
    credential_backends: {},
  };
}

function checkExactKeys(value, keys, label) {
  if (!isExactObject(value, keys)) {
    throw new Error(`${label} has missing, duplicate, or unsupported fields`);
  }
}

function isUtcRfc3339(value) {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z$/.exec(value);
  if (!match) return false;
  const parsed = new Date(`${match[1]}Z`);
  return Number.isFinite(parsed.getTime())
    && parsed.toISOString().slice(0, 19) === match[1];
}

function validateRecord(record, label = 'credential record') {
  checkExactKeys(record, RECORD_KEYS, label);
  if (!isCanonicalSecret(record.access_token, 'access')) {
    throw new Error(`${label} contains a malformed access token`);
  }
  if (!isUtcRfc3339(record.expires_at)) {
    throw new Error(`${label} contains a malformed expiry`);
  }
  if (record.client_id !== CLIENT_ID
      || !Array.isArray(record.scopes)
      || record.scopes.length < 1
      || record.scopes.length > REQUIRED_SCOPES.length
      || record.scopes[0] !== IDENTITY_SCOPE
      || !record.scopes.every((scope, index) => scope === REQUIRED_SCOPES[index])) {
    throw new Error(`${label} contains unsupported client or scope metadata`);
  }
  return record;
}

function nativeRecordJson(record) {
  validateRecord(record);
  return JSON.stringify({ version: 1, ...record });
}

function parseNativeRecord(raw) {
  const parsed = parseStrictJson(raw);
  checkExactKeys(parsed, NATIVE_RECORD_KEYS, 'native credential');
  if (parsed.version !== 1) {
    throw new Error('native credential has an unsupported version');
  }
  const { version: _version, ...record } = parsed;
  return validateRecord(record, 'native credential');
}

function validateConfig(config) {
  checkExactKeys(config, CONFIG_KEYS, 'config.json');
  if (config.version !== 1
      || !PROFILE_RE.test(config.default_profile)
      || !config.profiles || typeof config.profiles !== 'object'
      || Array.isArray(config.profiles)
      || !config.credential_backends || typeof config.credential_backends !== 'object'
      || Array.isArray(config.credential_backends)) {
    throw new Error('config.json has an unsupported schema');
  }
  for (const [name, profile] of Object.entries(config.profiles)) {
    if (!PROFILE_RE.test(name) || name === 'production') {
      throw new Error('config.json contains an invalid profile name');
    }
    checkExactKeys(profile, ['origin'], `profile ${name}`);
    const origin = canonicalOrigin(profile.origin);
    if (!origin || origin !== profile.origin) {
      throw new Error(`profile ${name} contains a noncanonical origin`);
    }
    // Accept a redundant legacy local entry only when it is identical to the
    // immutable built-in. Resolution never trusts or returns this stored copy.
    if (name === 'local' && origin !== LOCAL_ORIGIN) {
      throw new Error('config.json cannot retarget the built-in local profile');
    }
  }
  if (!['production', 'local'].includes(config.default_profile)
      && !Object.prototype.hasOwnProperty.call(config.profiles, config.default_profile)) {
    throw new Error('config.json default_profile does not exist');
  }
  const allowedBackends = new Set(['native', 'file', 'native-pending', 'file-pending']);
  for (const [origin, backend] of Object.entries(config.credential_backends)) {
    if (canonicalOrigin(origin) !== origin || !allowedBackends.has(backend)) {
      throw new Error('config.json contains invalid credential backend state');
    }
  }
  return config;
}

function validateCredentials(document) {
  checkExactKeys(document, ['version', 'servers'], 'credentials.json');
  if (document.version !== 1 || !document.servers
      || typeof document.servers !== 'object' || Array.isArray(document.servers)) {
    throw new Error('credentials.json has an unsupported schema');
  }
  for (const [origin, record] of Object.entries(document.servers)) {
    if (canonicalOrigin(origin) !== origin) {
      throw new Error('credentials.json contains a noncanonical server origin');
    }
    validateRecord(record, `credential for ${origin}`);
  }
  return document;
}

async function ensureDirectory(directory) {
  let existed = true;
  try {
    await fsp.lstat(directory);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    existed = false;
  }
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fsp.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Unsafe user configuration directory: ${directory}`);
  }
  if (process.platform === 'win32') {
    if (!existed) setPrivateWindowsAcl(directory, 'directory');
    else verifyPrivateWindowsAcl(directory, 'directory');
  } else {
    const resolved = await fsp.realpath(directory);
    if (resolved !== path.resolve(directory)) {
      throw new Error(`Unsafe symlink in user configuration path: ${directory}`);
    }
    if (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) {
      throw new Error(`Unsafe ownership or permissions on ${directory}; require mode 0700`);
    }
  }
}

async function safeExistingFile(filename) {
  let stat;
  try {
    stat = await fsp.lstat(filename);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Unsafe user state path: ${filename}`);
  }
  if (process.platform === 'win32') {
    verifyPrivateWindowsAcl(filename, 'file');
  } else {
    if (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) {
      throw new Error(`Unsafe ownership or permissions on ${filename}; require mode 0600`);
    }
  }
  return stat;
}

async function readJson(filename, fallback, validator) {
  const stat = await safeExistingFile(filename);
  if (!stat) return fallback;
  let parsed;
  try {
    parsed = parseStrictJson(await fsp.readFile(filename, 'utf8'));
  } catch {
    throw new Error(`Malformed JSON in ${filename}; repair it manually without sharing credential values`);
  }
  try {
    return validator(parsed);
  } catch (err) {
    throw new Error(
      `Invalid state in ${filename}: ${err.message}; repair it manually without sharing credential values`
    );
  }
}

async function durableWriteJson(filename, value) {
  const directory = path.dirname(filename);
  await ensureDirectory(directory);
  await safeExistingFile(filename);
  const temporary = path.join(
    directory,
    `.${path.basename(filename)}.tmp-${process.pid}-${crypto.randomBytes(8).toString('hex')}`
  );
  const handle = await fsp.open(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
  try {
    if (process.platform === 'win32') setPrivateWindowsAcl(temporary, 'file');
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsp.rename(temporary, filename);
  if (process.platform === 'win32') verifyPrivateWindowsAcl(filename, 'file');
  else await fsp.chmod(filename, 0o600);
  try {
    const dirHandle = await fsp.open(directory, fs.constants.O_RDONLY);
    try { await dirHandle.sync(); } finally { await dirHandle.close(); }
  } catch (err) {
    const unsupported = ['EINVAL', 'ENOTSUP', 'EISDIR'].includes(err.code)
      || (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(err.code));
    if (!unsupported) throw err;
  }
}

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function processStartIdentity(pid) {
  if (process.platform !== 'linux' || !Number.isSafeInteger(pid) || pid <= 0) {
    return null;
  }
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const afterName = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    // afterName[0] is field 3 (state); starttime is field 22.
    return `${pid}:${afterName[19]}`;
  } catch {
    return null;
  }
}

const LOCK_OWNER_FILENAME = 'owner.json';
const LOCK_OWNER_KEYS = [
  'version',
  'pid',
  'started_at',
  'recover_after',
  'attempt_id',
  'operation',
  'process_identity',
];

function parseLockOwner(raw) {
  const owner = parseStrictJson(raw);
  if (!isExactObject(owner, LOCK_OWNER_KEYS)
      || owner.version !== 1
      || !Number.isSafeInteger(owner.pid)
      || owner.pid <= 0
      || typeof owner.operation !== 'string'
      || !/^[0-9a-f]{32}$/.test(owner.attempt_id)
      || (owner.process_identity !== null && typeof owner.process_identity !== 'string')) {
    throw new Error('invalid lock owner');
  }
  const startedAt = new Date(owner.started_at);
  const recoverAfter = new Date(owner.recover_after);
  if (!Number.isFinite(startedAt.getTime())
      || startedAt.toISOString() !== owner.started_at
      || !Number.isFinite(recoverAfter.getTime())
      || recoverAfter.toISOString() !== owner.recover_after) {
    throw new Error('invalid lock timestamps');
  }
  return owner;
}

async function readLockOwner(filename) {
  let stat;
  try {
    stat = await fsp.lstat(filename);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  if (stat.isSymbolicLink()) throw new Error(`Unsafe user state path: ${filename}`);

  let ownerFilename;
  let kind;
  if (stat.isFile()) {
    await safeExistingFile(filename);
    ownerFilename = filename;
    kind = 'legacy-file';
  } else if (stat.isDirectory()) {
    if (process.platform === 'win32') {
      verifyPrivateWindowsAcl(filename, 'directory');
    } else if (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) {
      throw new Error(`Unsafe ownership or permissions on ${filename}; require mode 0700`);
    }
    ownerFilename = path.join(filename, LOCK_OWNER_FILENAME);
    if (!await safeExistingFile(ownerFilename)) {
      try {
        await fsp.lstat(filename);
      } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw err;
      }
      // A lock directory with no owner file inside is NOT a corrupt lock. By
      // this module's own invariant a valid lock is never in that state: the
      // candidate is built complete and renamed into place, so it is non-empty
      // at the instant it becomes visible. An empty one is therefore either a
      // momentary artifact of two contenders racing, or the leftovers of a
      // process that died mid-teardown — never a lock somebody holds.
      //
      // Reporting it as malformed threw an error with no `code`, out of a
      // function whose contract is that contention carries one. Under load
      // that surfaced roughly once in 200 contended acquisitions as
      // "Malformed lock file", where the caller expected `<operation>_in_progress`.
      //
      // Absence is not corruption, so it reads as "no lock". The caller then
      // retries, and the retry is also the repair: POSIX rename() moves a
      // directory onto an EMPTY directory successfully, so the next attempt
      // takes the abandoned one over. A real lock's directory is non-empty and
      // still refuses with ENOTEMPTY, which is contention and is handled as
      // such. A genuinely corrupt owner file is a different case and still
      // throws, from parseLockOwner below.
      return null;
    }
    kind = 'directory';
  } else {
    throw new Error(`Unsafe user state path: ${filename}`);
  }

  try {
    return { kind, owner: parseLockOwner(await fsp.readFile(ownerFilename, 'utf8')) };
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

async function removeLockDirectory(directory) {
  try {
    await fsp.unlink(path.join(directory, LOCK_OWNER_FILENAME));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  try {
    await fsp.rmdir(directory);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

async function createLockCandidate(filename, owner) {
  const candidate = `${filename}.candidate-${owner.attempt_id}`;
  await fsp.mkdir(candidate, { mode: 0o700 });
  let handle;
  try {
    if (process.platform === 'win32') setPrivateWindowsAcl(candidate, 'directory');
    const ownerFilename = path.join(candidate, LOCK_OWNER_FILENAME);
    handle = await fsp.open(
      ownerFilename,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
      0o600
    );
    if (process.platform === 'win32') setPrivateWindowsAcl(ownerFilename, 'file');
    await handle.writeFile(`${JSON.stringify(owner)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    return candidate;
  } catch (err) {
    if (handle) await handle.close().catch(() => {});
    await removeLockDirectory(candidate).catch(() => {});
    throw err;
  }
}

function lockIsStale(owner) {
  const alive = processAlive(owner.pid);
  const liveIdentity = alive ? processStartIdentity(owner.pid) : null;
  const sameProcess = alive
    && (!owner.process_identity
      || !liveIdentity
      || owner.process_identity === liveIdentity);
  return !sameProcess && Date.now() >= new Date(owner.recover_after).getTime();
}

function isLockContentionError(err) {
  return ['EEXIST', 'ENOTEMPTY', 'ENOTDIR', 'EISDIR'].includes(err.code);
}

function isPossibleWindowsLockContention(err) {
  return process.platform === 'win32' && ['EPERM', 'EACCES'].includes(err.code);
}

async function acquireLock(filename, {
  timeoutMs = 5000,
  recoverAfterMs = 30000,
  operation = 'state',
  secureDirectory = true,
} = {}) {
  if (secureDirectory) {
    await ensureDirectory(path.dirname(filename));
  } else {
    const directory = await fsp.lstat(path.dirname(filename));
    if (!directory.isDirectory() || directory.isSymbolicLink()) {
      throw new Error(`Unsafe lock directory: ${path.dirname(filename)}`);
    }
  }
  const deadline = Date.now() + timeoutMs;
  const owner = {
    version: 1,
    pid: process.pid,
    started_at: new Date().toISOString(),
    recover_after: new Date(Date.now() + recoverAfterMs).toISOString(),
    attempt_id: crypto.randomBytes(16).toString('hex'),
    operation,
    process_identity: processStartIdentity(process.pid),
  };
  let candidate = await createLockCandidate(filename, owner);
  try {
    while (true) {
      let possiblePermissionError = null;
      try {
        // The candidate already contains its owner file, so the lock is
        // non-empty at the instant it becomes visible. That property is what
        // makes the stale-owner rename below safe from delayed contenders.
        await fsp.rename(candidate, filename);
        candidate = null;
        return {
          owner,
          async release() {
            let current;
            try {
              current = await readLockOwner(filename);
            } catch {
              throw new Error(`Lock ownership could not be verified: ${filename}`);
            }
            if (!current || current.kind !== 'directory'
                || current.owner.attempt_id !== owner.attempt_id) {
              throw new Error(`Lock ownership changed unexpectedly: ${filename}`);
            }
            const retired = `${filename}.released-${owner.attempt_id}`;
            await fsp.rename(filename, retired);
            await removeLockDirectory(retired);
          },
        };
      } catch (err) {
        if (!isLockContentionError(err) && !isPossibleWindowsLockContention(err)) throw err;
        if (isPossibleWindowsLockContention(err)) possiblePermissionError = err;
      }

      let current;
      try {
        current = await readLockOwner(filename);
      } catch (err) {
        throw new Error(`Malformed lock file: ${filename}`, { cause: err });
      }
      if (!current) {
        // Windows can report EPERM for an existing destination directory. If
        // the destination is actually absent, preserve the permission error
        // instead of mistaking it for transient lock contention.
        if (possiblePermissionError) throw possiblePermissionError;
        continue;
      }

      if (lockIsStale(current.owner)) {
        // The tombstone name is tied to the immutable stale attempt and is
        // deliberately retained. Exactly one rename/link can create it. A
        // contender that was paused after reading the stale owner therefore
        // cannot later move or unlink a replacement lock.
        const tombstone = `${filename}.stale-${current.owner.attempt_id}`;
        try {
          // This also migrates regular lock files created by older builds.
          // A retained destination of either type makes a delayed rename of
          // the replacement fail instead of displacing its new owner.
          await fsp.rename(filename, tombstone);
          continue;
        } catch (err) {
          if (err.code === 'ENOENT' || isLockContentionError(err)) continue;
          if (isPossibleWindowsLockContention(err)) {
            try {
              await fsp.lstat(tombstone);
              continue;
            } catch (statErr) {
              if (statErr.code !== 'ENOENT') throw statErr;
            }
          }
          throw err;
        }
      }

      if (Date.now() >= deadline) {
        const error = new Error(`${operation}_in_progress`);
        error.code = `${operation}_in_progress`;
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  } finally {
    if (candidate) await removeLockDirectory(candidate).catch(() => {});
  }
}

async function withStateLock(fn) {
  const statePaths = pathsForState();
  await ensureDirectory(statePaths.directory);
  const lock = await acquireLock(statePaths.stateLock, {
    timeoutMs: 5000,
    recoverAfterMs: 30000,
    operation: 'state',
  });
  try {
    await cleanupRecognizedTemporaryFiles(statePaths.directory);
    return await fn(statePaths);
  } finally {
    await lock.release();
  }
}

async function cleanupRecognizedTemporaryFiles(directory) {
  const entries = await fsp.readdir(directory);
  const pattern = /^\.(?:config|credentials)\.json\.tmp-([1-9][0-9]*)-([0-9a-f]{16})$/;
  for (const entry of entries) {
    const match = pattern.exec(entry);
    if (!match || processAlive(Number(match[1]))) continue;
    const filename = path.join(directory, entry);
    let stat;
    try {
      stat = await safeExistingFile(filename);
    } catch {
      continue;
    }
    if (stat && Date.now() - stat.mtimeMs >= 30000) {
      await fsp.unlink(filename);
    }
  }
}

function originLockPath(origin) {
  const statePaths = pathsForState();
  const digest = crypto.createHash('sha256').update(origin, 'utf8').digest('hex');
  return path.join(statePaths.operationDirectory, `${digest}.lock`);
}

async function acquireOriginLock(origin, operation) {
  const recoverAfterMs = operation === 'login' ? 12 * 60 * 1000 : 2 * 60 * 1000;
  try {
    return await acquireLock(originLockPath(origin), {
      timeoutMs: 250,
      recoverAfterMs,
      operation,
    });
  } catch (err) {
    if (err.code === `${operation}_in_progress`) {
      err.code = operation === 'login' ? 'login_in_progress' : 'operation_in_progress';
      err.message = err.code;
    }
    throw err;
  }
}

async function loadConfig(paths = pathsForState()) {
  await ensureDirectory(paths.directory);
  return readJson(paths.config, defaultConfig(), validateConfig);
}

async function loadCredentials(paths = pathsForState()) {
  await ensureDirectory(paths.directory);
  return readJson(
    paths.credentials,
    { version: 1, servers: {} },
    validateCredentials
  );
}

function resolveProfile(config, name) {
  if (!PROFILE_RE.test(name)) throw new Error(`Invalid profile name: ${name}`);
  if (name === 'production') return { name, origin: PRODUCTION_ORIGIN };
  if (name === 'local') return { name, origin: LOCAL_ORIGIN };
  if (!Object.prototype.hasOwnProperty.call(config.profiles, name)) {
    throw new Error(`Unknown profile: ${name}`);
  }
  const profile = config.profiles[name];
  return { name, origin: profile.origin };
}

async function selectedProfile(explicitName) {
  return withStateLock(async (statePaths) => {
    const config = await loadConfig(statePaths);
    return resolveProfile(config, explicitName || config.default_profile || 'production');
  });
}

function loadKeytar() {
  let modulePath;
  try {
    modulePath = require.resolve('keytar');
  } catch (err) {
    if (err.code === 'MODULE_NOT_FOUND') return null;
    throw err;
  }
  // Once resolution succeeds, any load/runtime failure is ambiguous and must
  // not silently select the fallback file.
  return require(modulePath);
}

function linuxSecretTool(args, options = {}) {
  const result = spawnSync('secret-tool', args, {
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
    shell: false,
    ...options,
  });
  if (result.error?.code === 'ENOENT') return { supported: false };
  if (result.error || result.signal || result.status == null) {
    throw new Error('Native credential store capability probe failed');
  }
  return { supported: true, result };
}

async function nativeRecord(origin) {
  const keytar = loadKeytar();
  let raw;
  if (keytar) {
    raw = await keytar.getPassword('social-vibecoding', origin);
  } else if (process.platform === 'linux') {
    const lookup = linuxSecretTool([
      'lookup',
      'service', 'social-vibecoding',
      'account', origin,
    ]);
    if (!lookup.supported) return { supported: false, record: null };
    if (lookup.result.status === 1 && !lookup.result.stderr) {
      return { supported: true, record: null };
    }
    if (lookup.result.status !== 0) {
      throw new Error('Native credential store is inaccessible');
    }
    raw = lookup.result.stdout.replace(/\r?\n$/, '');
  } else {
    return { supported: false, record: null };
  }
  if (raw == null) return { supported: true, record: null };
  try {
    return { supported: true, record: parseNativeRecord(raw) };
  } catch {
    throw new Error('Native credential record is malformed');
  }
}

async function setNativeRecord(origin, record) {
  const keytar = loadKeytar();
  const serialized = nativeRecordJson(record);
  if (keytar) {
    await keytar.setPassword('social-vibecoding', origin, serialized);
  } else if (process.platform === 'linux') {
    const stored = linuxSecretTool([
      'store',
      '--label=Homeroom CLI',
      'service', 'social-vibecoding',
      'account', origin,
    ], { input: serialized });
    if (!stored.supported) throw new Error('Native credential store is unavailable');
    if (stored.result.status !== 0) throw new Error('Native credential store write failed');
  } else {
    throw new Error('Native credential store is unavailable');
  }
  const readBack = await nativeRecord(origin);
  if (!readBack.record
      || JSON.stringify(readBack.record) !== JSON.stringify(record)) {
    throw new Error('Native credential read-back failed');
  }
}

async function deleteNativeRecord(origin) {
  const keytar = loadKeytar();
  if (keytar) {
    await keytar.deletePassword('social-vibecoding', origin);
  } else if (process.platform === 'linux') {
    const cleared = linuxSecretTool([
      'clear',
      'service', 'social-vibecoding',
      'account', origin,
    ]);
    if (!cleared.supported) return false;
    if (![0, 1].includes(cleared.result.status)) {
      throw new Error('Native credential store delete failed');
    }
  } else {
    return false;
  }
  return true;
}

async function reconcileOriginLocked(statePaths, config, origin) {
  let marker = config.credential_backends[origin];
  const credentials = await loadCredentials(statePaths);
  const fileRecord = credentials.servers[origin] || null;

  if (marker === 'file-pending') {
    if (fileRecord) {
      marker = 'file';
      config.credential_backends[origin] = marker;
      await durableWriteJson(statePaths.config, config);
    } else {
      delete config.credential_backends[origin];
      await durableWriteJson(statePaths.config, config);
      marker = null;
    }
  }
  if (marker === 'native-pending') {
    const native = await nativeRecord(origin);
    if (!native.supported) throw new Error('Native credential recovery is unavailable');
    if (native.record) {
      marker = 'native';
      config.credential_backends[origin] = marker;
      await durableWriteJson(statePaths.config, config);
    } else {
      delete config.credential_backends[origin];
      await durableWriteJson(statePaths.config, config);
      marker = null;
    }
  }

  let native = { supported: false, record: null };
  if (marker === 'native' || !marker) native = await nativeRecord(origin);
  if (marker === 'file' && !fileRecord) {
    throw new Error('credential_store_inconsistent: file marker has no credential');
  }
  if (marker === 'native' && !native.record) {
    throw new Error('credential_store_inconsistent: native marker has no credential');
  }
  if (fileRecord && native.record
      && fileRecord.access_token !== native.record.access_token) {
    throw new Error('credential_conflict: native and fallback credentials differ');
  }
  if (!marker) {
    if (fileRecord && native.record) {
      if (fileRecord.access_token !== native.record.access_token) {
        throw new Error('credential_conflict: native and fallback credentials differ');
      }
      marker = native.supported ? 'native' : 'file';
    } else if (fileRecord) {
      if (native.supported && native.record) throw new Error('credential_conflict');
      marker = 'file';
    } else if (native.record) {
      marker = 'native';
    }
    if (marker) {
      config.credential_backends[origin] = marker;
      await durableWriteJson(statePaths.config, config);
    }
  }
  return {
    backend: marker,
    record: marker === 'native' ? native.record : marker === 'file' ? fileRecord : null,
    copies: { native: native.record, file: fileRecord },
  };
}

async function reconcileCredentialAfterStatus(origin, accessToken, status) {
  const normalizedExpiry = new Date(status.expires_at).toISOString();
  const authoritative = validateRecord({
    access_token: accessToken,
    expires_at: normalizedExpiry,
    scopes: status.scopes,
    client_id: status.client_id,
  }, 'server credential metadata');

  return withStateLock(async (statePaths) => {
    const config = await loadConfig(statePaths);
    const current = await reconcileOriginLocked(statePaths, config, origin);
    if (!current.record || current.record.access_token !== accessToken) {
      throw new Error('credential_store_changed');
    }

    if (current.backend === 'native') {
      if (JSON.stringify(current.record) !== JSON.stringify(authoritative)) {
        await setNativeRecord(origin, authoritative);
      }
      if (current.copies.file) {
        const credentials = await loadCredentials(statePaths);
        delete credentials.servers[origin];
        await durableWriteJson(statePaths.credentials, credentials);
      }
    } else if (current.backend === 'file') {
      if (JSON.stringify(current.record) !== JSON.stringify(authoritative)) {
        const credentials = await loadCredentials(statePaths);
        credentials.servers[origin] = authoritative;
        await durableWriteJson(statePaths.credentials, credentials);
      }
      if (current.copies.native) await deleteNativeRecord(origin);
    } else {
      throw new Error('credential_store_inconsistent: credential has no backend');
    }
    return current.backend;
  });
}

async function getPersistedCredential(origin) {
  return withStateLock(async (statePaths) => {
    const config = await loadConfig(statePaths);
    return reconcileOriginLocked(statePaths, config, origin);
  });
}

async function getPersistedCopiesForLogout(origin) {
  return withStateLock(async (statePaths) => {
    const config = await loadConfig(statePaths);
    const credentials = await loadCredentials(statePaths);
    const marker = config.credential_backends[origin] || null;
    let native = { supported: false, record: null };
    let nativeError = false;
    try {
      native = await nativeRecord(origin);
    } catch {
      nativeError = true;
    }
    if (marker?.replace(/-pending$/, '') === 'native' && !native.supported) {
      nativeError = true;
    }
    const backend = marker?.replace(/-pending$/, '') || null;
    const fileRecord = credentials.servers[origin] || null;
    const selectedRecord = backend === 'file'
      ? fileRecord
      : backend === 'native' ? native.record : fileRecord || native.record;
    return {
      backend,
      record: selectedRecord,
      nativeError,
      copies: {
        file: fileRecord,
        native: native.record,
      },
    };
  });
}

async function storeCredential(origin, record, profileName) {
  validateRecord(record);
  return withStateLock(async (statePaths) => {
    const config = await loadConfig(statePaths);
    const resolved = resolveProfile(config, profileName);
    if (resolved.origin !== origin) throw new Error('profile_mapping_changed');
    const state = await reconcileOriginLocked(statePaths, config, origin);
    if (state.record) throw new Error('A credential already exists for this origin');
    let backend = state.backend;
    if (!backend) {
      const native = await nativeRecord(origin);
      backend = native.supported ? 'native' : 'file';
    }
    config.credential_backends[origin] = `${backend}-pending`;
    await durableWriteJson(statePaths.config, config);
    if (backend === 'native') {
      await setNativeRecord(origin, record);
    } else {
      const credentials = await loadCredentials(statePaths);
      credentials.servers[origin] = record;
      await durableWriteJson(statePaths.credentials, credentials);
      const verified = await loadCredentials(statePaths);
      if (JSON.stringify(verified.servers[origin]) !== JSON.stringify(record)) {
        throw new Error('Fallback credential read-back failed');
      }
    }
    config.credential_backends[origin] = backend;
    await durableWriteJson(statePaths.config, config);
    return backend;
  });
}

async function removePersistedCopies(origin, backends, { forgetMarker = false } = {}) {
  return withStateLock(async (statePaths) => {
    const config = await loadConfig(statePaths);
    const credentials = await loadCredentials(statePaths);
    const markedBackend = config.credential_backends[origin]?.replace(/-pending$/, '') || null;
    let nativeRemovalFailed = false;
    if (backends.has('file')) {
      delete credentials.servers[origin];
      await durableWriteJson(statePaths.credentials, credentials);
    }
    if (backends.has('native')) {
      try {
        const removed = await deleteNativeRecord(origin);
        if (!removed) throw new Error('Native credential store is unavailable');
      } catch (err) {
        if (!forgetMarker) throw err;
        nativeRemovalFailed = true;
      }
    }
    if (forgetMarker) {
      delete config.credential_backends[origin];
      await durableWriteJson(statePaths.config, config);
      return { nativeRemovalFailed };
    }
    const remainingFile = (await loadCredentials(statePaths)).servers[origin];
    let nativeRemains = markedBackend === 'native' && !backends.has('native');
    if (backends.has('native')) {
      nativeRemains = !!(await nativeRecord(origin)).record;
    }
    if (!remainingFile && !nativeRemains) {
      delete config.credential_backends[origin];
      await durableWriteJson(statePaths.config, config);
    }
    return { nativeRemovalFailed: false };
  });
}

async function mutateProfiles(mutator) {
  return withStateLock(async (statePaths) => {
    const config = await loadConfig(statePaths);
    const credentials = await loadCredentials(statePaths);
    const result = await mutator(config, credentials);
    validateConfig(config);
    await durableWriteJson(statePaths.config, config);
    return result;
  });
}

async function removeProfile(name) {
  return withStateLock(async (statePaths) => {
    const config = await loadConfig(statePaths);
    if (['production', 'local'].includes(name)) {
      throw new Error(`The ${name} profile is immutable`);
    }
    if (config.default_profile === name) {
      throw new Error('The current default profile cannot be removed');
    }
    const target = resolveProfile(config, name);
    const aliases = ['production', 'local', ...Object.keys(config.profiles)]
      .filter((candidate) => candidate !== name)
      .filter((candidate) => resolveProfile(config, candidate).origin === target.origin);
    if (!aliases.length) {
      const credentials = await loadCredentials(statePaths);
      const native = await nativeRecord(target.origin);
      if (credentials.servers[target.origin]
          || native.record
          || config.credential_backends[target.origin]) {
        throw new Error('Revoke or remove the origin credential before removing its last profile');
      }
    }
    delete config.profiles[name];
    await durableWriteJson(statePaths.config, validateConfig(config));
  });
}

async function environmentCredential(origin) {
  const token = process.env.SOCIAL_VIBECODING_TOKEN;
  const server = process.env.SOCIAL_VIBECODING_SERVER;
  if (!token && !server) return null;
  if (!token || !server) {
    throw new Error('SOCIAL_VIBECODING_TOKEN requires SOCIAL_VIBECODING_SERVER');
  }
  const normalized = canonicalOrigin(server);
  if (!normalized || normalized !== origin) {
    throw new Error('Environment credential server does not match the selected profile');
  }
  if (!isCanonicalSecret(token, 'access')) {
    throw new Error('Environment credential token is malformed');
  }
  return {
    source: 'environment',
    record: {
      access_token: token,
      expires_at: '1970-01-01T00:00:00.000Z',
      scopes: REQUIRED_SCOPES,
      client_id: CLIENT_ID,
    },
  };
}

module.exports = {
  PROFILE_RE,
  PRODUCTION_ORIGIN,
  LOCAL_ORIGIN,
  userConfigDirectory,
  pathsForState,
  canonicalOrigin,
  defaultConfig,
  validateConfig,
  validateCredentials,
  validateRecord,
  isUtcRfc3339,
  nativeRecordJson,
  parseNativeRecord,
  windowsApplicationDataDirectory,
  setPrivateWindowsAcl,
  verifyPrivateWindowsAcl,
  ensureDirectory,
  safeExistingFile,
  durableWriteJson,
  acquireLock,
  withStateLock,
  acquireOriginLock,
  loadConfig,
  loadCredentials,
  resolveProfile,
  selectedProfile,
  getPersistedCredential,
  reconcileCredentialAfterStatus,
  getPersistedCopiesForLogout,
  storeCredential,
  removePersistedCopies,
  mutateProfiles,
  removeProfile,
  environmentCredential,
};
