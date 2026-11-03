const crypto = require('crypto');
const fs = require('fs/promises');
const fssync = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { agentApi } = require('./api');
const { agentDataDir } = require('./config');
const { AGENT_VERSION } = require('./config');
const { patchAgentStatus, writeAgentStatus } = require('./status');
const { compareSemanticVersions, versionConclusion } = require('./state-model');

const MAX_UPDATE_BYTES = 150 * 1024 * 1024;

async function report(config, jobId, status, errorMessage = '', details = {}) {
  return agentApi(config, `/api/session-manager/agent/update-jobs/${jobId}`, {
    method: 'PATCH', body: JSON.stringify({ status, errorMessage, ...details })
  });
}

function updateDirectory() {
  return path.join(agentDataDir(), 'updates');
}

function updateResultPath() {
  return path.join(updateDirectory(), 'update-result.json');
}

async function processPendingUpdateResult(config) {
  const target = updateResultPath();
  let result;
  try {
    result = JSON.parse(await fs.readFile(target, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    await fs.rename(target, `${target}.invalid-${Date.now()}`).catch(() => undefined);
    return null;
  }
  if (!result?.jobId || !['succeeded', 'failed', 'deferred'].includes(result.status)) return null;
  await report(config, result.jobId, result.status, result.errorMessage || '', {
    phase: result.phase || result.status,
    progress: result.status === 'succeeded' ? 100 : Number(result.progress || 0),
    failureCode: result.failureCode || ''
  });
  if (process.platform === 'win32') {
    const cleanup = spawn('powershell.exe', [
      '-NoProfile', '-Command',
      `Unregister-ScheduledTask -TaskName 'Kudesi Session Manager Agent Update ${result.jobId}' -Confirm:$false -ErrorAction SilentlyContinue`
    ], { windowsHide: true, stdio: 'ignore' });
    cleanup.unref();
  }
  await fs.rm(target, { force: true });
  return result;
}

async function checkLatestRelease(config) {
  try {
    const release = await agentApi(config, '/api/session-manager/agent/releases/windows/latest');
    const latestVersion = String(release.version || '');
    await patchAgentStatus({
      currentVersion: AGENT_VERSION,
      latestVersion,
      updateAvailable: compareSemanticVersions(AGENT_VERSION, latestVersion) < 0,
      versionConclusion: versionConclusion(AGENT_VERSION, latestVersion)
    });
    return release;
  } catch (error) {
    await patchAgentStatus({ latestVersion: '', updateAvailable: false, versionConclusion: '无法获取线上版本' });
    throw error;
  }
}

async function requestOwnUpdate(config) {
  return agentApi(config, '/api/session-manager/agent/update-jobs/request', { method: 'POST', body: '{}' });
}

async function downloadUpdate(config, job) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('更新包下载超时')), 5 * 60 * 1000);
  try {
    const response = await fetch(new URL(job.downloadUrl, config.serverUrl), {
      signal: controller.signal, headers: { authorization: `Bearer ${config.deviceToken}` }
    });
    if (!response.ok) throw new Error(`更新包下载失败（${response.status}）`);
    const declaredSize = Number(response.headers.get('content-length') || 0);
    if (declaredSize <= 0 || declaredSize > MAX_UPDATE_BYTES || declaredSize !== Number(job.size)) throw new Error('更新包大小无效');
    if (!response.body) throw new Error('更新包下载响应为空');
    const updateDir = updateDirectory();
    await fs.mkdir(updateDir, { recursive: true, mode: 0o700 });
    const target = path.join(updateDir, `SessionManagerAgent-${job.targetVersion}.zip`);
    const temporary = `${target}.${process.pid}.tmp`;
    const output = fssync.createWriteStream(temporary, { mode: 0o600, flags: 'wx' });
    const hash = crypto.createHash('sha256');
    let downloadedBytes = 0;
    let lastProgressAt = 0;
    try {
      for await (const chunk of response.body) {
        downloadedBytes += chunk.length;
        if (downloadedBytes > declaredSize || downloadedBytes > MAX_UPDATE_BYTES) throw new Error('更新包大小无效');
        hash.update(chunk);
        if (!output.write(chunk)) await new Promise((resolve) => output.once('drain', resolve));
        const now = Date.now();
        if (now - lastProgressAt >= 1_000) {
          lastProgressAt = now;
          await writeAgentStatus({ state: 'updating', currentStep: 'downloading', progress: Math.floor(downloadedBytes / declaredSize * 100) });
          await report(config, job.id, 'downloading', '', {
            phase: 'downloading',
            progress: Math.floor(downloadedBytes / declaredSize * 100),
            downloadedBytes,
            totalBytes: declaredSize,
            lastProgressAt: new Date(now).toISOString()
          });
        }
      }
      await new Promise((resolve, reject) => output.end((error) => error ? reject(error) : resolve()));
      if (downloadedBytes !== declaredSize) throw new Error('更新包下载不完整');
      await report(config, job.id, 'verifying', '', {
        phase: 'verifying', progress: 100, downloadedBytes, totalBytes: declaredSize,
        lastProgressAt: new Date().toISOString()
      });
      await writeAgentStatus({ state: 'updating', currentStep: 'verifying', progress: 100 });
      const sha256 = hash.digest('hex');
      if (sha256 !== String(job.sha256 || '').toLowerCase()) throw new Error('更新包 SHA-256 校验失败');
      await fs.rm(target, { force: true });
      await fs.rename(temporary, target);
    } catch (error) {
      output.destroy();
      await fs.rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
    return target;
  } finally {
    clearTimeout(timer);
  }
}

async function launchUpdateProcess(updater, args) {
  await new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', updater, ...args
    ], { windowsHide: true, stdio: 'ignore' });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('更新任务注册超时'));
    }, 30_000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`更新任务注册失败（退出代码 ${code ?? '未知'}）`));
    });
  });
}

async function claimAndApplyUpdate(config, { browserSessionIds = [] } = {}) {
  await processPendingUpdateResult(config).catch(() => undefined);
  const { job } = await agentApi(config, '/api/session-manager/agent/update-jobs');
  if (!job) return { claimed: false };
  if (browserSessionIds.length > 0) {
    await writeAgentStatus({ state: 'update_deferred', currentStep: 'deferred', progress: 0 });
    await report(config, job.id, 'deferred', '', { phase: 'deferred', progress: 0 });
    return { claimed: true, deferred: true, job };
  }
  let packagePath;
  try {
    await writeAgentStatus({ state: 'updating', currentStep: 'claiming', progress: 0 });
    packagePath = await downloadUpdate(config, job);
    await report(config, job.id, 'staged', '', { phase: 'staged', progress: 100 });
  } catch (error) {
    await report(config, job.id, 'failed', error.message).catch(() => undefined);
    await writeAgentStatus({ state: 'error', currentStep: 'update_failed', progress: 0, message: '助手更新失败，可重新检查更新。' }, { force: true });
    throw error;
  }
  const updater = path.join(__dirname, 'windows', 'launch-update.ps1');
  try {
    await launchUpdateProcess(updater, [
    '-JobId', job.id, '-PackagePath', packagePath, '-ExpectedSha256', job.sha256,
    '-TargetVersion', job.targetVersion, '-PackageType', job.packageType || 'full'
    ]);
  } catch (error) {
    await report(config, job.id, 'failed', error.message, { phase: 'failed', progress: 100, failureCode: 'launcher_failed' }).catch(() => undefined);
    await writeAgentStatus({ state: 'error', currentStep: 'update_failed', progress: 0, message: '更新启动失败，可重新检查更新。' }, { force: true });
    throw error;
  }
  await report(config, job.id, 'applying', '', { phase: 'applying', progress: 100 });
  await writeAgentStatus({ state: 'updating', currentStep: 'applying', progress: 100 });
  return { claimed: true, applying: true, job };
}

module.exports = {
  MAX_UPDATE_BYTES,
  checkLatestRelease,
  claimAndApplyUpdate,
  downloadUpdate,
  processPendingUpdateResult,
  report,
  requestOwnUpdate
};
