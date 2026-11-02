'use strict';

const media = require('./media-store');
const { metadata } = require('./check-visual-media');

// Fake media seeded by the existing staging-only boot fixtures. Upload and
// reference commit together, just as real capture saves do. No fixture may
// leave a key referring to an upload whose transaction has rolled back.
async function withStagingMedia(pool, data, contentType, write) {
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    const key = await media.put(tx, media.getStore(), data, contentType);
    const result = await write(tx, { key, ...metadata(data) });
    await tx.query('COMMIT');
    return result;
  } catch (err) {
    await tx.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    tx.release();
  }
}

module.exports = { withStagingMedia };
