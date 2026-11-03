const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { agentDataDir, managedWindowPath, shopProfileKey } = require('./config');

const executeFile = promisify(execFile);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BROWSER_NAMES = new Set(['chrome.exe', 'chromium.exe', 'chrome-headless-shell.exe']);

async function readBrowserProcesses() {
  if (process.platform !== 'win32') return { complete: false, processes: [] };
  const { stdout } = await executeFile('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-File',
    path.join(__dirname, 'windows', 'browser-process-snapshot.ps1')
  ], { windowsHide: true, timeout: 5000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' });
  return JSON.parse(stdout.replace(/^\uFEFF/, ''));
}

function assessBrowserAbsence(snapshot, dataDirectory) {
  if (snapshot?.complete !== true || !Array.isArray(snapshot.processes)) {
    return { absent: false, reason: 'process_snapshot_incomplete' };
  }
  const root = path.win32.resolve(dataDirectory).toLowerCase() + '\\';
  for (const row of snapshot.processes) {
    const executable = String(row?.executablePath || '').replace(/\//g, '\\').toLowerCase();
    const commandLine = String(row?.commandLine || '');
    if (!BROWSER_NAMES.has(String(row?.name || '').toLowerCase()) ||
        !Number.isInteger(row?.pid) || row.pid <= 0 || !path.win32.isAbsolute(executable)) {
      return { absent: false, reason: 'process_identity_unavailable' };
    }
    // A background managed Chrome is still a browser, even without a visible window.
    if (executable.startsWith(root) || executable.includes('\\kudesisessionmanageragent\\')) {
      return { absent: false, reason: 'managed_browser_process_present' };
    }
    // Do not infer absence from inaccessible metadata or an unrecognized custom Profile.
    if (!commandLine.trim() || /--user-data-dir\b/i.test(commandLine)) {
      return { absent: false, reason: 'browser_profile_unverified' };
    }
  }
  return { absent: true, reason: 'browser_process_absent' };
}

async function readMarker(markerPath) {
  try {
    const stat = await fs.lstat(markerPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('invalid managed-window file');
    const raw = await fs.readFile(markerPath, 'utf8');
    return { raw, value: JSON.parse(raw) };
  } catch (error) {
    if (error.code === 'ENOENT') return { raw: null, value: null };
    throw error;
  }
}

async function recoverMissingBrowserClose({
  config, job, isIdle = () => false,
  snapshot = readBrowserProcesses,
  dataDirectory = agentDataDir(), markerPath = managedWindowPath(),
  pause = () => new Promise((resolve) => setTimeout(resolve, 300))
}) {
  const profile = config?.shops?.[shopProfileKey(config, job?.shopId)];
  if (!UUID.test(String(job?.remoteSessionId || '')) ||
      !UUID.test(String(job?.browserSessionId || '')) ||
      !UUID.test(String(job?.localProfileId || '')) ||
      !UUID.test(String(job?.deviceId || '')) || job.deviceId !== config?.deviceId ||
      !Number.isInteger(job?.shopId) || job.shopId <= 0 ||
      !profile || String(profile.storeId) !== String(job.shopId) ||
      profile.localProfileId !== job.localProfileId) {
    return { closed: false, reason: 'close_binding_unverified' };
  }
  if (!isIdle()) return { closed: false, reason: 'browser_work_in_progress' };
  try {
    const marker = await readMarker(markerPath);
    // Two fresh OS snapshots plus the foreground-job guard prevent a launch race.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const evidence = assessBrowserAbsence(await snapshot(), dataDirectory);
      if (!evidence.absent) return { closed: false, reason: evidence.reason };
      if (!isIdle()) return { closed: false, reason: 'browser_work_in_progress' };
      if (attempt === 0) await pause();
    }
    const current = await readMarker(markerPath);
    if (!isIdle() || current.raw !== marker.raw) {
      return { closed: false, reason: 'browser_state_changed' };
    }
    if (current.value && String(current.value.storeId) === String(job.shopId)) {
      // Only the obsolete marker is removed. Never touch Profile data or kill a PID.
      await fs.unlink(markerPath);
    }
    return { closed: true, reason: 'browser_process_absent' };
  } catch {
    return { closed: false, reason: 'process_verification_failed' };
  }
}

module.exports = { assessBrowserAbsence, readBrowserProcesses, recoverMissingBrowserClose };
