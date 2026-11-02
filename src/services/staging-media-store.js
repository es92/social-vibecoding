'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

// Platform previews have no production bucket credentials. Their fake boot
// fixtures are rebuilt on every boot, including after container replacement.
// Keep these small files with that preview, never in the production bucket.
// This is not a store for production captures or a database-byte fallback.
function createStagingMediaStore({ directory = path.join(os.tmpdir(), 'homeroom-staging-media') } = {}) {
  const fileOf = (key) => {
    const match = /^media\/sha256\/([a-f0-9]{64})$/.exec(key);
    if (!match) throw new TypeError('Invalid media object key');
    return path.join(directory, match[1]);
  };
  return {
    async statObject(key) {
      try {
        const stat = await fsp.stat(fileOf(key));
        return { size: stat.size, lastModified: stat.mtime };
      } catch (err) { if (err.code === 'ENOENT') return null; throw err; }
    },
    async putObject(key, data) {
      const file = fileOf(key);
      await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
      const temporary = file + '.' + randomUUID();
      try {
        await fsp.writeFile(temporary, data, { flag: 'wx', mode: 0o600 });
        await fsp.rename(temporary, file);
      } finally { await fsp.rm(temporary, { force: true }); }
    },
    async getObjectStream(key, range = null) {
      return fs.createReadStream(fileOf(key), range ? { start: range.start, end: range.end } : {});
    },
  };
}

module.exports = { createStagingMediaStore };
