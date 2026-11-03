const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');

const MAX_PROTOCOL_MESSAGE_BYTES = 64 * 1024;
function packagedSidecarPath() {
  return path.join(__dirname, 'runtime', 'remote-capture', 'Kudesi.RemoteCapture.exe');
}

function latestFrameCachePath(agentDataDirectory, browserSessionId) {
  const normalizedSessionId = String(browserSessionId || '').replaceAll('-', '').toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(normalizedSessionId)) throw new Error('browserSessionId无效');
  return path.join(path.resolve(agentDataDirectory), 'cache', 'remote-capture-lab', `${normalizedSessionId}.jpg`);
}

function startCaptureSidecar(options) {
  const {
    context,
    browserSessionId,
    localProfileId,
    agentDataDirectory,
    executablePath,
    profileDirectory,
    browserProcessId,
    mode = 'jpeg-fallback',
    remoteSessionId,
    shopId,
    deviceId,
    codec = 'h264',
    sidecarPath = packagedSidecarPath(),
    spawnProcess = spawn,
    onStatus = () => undefined,
    onMessage = null
  } = options || {};
  if (!context?.once || !browserSessionId || !localProfileId ||
      !agentDataDirectory || !executablePath || !profileDirectory ||
      !Number.isInteger(Number(browserProcessId)) || Number(browserProcessId) <= 0) {
    throw new Error('sidecar启动参数无效');
  }

  const authenticationKey = crypto.randomBytes(32).toString('hex').toUpperCase();
  const framePath = latestFrameCachePath(agentDataDirectory, browserSessionId);
  const args = [
    '--browser-session-id', String(browserSessionId),
    '--local-profile-id', String(localProfileId),
    '--agent-data-dir', path.resolve(agentDataDirectory),
    '--executable-path', path.resolve(executablePath),
    '--profile-dir', path.resolve(profileDirectory),
    '--browser-pid', String(browserProcessId),
    '--mode', String(mode),
    '--auth-key', authenticationKey
  ];
  if (mode === 'webrtc') {
    if (!remoteSessionId || !shopId || !deviceId || codec !== 'h264') {
      throw new Error('WebRTC sidecar归属参数无效');
    }
    args.push(
      '--remote-session-id', String(remoteSessionId),
      '--shop-id', String(shopId),
      '--device-id', String(deviceId),
      '--codec', codec
    );
  }
  const child = spawnProcess(sidecarPath, args, {
    windowsHide: true,
    stdio: [mode === 'webrtc' ? 'pipe' : 'ignore', 'pipe', 'pipe']
  });
  let stopped = false;
  let started = false;
  let stdoutBuffer = '';
  let stderrBuffer = '';
  const pendingRequests = new Map();
  const settleRequest = (message) => {
    const requestId = String(message?.requestId || '');
    const pending = pendingRequests.get(requestId);
    if (!pending || !pending.types.has(String(message?.type || ''))) return false;
    pendingRequests.delete(requestId);
    clearTimeout(pending.timer);
    if (message.ok === false) pending.reject(new Error(String(message.error || 'sidecar前台窗口保护失败')));
    else pending.resolve(message);
    return true;
  };
  const emitMessage = (message) => {
    onStatus(message);
    if (typeof onMessage === 'function') onMessage(message);
  };
  const send = (message) => {
    if (mode !== 'webrtc' || stopped || !child.stdin || child.stdin.destroyed) {
      throw new Error('WebRTC sidecar本地协议不可用');
    }
    const serialized = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(serialized, 'utf8') > MAX_PROTOCOL_MESSAGE_BYTES) {
      throw new Error('WebRTC sidecar本地协议消息过大');
    }
    child.stdin.write(serialized);
  };

  child.stdout?.on('data', (chunk) => {
    stdoutBuffer += chunk.toString('utf8');
    while (stdoutBuffer.includes('\n')) {
      const newline = stdoutBuffer.indexOf('\n');
      const line = stdoutBuffer.slice(0, newline).trim();
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      try {
        const parsed = JSON.parse(line);
        if (!settleRequest(parsed)) emitMessage(parsed);
      } catch {
        emitMessage({ state: 'failed', error: 'sidecar状态格式无效' });
      }
    }
  });
  child.stderr?.on('data', (chunk) => {
    stderrBuffer += chunk.toString('utf8');
    while (stderrBuffer.includes('\n')) {
      const newline = stderrBuffer.indexOf('\n');
      const line = stderrBuffer.slice(0, newline).trim();
      stderrBuffer = stderrBuffer.slice(newline + 1);
      if (!line) continue;
      try {
        const parsed = JSON.parse(line);
        emitMessage({
          state: 'failed',
          error: String(parsed.error || 'sidecar采集失败').slice(0, 500),
          exceptionType: String(parsed.exceptionType || '').slice(0, 100),
          targetMethod: String(parsed.targetMethod || '').slice(0, 100)
        });
      } catch {
        emitMessage({ state: 'failed', error: 'sidecar采集失败' });
      }
    }
  });
  child.on('error', () => emitMessage({ state: 'failed', error: 'sidecar无法启动' }));
  child.on('exit', (code, signal) => {
    for (const pending of pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('WebRTC sidecar已退出'));
    }
    pendingRequests.clear();
    if (!stopped && code !== 0) emitMessage({ state: 'failed', error: `sidecar异常退出（${code ?? signal ?? 'unknown'}）` });
  });

  const request = (message, responseTypes, timeoutMs = 1000) => new Promise((resolve, reject) => {
    const requestId = String(message.requestId || crypto.randomUUID());
    if (pendingRequests.has(requestId)) {
      reject(new Error('sidecar请求编号重复'));
      return;
    }
    const timer = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error('sidecar前台窗口保护超时'));
    }, timeoutMs);
    timer.unref?.();
    pendingRequests.set(requestId, { resolve, reject, timer, types: new Set(responseTypes) });
    try { send({ ...message, requestId }); }
    catch (error) {
      clearTimeout(timer);
      pendingRequests.delete(requestId);
      reject(error);
    }
  });

  const stop = async () => {
    if (stopped) return;
    stopped = true;
    for (const pending of pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('WebRTC sidecar已停止'));
    }
    pendingRequests.clear();
    context.removeListener?.('close', stop);
    if (child.exitCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      if (mode === 'webrtc' && child.stdin && !child.stdin.destroyed) {
        const serialized = `${JSON.stringify({ type: 'stop' })}\n`;
        child.stdin.write(serialized);
        child.stdin.end();
        await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 750))]);
      }
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 1250))]);
      }
    }
    await fs.rm(framePath, { force: true }).catch(() => undefined);
  };
  context.once('close', stop);
  return {
    child,
    start(iceServers, iceTransportPolicy = 'all') {
      if (mode !== 'webrtc' || started) throw new Error('WebRTC sidecar启动协议状态无效');
      if (!['all', 'relay'].includes(iceTransportPolicy)) throw new Error('WebRTC ICE传输策略无效');
      started = true;
      send({ type: 'start', authKey: authenticationKey, iceServers, iceTransportPolicy });
    },
    send(message) {
      if (!started) throw new Error('WebRTC sidecar尚未认证');
      send(message);
    },
    requestKeyFrame() {
      if (!started) throw new Error('WebRTC sidecar尚未认证');
      send({ type: 'requestKeyFrame' });
    },
    setBitrate(bitrate) {
      if (!started) throw new Error('WebRTC sidecar尚未认证');
      send({ type: 'setBitrate', bitrate });
    },
    sendData(value) {
      if (!started) throw new Error('WebRTC sidecar尚未认证');
      send({ type: 'sendData', data: JSON.stringify(value) });
    },
    async withForegroundPreserved(operation) {
      if (!started) throw new Error('WebRTC sidecar尚未认证');
      if (typeof operation !== 'function') throw new Error('前台窗口保护操作无效');
      const requestId = crypto.randomUUID();
      await request({ type: 'captureForeground', requestId }, ['foregroundCaptured']);
      try { return await operation(); }
      finally {
        await request({ type: 'restoreForeground', requestId }, ['foregroundRestored']);
      }
    },
    stop
  };
}

module.exports = {
  latestFrameCachePath,
  packagedSidecarPath,
  startCaptureSidecar
};
