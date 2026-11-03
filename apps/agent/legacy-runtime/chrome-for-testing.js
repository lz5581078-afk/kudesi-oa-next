const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const { agentDataDir } = require('./config');

const CHROME_FOR_TESTING_VERSION = '151.0.7922.71';
const CHROME_FOR_TESTING_ARCHIVE_SHA256 = '7ea2e94833ef710026c8cb08d0d2dafcb13f5d304d9c475ac07a3fa8c11d846c';
const RUNTIME_ERROR = '专用Chrome尚未安装或已损坏';

function chromeForTestingRoot() {
  return path.join(agentDataDir(), 'runtime', 'chrome-for-testing');
}

function chromeForTestingExecutablePath() {
  return path.join(chromeForTestingRoot(), 'chrome-win64', 'chrome.exe');
}

function runtimeManifestPath() {
  return path.join(chromeForTestingRoot(), 'runtime-manifest.json');
}

async function sha256File(target) {
  const hash = crypto.createHash('sha256');
  const handle = await fs.open(target, 'r');
  try {
    for await (const chunk of handle.createReadStream()) hash.update(chunk);
  } finally {
    await handle.close().catch(() => undefined);
  }
  return hash.digest('hex');
}

function runtimeError(detail) {
  return new Error(`${RUNTIME_ERROR}${detail ? `：${detail}` : ''}`);
}

async function assertChromeForTestingExecutable(executablePath) {
  const expected = path.resolve(chromeForTestingExecutablePath());
  const resolved = path.resolve(String(executablePath || ''));
  if (resolved.toLowerCase() !== expected.toLowerCase()) {
    throw runtimeError('只允许助手运行时目录中的 Chrome for Testing');
  }
  let stat;
  let manifest;
  try {
    stat = await fs.stat(resolved);
    manifest = JSON.parse(await fs.readFile(runtimeManifestPath(), 'utf8'));
  } catch {
    throw runtimeError('浏览器主程序或运行时清单不存在');
  }
  if (!stat.isFile() || stat.size < 1_000_000) throw runtimeError('浏览器主程序无效');
  if (manifest.product !== 'chrome' || manifest.platform !== 'win64' ||
      manifest.version !== CHROME_FOR_TESTING_VERSION ||
      manifest.archiveSha256 !== CHROME_FOR_TESTING_ARCHIVE_SHA256 ||
      !/^[a-f0-9]{64}$/.test(String(manifest.executableSha256 || ''))) {
    throw runtimeError('运行时清单无效');
  }
  if (await sha256File(resolved) !== manifest.executableSha256) {
    throw runtimeError('浏览器主程序完整性校验失败');
  }
  return resolved;
}

function bootstrapScriptPath() {
  return path.join(__dirname, 'windows', 'bootstrap.ps1');
}

async function runBootstrap(script = bootstrapScriptPath()) {
  await new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
      '-File', script, '-InstallOnly'
    ], { windowsHide: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`浏览器组件安装失败（${code ?? signal ?? 'unknown'}）`));
    });
  });
}

async function ensureChromeForTestingRuntime(options = {}) {
  const executablePath = chromeForTestingExecutablePath();
  try {
    return await assertChromeForTestingExecutable(executablePath);
  } catch (initialError) {
    try {
      await (options.bootstrapRunner || runBootstrap)();
      return await assertChromeForTestingExecutable(executablePath);
    } catch (error) {
      throw runtimeError(error?.message || initialError?.message);
    }
  }
}

async function readChromeForTestingRuntimeInfo() {
  const executablePath = await assertChromeForTestingExecutable(chromeForTestingExecutablePath());
  const manifest = JSON.parse(await fs.readFile(runtimeManifestPath(), 'utf8'));
  return { browserType: 'Chrome for Testing', executablePath, version: manifest.version };
}

async function writeBrowserRuntimeLog(profile) {
  const runtime = await readChromeForTestingRuntimeInfo();
  const target = path.join(agentDataDir(), 'logs', 'browser-runtime.log');
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const entry = {
    at: new Date().toISOString(),
    ...runtime,
    localProfileId: profile.localProfileId,
    profileDir: path.join(agentDataDir(), 'profiles', profile.platformCode || 'pdd', profile.localProfileId)
  };
  await fs.appendFile(target, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 });
}

module.exports = {
  CHROME_FOR_TESTING_ARCHIVE_SHA256,
  CHROME_FOR_TESTING_VERSION,
  RUNTIME_ERROR,
  assertChromeForTestingExecutable,
  chromeForTestingExecutablePath,
  chromeForTestingRoot,
  ensureChromeForTestingRuntime,
  readChromeForTestingRuntimeInfo,
  runtimeManifestPath,
  writeBrowserRuntimeLog
};
