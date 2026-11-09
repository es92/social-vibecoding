'use strict';
// The trusted audit uploads data only. Homeroom reads the workflow artifact
// and owns request filing; CI has no issue-write or production credentials.
const fs = require('node:fs');
const path = require('node:path');
const { fromAssessments, readReport, MAX_BYTES } = require('../src/services/security-audit-report');

function collect(dir) {
  const reports = [];
  if (!fs.existsSync(dir)) return reports;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) reports.push(...collect(file));
    else if (entry.isFile() && entry.name === 'assessment.json') {
      try {
        if (fs.statSync(file).size > MAX_BYTES) throw new Error('Oversized assessment');
        reports.push(JSON.parse(fs.readFileSync(file, 'utf8')));
      } catch { reports.push(null); }
    }
  }
  return reports;
}

function main() {
  const [dir, output] = process.argv.slice(2);
  if (!dir || !output) throw new Error('Usage: security-audit-report.js INPUT_DIR OUTPUT.json');
  const report = fromAssessments(collect(dir), { repository: process.env.GITHUB_REPOSITORY,
    revision: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT });
  const json = JSON.stringify(report);
  readReport(json, report);
  fs.writeFileSync(output, json);
  console.log(`Security audit report: ${report.components.length}/5 components, complete=${report.complete}`);
}
if (require.main === module) { try { main(); } catch (err) { console.error(err.message); process.exitCode = 1; } }
module.exports = { collect };
