const fs = require('fs/promises');
const path = require('path');

const MAX_LOG_BYTES = 1024 * 1024;
const NUMERIC_FIELDS = [
  'captureFrames', 'captureFpsInstant', 'encodeFpsInstant', 'encodedFrames',
  'droppedFrames', 'keyframes', 'encodeMicroseconds', 'bitrate', 'width', 'height',
  'videoWidth', 'videoHeight', 'encoderQueueDepth', 'activeD3D11Textures',
  'sidecarWorkingSetBytes', 'privateBytes', 'nativePrivateEstimateBytes'
];

function summarizeSidecarMessage(message) {
  if (!message || typeof message !== 'object') return { event: 'sidecar_invalid_message' };
  if (message.type === 'stats') {
    const summary = { event: 'sidecar_stats' };
    for (const field of NUMERIC_FIELDS) {
      const value = Number(message[field]);
      if (Number.isFinite(value)) summary[field] = value;
    }
    for (const field of ['state', 'peerConnectionState', 'dataChannelState']) {
      if (typeof message[field] === 'string') summary[field] = message[field].slice(0, 60);
    }
    return summary;
  }
  if (message.type === 'ice') {
    const candidate = String(message.candidate || '');
    return {
      event: 'sidecar_ice',
      candidateType: /\btyp\s+(\w+)/i.exec(candidate)?.[1]?.toLowerCase() || 'unknown',
      protocol: /^candidate:\S+\s+\d+\s+(\w+)/i.exec(candidate)?.[1]?.toLowerCase() || 'unknown'
    };
  }
  if (['offer', 'answer', 'description'].includes(message.type)) {
    return { event: `sidecar_${message.type}` };
  }
  if (message.type === 'input') return { event: 'sidecar_input_received' };
  if (message.type === 'status') {
    return { event: 'sidecar_status', state: String(message.state || '').slice(0, 60) };
  }
  if (message.type === 'state') {
    return { event: 'sidecar_state', state: String(message.state || '').slice(0, 60) };
  }
  if (message.state === 'failed' || message.type === 'error') {
    return {
      event: 'sidecar_failed',
      code: String(message.code || '').slice(0, 80),
      error: String(message.error || message.message || 'sidecar failed').slice(0, 300)
    };
  }
  return { event: 'sidecar_message', type: String(message.type || message.state || 'unknown').slice(0, 60) };
}

function createWebRtcDiagnosticLogger(dataDirectory) {
  const logDirectory = path.join(dataDirectory, 'logs');
  const logPath = path.join(logDirectory, 'webrtc-diagnostics.log');
  let pending = Promise.resolve();
  return (entry) => {
    const record = `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`;
    pending = pending.then(async () => {
      await fs.mkdir(logDirectory, { recursive: true });
      const size = await fs.stat(logPath).then((value) => value.size).catch(() => 0);
      if (size >= MAX_LOG_BYTES) {
        await fs.rename(logPath, `${logPath}.1`).catch(() => undefined);
      }
      await fs.appendFile(logPath, record, { encoding: 'utf8', mode: 0o600 });
    }).catch(() => undefined);
  };
}

module.exports = {
  createWebRtcDiagnosticLogger,
  summarizeSidecarMessage
};
