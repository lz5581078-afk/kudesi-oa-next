/**
 * 打包助手（先 npm run build）。产物在 release/：
 *   kudesi-assistant-windows/        首次安装用（install.ps1 + 程序），同时生成同名 .zip（Linux 有 zip 时）
 *   update/kudesi-assistant-<版本>.kapkg   在线升级包：在 OA“授权电脑”页上传它（gzip JSON，含每个文件的 sha256）
 *   update/kudesi-assistant-<版本>.kapkg.sha256 与 latest.json   升级包的 SHA-256 和清单，上传时可填 SHA-256 做二次核对
 * 旧系统是 NSIS 的 .exe 安装程序 + 内置 Node；这里的安装器是 install.ps1（需要电脑上已有 Node 20+），.exe 需在 Windows 上另行制作，见 README。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');
const root = path.join(__dirname, '..');
const pkg = require('../package.json');
const { encodeBundle } = require('../dist/bundle.js');
const { AGENT_VERSION } = require('../dist/version.js');
if (AGENT_VERSION !== pkg.version) throw new Error(`src/version.ts (${AGENT_VERSION}) 与 package.json (${pkg.version}) 版本不一致，先改成一致再打包`);

const walk = (dir, base = '') => fs.readdirSync(path.join(dir, base), { withFileTypes: true }).flatMap((e) => {
  const rel = base ? `${base}/${e.name}` : e.name;
  return e.isDirectory() ? walk(dir, rel) : [rel];
});
const distFiles = walk(path.join(root, 'dist')).filter((f) => /\.(js|json)$/.test(f));

// 1) 在线升级包
const upd = path.join(root, 'release', 'update');
fs.mkdirSync(upd, { recursive: true });
const bundle = encodeBundle({ version: pkg.version, dependencies: pkg.dependencies, files: [
  { path: 'package.json', data: Buffer.from(JSON.stringify({ name: pkg.name, version: pkg.version, private: true, main: pkg.main, dependencies: pkg.dependencies }, null, 2)) },
  ...distFiles.map((f) => ({ path: `dist/${f}`, data: fs.readFileSync(path.join(root, 'dist', f)) })),
] });
const kname = `kudesi-assistant-${pkg.version}.kapkg`;
const sha = crypto.createHash('sha256').update(bundle).digest('hex');
fs.writeFileSync(path.join(upd, kname), bundle);
fs.writeFileSync(path.join(upd, `${kname}.sha256`), `${sha}  ${kname}\n`);
fs.writeFileSync(path.join(upd, 'latest.json'), JSON.stringify({ version: pkg.version, file: kname, size: bundle.length, sha256: sha }, null, 2));

// 2) 首次安装目录：launcher.js 放根目录，程序放 versions/<版本>（install.ps1 负责落到 %LOCALAPPDATA%\KudesiAssistant\app）
const out = path.join(root, 'release', 'kudesi-assistant-windows');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
fs.cpSync(path.join(root, 'dist'), path.join(out, 'dist'), { recursive: true });
fs.writeFileSync(path.join(out, 'package.json'), JSON.stringify({ name: pkg.name, version: pkg.version, private: true, main: pkg.main, dependencies: pkg.dependencies }, null, 2));
fs.copyFileSync(path.join(root, 'dist', 'launcher.js'), path.join(out, 'launcher.js'));
for (const f of ['install.ps1', 'uninstall.ps1', 'README.txt']) fs.copyFileSync(path.join(root, 'windows', f), path.join(out, f));
let zipped = '';
try {
  const z = path.join(root, 'release', 'kudesi-assistant-windows.zip');
  fs.rmSync(z, { force: true });
  cp.execFileSync('zip', ['-q', '-r', z, 'kudesi-assistant-windows'], { cwd: path.join(root, 'release') });
  zipped = z;
} catch { /* 没有 zip 命令就只留目录 */ }
console.log('已生成', out, zipped);
console.log('升级包', path.join(upd, kname), 'sha256', sha);
