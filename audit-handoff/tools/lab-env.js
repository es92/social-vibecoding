// Print a fresh local-lab environment (JSON) with newly generated secrets. Nothing here is a real credential.
const crypto = require('node:crypto');
const hex = (n = 32) => crypto.randomBytes(n).toString('hex');
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
process.stdout.write(JSON.stringify({
  ADMIN_USERNAME: 'localadmin',
  ADMIN_PASSWORD: `labpass-${hex(6)}`,
  SESSION_SECRET: hex(), USERNODE_DOMAIN: 'localhost', CLI_CANONICAL_ORIGIN: 'http://localhost:3000',
  USERNODE_DB_PASSWORD: 'localdev', DATA_ENCRYPTION_KEY: hex(), JWT_SECRET: hex(),
  IFRAME_JWT_PRIVATE_KEY: privateKey, IFRAME_JWT_PUBLIC_KEY: publicKey,
  WORKER_JWT_SECRET: hex(), EDGE_JWT_SECRET: hex(),
  NODE_RPC_URL: 'http://127.0.0.1:9', EXPLORER_UPSTREAM: '127.0.0.1:9', TOPOCHAIN_PARTNER_API_KEY: hex(),
  NATIVE_SESSION_V2_TESTNET_CHAIN_ID: process.env.LAB_CHAIN_ID || 'utc18fphrjfuwjgm4p9hudsx4a9tsewgzckacw9082d5e03uevl9h9vssqxune',
  USERNODE_LOCAL_DEV: '1', SHOTS_ENABLED: 'true', APP_HEAL_INTERVAL_MS: '0',
  DATABASE_URL: 'postgres://usernode:localdev@127.0.0.1:5432/usernode',
  NODE_ENV: 'development', MAX_APPS: '0', PORT: '3000',
}, null, 1));
