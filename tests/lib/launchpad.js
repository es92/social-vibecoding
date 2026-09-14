const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const filename = path.join(__dirname, '../../frontend/src/features/dev-chat/launchpad.js');
const sandbox = { module: { exports: {} } };
vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename });
module.exports = sandbox.module.exports;
