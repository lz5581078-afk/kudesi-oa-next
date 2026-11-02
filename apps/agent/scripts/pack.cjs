/**
 * 打包助手（先 npm run build）。产物在 release/：
 *   kudesi-assistant-windows/        首次安装用（install.ps1 + 程序），同时生成同名 UTF-8 .zip
 *   update/kudesi-assistant-<版本>.kapkg   在线升级包：在 OA“授权电脑”页上传它（gzip JSON，含每个文件的 sha256）
 *   update/kudesi-assistant-<版本>.kapkg.sha256 与 latest.json   升级包的 SHA-256 和清单，上传时可填 SHA-256 做二次核对
 * Windows 安装入口是 安装助手.cmd + 可视化绑定，自动下载并校验独立 Node 运行环境，详见 README。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
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
// Copy files explicitly: recursive cpSync can fail in Windows directories containing Chinese characters.
for (const file of walk(path.join(root, 'dist'))) {
  const target = path.join(out, 'dist', file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(root, 'dist', file), target);
}
fs.writeFileSync(path.join(out, 'package.json'), JSON.stringify({ name: pkg.name, version: pkg.version, private: true, main: pkg.main, dependencies: pkg.dependencies }, null, 2));
fs.copyFileSync(path.join(root, 'dist', 'launcher.js'), path.join(out, 'launcher.js'));
for (const f of ['install.ps1', 'uninstall.ps1', 'README.txt', 'setup.ps1', 'assistant-panel.ps1', '安装助手.cmd', '打开助手.cmd']) fs.copyFileSync(path.join(root, 'windows', f), path.join(out, f));
// UTF-8 ZIP STORE: system zip on macOS may omit the UTF-8 flag and corrupt Chinese filenames on Windows.
const entries = walk(out).map((name) => ({ name: `kudesi-assistant-windows/${name}`, data: fs.readFileSync(path.join(out, name)) }));
const records = [], directory = [];
let offset = 0;
for (const { name, data } of entries) {
  const filename = Buffer.from(name, 'utf8');
  let crc = 0xffffffff;
  for (const byte of data) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
  crc = (crc ^ 0xffffffff) >>> 0;
  const header = Buffer.alloc(30), central = Buffer.alloc(46);
  header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6); header.writeUInt16LE(0x21, 12);
  header.writeUInt32LE(crc, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(filename.length, 26);
  central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); header.copy(central, 6, 4, 30); central.writeUInt32LE(offset, 42);
  records.push(header, filename, data); directory.push(central, filename); offset += 30 + filename.length + data.length;
}
const central = Buffer.concat(directory), end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
const zipped = path.join(root, 'release', 'kudesi-assistant-windows.zip');
fs.writeFileSync(zipped, Buffer.concat([...records, central, end]));
console.log('已生成', out, zipped);
console.log('升级包', path.join(upd, kname), 'sha256', sha);
