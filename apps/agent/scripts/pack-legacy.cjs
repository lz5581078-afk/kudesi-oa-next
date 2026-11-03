/** Repackage verified 0.3.44 runtimes with the scoped 0.3.45 source snapshot.
 * No download, install, agent startup, browser launch, or existing-file deletion.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const SOURCE_INSTALLER_SHA256 = 'a20e958a63fe967472270156f42729e16f249e24750ccc69530c626baaf52255';
const SOURCE_COMMIT = '0fb7fdad2f3805e3579bd4f870199c880668aaa1';
const SOURCE_VERSION = '0.3.44';
const FORBIDDEN = new Set(['.env', '.git', '.ssh', 'agent.json', 'profiles', 'cookies', 'cookie', 'credentials.json', 'private-key.pem', 'privatekey.pem', 'id_rsa', 'storage-state.json', 'storagestate.json']);
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const hashFile = file => sha256(fs.readFileSync(file));
const json = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
const stripBom = bytes => bytes.subarray(0, 3).equals(BOM) ? bytes.subarray(3) : bytes;

function safeRelative(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || path.posix.isAbsolute(value) || /^[A-Za-z]:/.test(value) || value.split('/').some(p => !p || p === '.' || p === '..' || FORBIDDEN.has(p.toLowerCase()))) {
    throw new Error('Unsafe or forbidden package path');
  }
  return value;
}
function walk(root, base = '') {
  if (fs.lstatSync(path.join(root, base)).isSymbolicLink()) throw new Error('Package directory cannot be a link');
  const result = [];
  for (const entry of fs.readdirSync(path.join(root, base), { withFileTypes: true })) {
    const rel = safeRelative(base ? `${base}/${entry.name}` : entry.name), target = path.join(root, rel);
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) throw new Error(`Package link rejected: ${rel}`);
    if (stat.isDirectory()) result.push(...walk(root, rel));
    else if (stat.isFile()) result.push(rel);
    else throw new Error(`Non-regular package entry: ${rel}`);
  }
  return result.sort();
}
function assertNoPrivateMaterial(root, files) {
  for (const rel of files) {
    safeRelative(rel);
    // Private-key generation code is legitimate; actual PEM key data is not.
    if (/-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/.test(fs.readFileSync(path.join(root, rel)).toString('latin1'))) throw new Error(`Private key material rejected: ${rel}`);
  }
}
function verifyCoreTree(root, expectedVersion) {
  const manifest = json(path.join(root, 'core-manifest.json'));
  if (manifest.product !== 'SessionManagerAgent' || manifest.platform !== 'win32-x64' || manifest.version !== expectedVersion || !manifest.files || Array.isArray(manifest.files)) throw new Error('Invalid core manifest identity');
  const actual = walk(root), expected = Object.keys(manifest.files).map(safeRelative).sort();
  if (expected.includes('core-manifest.json') || JSON.stringify(actual) !== JSON.stringify([...expected, 'core-manifest.json'].sort())) throw new Error('Core manifest file set mismatch');
  for (const rel of expected) {
    if (!/^[a-f0-9]{64}$/.test(manifest.files[rel]) || hashFile(path.join(root, rel)) !== manifest.files[rel]) throw new Error(`Core checksum mismatch: ${rel}`);
  }
  assertNoPrivateMaterial(root, actual);
  return { manifest, fileCount: actual.length };
}
function verifySnapshot(root) {
  const file = path.join(root, 'snapshot-manifest.json'), manifest = json(file), seen = new Set();
  if (manifest.formatVersion !== 1 || manifest.sourceCommit !== SOURCE_COMMIT || manifest.sourceVersion !== SOURCE_VERSION || manifest.version !== '0.3.45' || !Array.isArray(manifest.files) || !manifest.files.length) throw new Error('Unexpected legacy source snapshot');
  for (const entry of manifest.files) {
    const rel = safeRelative(entry.snapshot);
    if (!/^(?:[a-z][a-z0-9-]*\.js|version\.json|platforms\/[a-z][a-z0-9-]*\.js|windows\/[a-z][a-z0-9.-]*\.(?:ps1|nsi))$/.test(rel) || seen.has(rel)) throw new Error('Unexpected source snapshot entry');
    seen.add(rel);
    const target = path.join(root, rel);
    if (fs.lstatSync(target).isSymbolicLink() || !/^[a-f0-9]{64}$/.test(entry.sha256) || hashFile(target) !== entry.sha256 || !/^[a-f0-9]{64}$/.test(entry.sourceSha256)) throw new Error(`Source snapshot checksum mismatch: ${rel}`);
    if (!entry.modified && entry.sha256 !== entry.sourceSha256) throw new Error(`Unmodified source checksum changed: ${rel}`);
  }
  if (json(path.join(root, 'version.json')).version !== manifest.version) throw new Error('Source version mismatch');
  return { manifest, sha256: hashFile(file) };
}
function freshOutput(releaseRoot, version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid output version');
  fs.mkdirSync(releaseRoot, { recursive: true });
  if (fs.lstatSync(releaseRoot).isSymbolicLink()) throw new Error('Release root cannot be a link');
  return fs.mkdtempSync(path.join(releaseRoot, `legacy-${version}-`));
}
function copyTree(source, target, files) {
  for (const rel of files) {
    const destination = path.join(target, safeRelative(rel));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(source, rel), destination, fs.constants.COPYFILE_EXCL);
  }
}
function tool(executable, args, options = {}) {
  const result = spawnSync(executable, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 12 * 1024 * 1024, ...options });
  if (result.error || result.status !== 0) throw new Error(`Build tool failed: ${path.basename(executable)} (exit ${result.status})\n${result.stderr || result.stdout || result.error?.message || ''}`);
  return result.stdout.trim();
}
function artifact(file) { return { fileName: path.basename(file), path: path.resolve(file), size: fs.statSync(file).size, sha256: hashFile(file) }; }
function extract(sevenzip, archive, destination) {
  fs.mkdirSync(destination); // Never extract into a pre-existing directory.
  tool(sevenzip, ['x', '-y', '-bd', '-bso0', '-bsp0', `-o${destination}`, archive]);
}
function ps1Bytes(source) { return Buffer.concat([BOM, stripBom(source)]); }

async function pack(options) {
  for (const key of ['sourceInstaller', 'sourceManifest', 'sevenzip', 'makensis']) if (!options[key]) throw new Error(`Explicit ${key} input is required`);
  const agentRoot = path.resolve(__dirname, '..'), sourceRoot = path.join(agentRoot, 'legacy-runtime');
  const snapshot = verifySnapshot(sourceRoot), version = snapshot.manifest.version;
  const oldInstaller = path.resolve(options.sourceInstaller), old = json(path.resolve(options.sourceManifest));
  if (hashFile(oldInstaller) !== SOURCE_INSTALLER_SHA256 || old.version !== SOURCE_VERSION || old.product !== 'SessionManagerAgent' || old.platform !== 'win32-x64' || old.installer?.sha256 !== SOURCE_INSTALLER_SHA256 || Number(old.installer.size) !== fs.statSync(oldInstaller).size || old.installer.fileName !== path.basename(oldInstaller)) throw new Error('Source installer identity/checksum mismatch');
  const sevenzip = path.resolve(options.sevenzip), makensis = path.resolve(options.makensis);
  const sevenInfo = tool(sevenzip, ['i']);
  if (!/7-Zip 26\.05 \(x64\)/.test(sevenInfo) || tool(makensis, ['/VERSION']) !== 'v3.12') throw new Error('Expected full 7-Zip 26.05 x64 and NSIS 3.12');
  const out = freshOutput(path.join(agentRoot, 'release'), version);
  console.log(`[legacy-pack] ${out}`);
  tool(sevenzip, ['t', '-bd', '-bso0', '-bsp0', oldInstaller]);
  const extractedSource = path.join(out, 'verified-source-installer');
  extract(sevenzip, oldInstaller, extractedSource);
  const oldPackage = path.join(extractedSource, '$PLUGINSDIR', 'KudesiSessionManagerAgent');
  const sourceTree = verifyCoreTree(oldPackage, SOURCE_VERSION);
  const sourceComponents = json(path.join(oldPackage, 'app/component-manifest.json'));
  if (sourceComponents.version !== SOURCE_VERSION || sourceComponents.product !== old.product || sourceComponents.platform !== old.platform || JSON.stringify(sourceComponents) !== JSON.stringify(old.components)) throw new Error('Source component manifest mismatch');
  const nodeRuntime = json(path.join(oldPackage, 'app/runtime/node/runtime-manifest.json'));
  const nativePaths = ['app/runtime/node/node.exe', 'app/runtime/remote-capture/Kudesi.RemoteCapture.exe', 'app/runtime/remote-capture/kudesi-webrtc-bridge.dll'];
  const nativeHashes = nativePaths.map(rel => ({ path: rel, sha256: hashFile(path.join(oldPackage, rel)) }));
  if (nodeRuntime.version !== sourceComponents.nodeRuntime || nodeRuntime.executableSha256 !== nativeHashes[0].sha256 || sourceComponents.captureSidecar !== nativeHashes[1].sha256 || sourceComponents.webrtcBridge !== nativeHashes[2].sha256) throw new Error('Source native component checksum mismatch');
  if (hashFile(path.join(oldPackage, 'app/index.js')) !== sourceComponents.agentCore) throw new Error('Source agent core checksum mismatch');
  console.log(`[legacy-pack] Verified original installer and ${sourceTree.fileCount} extracted files; reusing native binaries`);
  const packageDir = path.join(out, `SessionManagerAgent-${version}`);
  fs.mkdirSync(packageDir);
  copyTree(oldPackage, packageDir, Object.keys(sourceTree.manifest.files));
  const encodingTransforms = [];
  for (const entry of snapshot.manifest.files) {
    const rel = safeRelative(entry.snapshot), bytes = fs.readFileSync(path.join(sourceRoot, rel));
    const destinations = rel.startsWith('windows/') ? [rel, ...(sourceTree.manifest.files[`app/${rel}`] ? [`app/${rel}`] : [])] : [`app/${rel}`];
    for (const target of destinations) {
      const packaged = rel.endsWith('.ps1') ? ps1Bytes(bytes) : bytes;
      fs.mkdirSync(path.dirname(path.join(packageDir, target)), { recursive: true });
      fs.writeFileSync(path.join(packageDir, target), packaged);
      if (!packaged.equals(bytes)) encodingTransforms.push({ path: target, transformation: 'UTF-8 BOM only for Windows PowerShell 5.1', sourceSha256: entry.sha256, packagedSha256: sha256(packaged), bodySha256: sha256(stripBom(bytes)) });
      if (!stripBom(packaged).equals(stripBom(bytes))) throw new Error('Packaging changed PowerShell/source body');
    }
  }
  const appPackage = json(path.join(packageDir, 'app/package.json'));
  appPackage.version = version;
  fs.writeFileSync(path.join(packageDir, 'app/package.json'), `${JSON.stringify(appPackage, null, 2)}\n`);
  const components = { ...sourceComponents, version, agentCore: hashFile(path.join(packageDir, 'app/index.js')) };
  fs.writeFileSync(path.join(packageDir, 'app/component-manifest.json'), `${JSON.stringify(components, null, 2)}\n`);
  for (const file of nativeHashes) if (hashFile(path.join(packageDir, file.path)) !== file.sha256) throw new Error('A reused native binary changed');
  const files = Object.fromEntries(walk(packageDir).map(rel => [rel, hashFile(path.join(packageDir, rel))]));
  assertNoPrivateMaterial(packageDir, Object.keys(files));
  writeJson(path.join(packageDir, 'core-manifest.json'), { product: old.product, version, platform: old.platform, files });
  verifyCoreTree(packageDir, version);

  const bundledNode = path.join(packageDir, 'app/runtime/node/node.exe');
  if (tool(bundledNode, ['-v']) !== `v${sourceComponents.nodeRuntime}`) throw new Error('Bundled Node version mismatch');
  const smoke = `const assert=require('node:assert/strict'),path=require('node:path');const root=process.argv[1],c=require(path.join(root,'config.js'));assert.equal(c.AGENT_VERSION,${JSON.stringify(version)});const a={serverUrl:'http://127.0.0.1:1',profileNamespace:'v1:1:finance_withdrawal',shops:{'1':{storeId:'1',platformCode:'pdd',localProfileId:'old-test-profile'}}};const p=c.ensureShopProfile(a,1,'synthetic','pdd');assert.notEqual(p.localProfileId,'old-test-profile');assert.equal(c.ensureShopProfile(a,1,'synthetic','pdd').localProfileId,p.localProfileId);const b={serverUrl:a.serverUrl,profileNamespace:'v1:1:company_store_maintenance',shops:{}};assert.notEqual(c.ensureShopProfile(b,1,'synthetic','pdd').localProfileId,p.localProfileId);require(path.join(root,'api.js'));require(path.join(root,'node_modules/playwright-core'));require(path.join(root,'node_modules/ws'));console.log('bundled-node-config-and-dependencies-ok');`;
  tool(bundledNode, ['-e', smoke, path.join(packageDir, 'app')]);
  console.log('[legacy-pack] Bundled Node, pure profile namespace functions and dependencies passed; no agent started');

  const installer = path.join(out, `KudesiSessionManagerAgent-Setup-${version}.exe`);
  console.log('[legacy-pack] Compiling unsigned test installer with existing Windows template');
  tool(makensis, ['/INPUTCHARSET', 'UTF8', `/DVERSION=${version}`, `/DPACKAGE_DIR=${packageDir}`, `/DOUTPUT_DIR=${out}`, '/DUNSIGNED_TEST=1', path.join(sourceRoot, 'windows/installer.nsi')], { env: { ...process.env, NSISDIR: path.dirname(makensis) } });
  if (fs.readFileSync(installer).subarray(0, 2).toString() !== 'MZ') throw new Error('Installer is not a Windows executable');
  const update = path.join(out, `SessionManagerAgent-${version}.zip`);
  console.log('[legacy-pack] Creating old-protocol ZIP update package');
  tool(sevenzip, ['a', '-tzip', '-mx=6', '-mcu=on', '-bd', '-bso0', '-bsp0', update, 'app', 'windows', 'core-manifest.json'], { cwd: packageDir });
  tool(sevenzip, ['t', '-bd', '-bso0', '-bsp0', update]);
  const verifyZip = path.join(out, 'verified-update');
  extract(sevenzip, update, verifyZip);
  verifyCoreTree(verifyZip, version);
  const verifyExe = path.join(out, 'verified-new-installer');
  extract(sevenzip, installer, verifyExe);
  const extractedPackage = path.join(verifyExe, '$PLUGINSDIR', 'KudesiSessionManagerAgent');
  verifyCoreTree(extractedPackage, version);
  for (const rel of walk(packageDir)) {
    const sha = hashFile(path.join(packageDir, rel));
    if (hashFile(path.join(verifyZip, rel)) !== sha || hashFile(path.join(extractedPackage, rel)) !== sha) throw new Error(`Archive extraction differs from package: ${rel}`);
  }
  console.log('[legacy-pack] ZIP CRC and all files extracted from ZIP/NSIS match rebuilt SHA-256 manifest');

  const powershell = path.join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const parseScript = `$ProgressPreference='SilentlyContinue';$ErrorActionPreference='Stop';if($PSVersionTable.PSVersion.Major-ne 5){throw 'Expected Windows PowerShell 5.1'};$count=0;foreach($dir in @('windows','app/windows')){foreach($f in Get-ChildItem -LiteralPath (Join-Path $env:KUDESI_PACK_PARSE_ROOT $dir) -Filter *.ps1){$t=$null;$e=$null;[System.Management.Automation.Language.Parser]::ParseFile($f.FullName,[ref]$t,[ref]$e)|Out-Null;if($e.Count){throw ('PowerShell parse failed: '+$f.Name)};$count++}};[pscustomobject]@{version=$PSVersionTable.PSVersion.ToString();parsed=$count;errors=0}|ConvertTo-Json -Compress`;
  const powershellCheck = JSON.parse(tool(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(parseScript, 'utf16le').toString('base64')], { env: { ...process.env, KUDESI_PACK_PARSE_ROOT: packageDir } }));
  const installerArtifact = artifact(installer), updateArtifact = artifact(update);
  for (const item of [installerArtifact, updateArtifact]) fs.writeFileSync(path.join(out, `${item.fileName}.sha256`), `${item.sha256}  ${item.fileName}\n`, { flag: 'wx' });
  const latest = { product: old.product, version, platform: old.platform, minimumUpdaterVersion: old.minimumUpdaterVersion,
    runtime: old.runtime, buildTools: { ...old.buildTools, nsisVersion: '3.12', sevenZipVersion: '26.05' },
    installer: { fileName: installerArtifact.fileName, size: installerArtifact.size, sha256: installerArtifact.sha256, signed: false },
    update: { fileName: updateArtifact.fileName, size: updateArtifact.size, sha256: updateArtifact.sha256 }, components, patches: {} };
  writeJson(path.join(out, 'latest.json'), latest);
  const proof = { formatVersion: 1, version, sourceCommit: SOURCE_COMMIT,
    sourceInstaller: { fileName: path.basename(oldInstaller), sha256: SOURCE_INSTALLER_SHA256, version: SOURCE_VERSION },
    sourceCoreManifestSha256: hashFile(path.join(oldPackage, 'core-manifest.json')), sourceSnapshotSha256: snapshot.sha256,
    reusedNativeBinaries: nativeHashes, encodingTransforms, packagedFiles: Object.keys(files).length,
    checks: { sourceInstallerAndCore: true, sourceSnapshot: true, nativeHashesUnchanged: true, bundledNodeAndPureConfig: true, zipCrc: true, extractedZipAllFiles: true, extractedNsisAllFiles: true, windowsPowerShell: powershellCheck },
    tools: { sevenzipSha256: hashFile(sevenzip), makensisSha256: hashFile(makensis) },
    artifacts: { installer: installerArtifact, update: updateArtifact, latest: artifact(path.join(out, 'latest.json')) },
    limitations: { signed: false, testInstaller: true, installed: false, agentStarted: false, merchantBrowserStarted: false, nativeCaptureRuntimeExecuted: false, realRemoteVerified: false, requiresChromeDownloadOnInstall: true } };
  writeJson(path.join(out, 'build-proof.json'), proof);
  console.log(JSON.stringify({ output: out, installer: installerArtifact, update: updateArtifact, latest: path.join(out, 'latest.json'), proof: path.join(out, 'build-proof.json'), checks: proof.checks, signed: false }, null, 2));
  return proof;
}

function cli(argv) {
  const names = { '--source-installer': 'sourceInstaller', '--source-manifest': 'sourceManifest', '--sevenzip': 'sevenzip', '--makensis': 'makensis' }, options = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!names[argv[i]] || !argv[i + 1]) throw new Error('Usage: node pack-legacy.cjs --source-installer <verified-old.exe> --source-manifest <old-latest.json> --sevenzip <full-7z.exe> --makensis <makensis.exe>');
    options[names[argv[i]]] = argv[i + 1];
  }
  return pack(options);
}
if (require.main === module) cli(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { SOURCE_INSTALLER_SHA256, safeRelative, walk, assertNoPrivateMaterial, verifyCoreTree, verifySnapshot, freshOutput, ps1Bytes, stripBom, sha256, pack };
