const fs = require('fs');
const path = require('path');

// Ship the canonical Windows templates inside the existing API build artifact.
const source = path.resolve(__dirname, '../../agent/windows');
const target = path.resolve(__dirname, '../dist/session/windows');
fs.mkdirSync(target, { recursive: true });
for (const name of ['install.ps1', 'uninstall.ps1', 'README.txt', 'setup.ps1', 'assistant-panel.ps1', '安装助手.cmd', '打开助手.cmd']) {
  fs.copyFileSync(path.join(source, name), path.join(target, name));
}

// Ship the verified original session runtime; never load a developer's old checkout.
const legacySource = path.resolve(__dirname, '../src/session/legacy-runtime');
const legacyTarget = path.resolve(__dirname, '../dist/session/legacy-runtime');
fs.mkdirSync(legacyTarget, { recursive: true });
// Node's native recursive copy can terminate the Windows process on a Unicode
// checkout path. Copy the same regular files without that native traversal.
function copyLegacyTree(sourceDir, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const from = path.join(sourceDir, entry.name);
    const to = path.join(targetDir, entry.name);
    if (entry.isDirectory()) copyLegacyTree(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
    else throw new Error('Legacy build assets must be regular files and directories');
  }
}
copyLegacyTree(path.join(legacySource, 'vendor'), path.join(legacyTarget, 'vendor'));
fs.copyFileSync(path.join(legacySource, 'snapshot-manifest.json'), path.join(legacyTarget, 'snapshot-manifest.json'));
