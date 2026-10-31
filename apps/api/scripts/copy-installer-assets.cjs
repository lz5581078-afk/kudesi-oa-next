const fs = require('fs');
const path = require('path');

// Ship the canonical Windows templates inside the existing API build artifact.
const source = path.resolve(__dirname, '../../agent/windows');
const target = path.resolve(__dirname, '../dist/session/windows');
fs.mkdirSync(target, { recursive: true });
for (const name of ['install.ps1', 'uninstall.ps1', 'README.txt']) {
  fs.copyFileSync(path.join(source, name), path.join(target, name));
}
