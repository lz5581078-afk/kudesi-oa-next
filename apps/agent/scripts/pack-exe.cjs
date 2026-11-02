/** NSIS official compiler required (Windows: choco install nsis, macOS: brew install makensis). */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const root = path.resolve(__dirname, '..');
const version = require('../package.json').version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid installer version');
const output = path.join(root, 'release', `KudesiAssistant-Setup-${version}.exe`);
const compiler = process.env.MAKENSIS || (process.platform === 'win32' ? path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'NSIS', 'makensis.exe') : 'makensis');
const flag = process.platform === 'win32' ? '/' : '-';
const result = cp.spawnSync(compiler, [`${flag}INPUTCHARSET`, 'UTF8', `${flag}DVERSION=${version}`, `${flag}DPACKAGE_DIR=${path.join(root, 'release', 'kudesi-assistant-windows')}`, `${flag}DPACKAGE_GLOB=${path.join(root, 'release', 'kudesi-assistant-windows', '*')}`, `${flag}DOUTPUT_FILE=${output}`, path.join(root, 'windows', 'installer.nsi')], { stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);
const head = fs.readFileSync(output);
if (head.toString('ascii', 0, 2) !== 'MZ') throw new Error('Invalid Windows executable');
console.log('Windows installer:', output, head.length, 'bytes');
