import { createRemoteInputCommandTracker } from './remote-input-command-tracker.mjs';
import { createRemoteQualityController } from './remote-quality-controller.mjs';

const INPUT_TYPES = new Set([
  'click', 'doubleClick', 'drag', 'scroll', 'key', 'text',
  'previousTab', 'nextTab', 'closeTab'
]);
const POINTER_INPUT_TYPES = new Set(['click', 'doubleClick', 'drag', 'scroll']);
const MAX_INPUT_BYTES = 16 * 1024;
const MAX_PENDING_INPUT_COMMANDS = 1;
const MAX_INPUT_BUFFERED_BYTES = 64 * 1024;
const CONTROL_REFRESH_TIMEOUT_MS = 5_000;
const RECOVERY_ACK_TIMEOUT_MS = 3_000;
const RECOVERY_FRAME_TIMEOUT_MS = 2_000;
const RECOVERY_AFTER_ICE_TIMEOUT_MS = 5_000;
const RECOVERY_POLL_MS = 100;
const MAX_ICE_RESTARTS = 2;
const ICE_RESTART_DELAY_MS = 1_500;

function signalingUrl(pathname) {
  const url = new URL(pathname, window.location.origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.search = '';
  url.hash = '';
  return url.toString();
}

export function connectViewerWebRtc(options) {
  const {
    ticket,
    signalingPath,
    iceServers,
    iceTransportPolicy = 'all',
    onStatus = () => undefined,
    onStream = () => undefined,
    onStats = () => undefined,
    onFrameMeta = () => undefined,
    onInputResult = () => undefined,
    onQualityChange = () => undefined,
    onSocketClose = () => undefined,
    qualityControlEnabled = false,
    initialQualityMode = 'auto',
    WebSocketImpl = window.WebSocket,
    RTCPeerConnectionImpl = window.RTCPeerConnection
  } = options || {};
  if (!ticket || !signalingPath || !Array.isArray(iceServers)) {
    throw new Error('WebRTC连接参数不完整');
  }

  const peer = new RTCPeerConnectionImpl({
    iceServers,
    iceTransportPolicy: iceTransportPolicy === 'relay' ? 'relay' : 'all',
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require'
  });
  peer.addTransceiver('video', { direction: 'recvonly' });
  let input = null;
  const socket = new WebSocketImpl(signalingUrl(signalingPath));
  let closed = false;
  let closing = false;
  let connected = false;
  let iceRestartCount = 0;
  let iceRestartTimer = 0;
  let statsTimer = 0;
  let previousBytes = 0;
  let previousTimestamp = 0;
  let previousFramesDecoded = 0;
  let previousFramesDropped = 0;
  let previousPacketsLost = 0;
  let previousPacketsReceived = 0;
  let lastSentQualityLevel = '';
  let currentFrameMeta = null;
  let frameMetaSequence = 0;
  let commandSequence = 0;
  let refreshSequence = 0;
  let recoverySequence = 0;
  let pendingControlRefresh = null;
  let pendingRecovery = null;
  const inputCommands = createRemoteInputCommandTracker();
  const qualityController = createRemoteQualityController({ initialMode: initialQualityMode });

  peer.ontrack = (event) => {
    const stream = event.streams?.[0] || new window.MediaStream([event.track]);
    onStream(stream);
  };
  peer.ondatachannel = (event) => {
    if (event.channel.label !== 'kudesi-input' || input) {
      event.channel.close();
      return;
    }
    input = event.channel;
    input.onopen = () => {
      connected = true;
      onStatus('connected');
      scheduleStats();
    };
    input.onclose = () => {
      connected = false;
      inputCommands.rejectAll(new Error('远程输入通道已关闭'));
      rejectControlRefresh(new Error('远程输入通道已关闭，需要重新连接'));
      if (!closed) onStatus('disconnected');
    };
    input.onmessage = async (messageEvent) => {
      let message;
      try {
        const value = messageEvent.data;
        const serialized = typeof value === 'string'
          ? value
          : value instanceof window.Blob
            ? await value.text()
            : new window.TextDecoder().decode(value);
        message = JSON.parse(serialized);
      }
      catch { return; }
      if (message?.type === 'frameMeta') {
        frameMetaSequence += 1;
        currentFrameMeta = Object.freeze({
          frameId: Number(message.frameId),
          windowVersion: String(message.windowVersion || ''),
          captureWidth: Number(message.captureWidth),
          captureHeight: Number(message.captureHeight)
        });
        onFrameMeta(currentFrameMeta);
      } else if (message?.type === 'inputResult') {
        inputCommands.resolve(message);
        onInputResult(message);
      } else if (message?.type === 'controlRefreshed') {
        settleControlRefresh(message);
      } else if (message?.type === 'qualityApplied') {
        if (message.ok === false) return;
        onQualityChange({
          mode: qualityController.snapshot().mode,
          level: String(message.level || qualityController.snapshot().level),
          bitrate: Number(message.bitrate || 0)
        });
      }
    };
  };
  peer.onicecandidate = (event) => {
    if (socket.readyState !== WebSocketImpl.OPEN) return;
    const candidate = event.candidate;
    socket.send(JSON.stringify({
      type: 'ice',
      candidate: candidate?.candidate ?? null,
      sdpMid: candidate?.sdpMid ?? null,
      sdpMLineIndex: candidate?.sdpMLineIndex ?? null
    }));
  };
  peer.onconnectionstatechange = () => {
    if (peer.connectionState === 'connected') {
      connected = true;
      iceRestartCount = 0;
      window.clearTimeout(iceRestartTimer);
      onStatus('connected');
    } else if (peer.connectionState === 'failed' || peer.connectionState === 'disconnected') {
      connected = false;
      onStatus(peer.connectionState === 'failed' ? 'reconnecting' : 'network_poor');
      scheduleIceRestart();
    } else if (peer.connectionState === 'closed') {
      connected = false;
    }
  };
  socket.onopen = () => {
    onStatus('waiting_agent');
    socket.send(JSON.stringify({ type: 'authenticate', role: 'viewer', ticket }));
  };
  socket.onmessage = async (event) => {
    let message;
    try {
      message = JSON.parse(String(event.data));
      if (message.type === 'waiting') {
        onStatus('waiting_agent');
        return;
      }
      if (message.type === 'paired') {
        onStatus('negotiating');
        return;
      }
      if (message.type === 'offer') {
        await peer.setRemoteDescription({ type: 'offer', sdp: message.sdp });
        await peer.setLocalDescription(await peer.createAnswer());
        socket.send(JSON.stringify({ type: 'answer', sdp: peer.localDescription.sdp }));
        return;
      }
      if (message.type === 'restart-answer') {
        await peer.setRemoteDescription({ type: 'answer', sdp: message.sdp });
        return;
      }
      if (message.type === 'recovery-ack') {
        settleRecoveryAck(message);
        return;
      }
      if (message.type === 'ice') {
        await peer.addIceCandidate(message.candidate === null ? null : {
          candidate: message.candidate,
          sdpMid: message.sdpMid,
          sdpMLineIndex: message.sdpMLineIndex
        });
      }
    } catch {
      onStatus('failed');
    }
  };
  socket.onerror = () => onStatus('failed');
  socket.onclose = (event) => {
    onSocketClose({ code: event.code, reason: event.reason, wasClean: event.wasClean });
    if (!closed) {
      onStatus('disconnected');
      closeTransport(false);
    }
  };

  function sendData(value) {
    if (input?.readyState !== 'open') throw new Error('远程输入通道尚未连接');
    if (Number(input.bufferedAmount || 0) > MAX_INPUT_BUFFERED_BYTES) {
      throw new Error('远程输入通道繁忙，请稍后重试');
    }
    const payload = JSON.stringify(value);
    if (new window.TextEncoder().encode(payload).byteLength > MAX_INPUT_BYTES) {
      throw new Error('远程输入命令过大');
    }
    input.send(payload);
  }

  function sendInput(command) {
    if (!connected || closing) throw new Error('远程连接恢复前不能发送输入');
    if (!command || !INPUT_TYPES.has(command.type)) throw new Error('不支持的远程输入命令');
    if (inputCommands.pendingCount() >= MAX_PENDING_INPUT_COMMANDS) {
      throw new Error('上一操作仍在处理中，请稍后重试');
    }
    const commandId = `${Date.now()}-${++commandSequence}`;
    const authorizedCommand = POINTER_INPUT_TYPES.has(command.type)
      ? { ...command, ...currentFrameMeta, commandId }
      : { ...command, commandId };
    if (POINTER_INPUT_TYPES.has(command.type) &&
        (!currentFrameMeta?.frameId || !currentFrameMeta.windowVersion)) {
      throw new Error('等待最新远程画面后再操作');
    }
    const result = inputCommands.waitForResult(commandId);
    try {
      sendData({ type: 'input', command: authorizedCommand });
    } catch (error) {
      inputCommands.reject(commandId, error);
    }
    return result;
  }

  function requestKeyFrame() {
    sendData({ type: 'requestKeyFrame' });
  }

  function sendQualityLevel(snapshot, force = false) {
    if (!qualityControlEnabled || input?.readyState !== 'open') return false;
    if (!force && snapshot.level === lastSentQualityLevel) return false;
    try {
      sendData({ type: 'quality', mode: snapshot.mode, level: snapshot.level });
      lastSentQualityLevel = snapshot.level;
      return true;
    } catch {
      return false;
    }
  }

  function setQualityMode(mode) {
    const snapshot = qualityController.setMode(mode);
    sendQualityLevel(snapshot, true);
    onQualityChange(snapshot);
    return snapshot;
  }

  function settleControlRefresh(message) {
    if (!pendingControlRefresh || message?.refreshId !== pendingControlRefresh.refreshId) return false;
    const current = pendingControlRefresh;
    pendingControlRefresh = null;
    window.clearTimeout(current.timer);
    if (message.ok) current.resolve(message);
    else current.reject(new Error(message.error || '控制通道刷新失败'));
    return true;
  }

  function rejectControlRefresh(error) {
    if (!pendingControlRefresh) return;
    const current = pendingControlRefresh;
    pendingControlRefresh = null;
    window.clearTimeout(current.timer);
    current.reject(error);
  }

  async function refreshControl() {
    if (closed || closing) throw new Error('远程连接已关闭，无法刷新控制');
    if (input?.readyState !== 'open') throw new Error('远程输入通道已断开，需要重新连接');
    if (pendingControlRefresh) return pendingControlRefresh.promise;

    inputCommands.rejectAll(new Error('控制通道正在刷新，请重试操作'));
    currentFrameMeta = null;
    onFrameMeta(null);
    const refreshId = `${Date.now()}-refresh-${++refreshSequence}`;
    let resolveRefresh;
    let rejectRefresh;
    const promise = new Promise((resolve, reject) => {
      resolveRefresh = resolve;
      rejectRefresh = reject;
    });
    const timer = window.setTimeout(() => {
      if (pendingControlRefresh?.refreshId !== refreshId) return;
      pendingControlRefresh = null;
      rejectRefresh(new Error('控制通道刷新确认超时，请重试'));
    }, CONTROL_REFRESH_TIMEOUT_MS);
    pendingControlRefresh = { refreshId, promise, resolve: resolveRefresh, reject: rejectRefresh, timer };
    try {
      sendData({ type: 'refreshControl', refreshId });
    } catch (error) {
      rejectControlRefresh(error);
    }
    return promise;
  }

  function settleRecoveryAck(message) {
    if (!pendingRecovery || message?.recoveryId !== pendingRecovery.recoveryId) return false;
    const current = pendingRecovery;
    pendingRecovery = null;
    window.clearTimeout(current.timer);
    if (message.ok) current.resolve(message);
    else current.reject(new Error(message.error || '画面与控制恢复失败'));
    return true;
  }

  function rejectRecovery(error) {
    if (!pendingRecovery) return;
    const current = pendingRecovery;
    pendingRecovery = null;
    window.clearTimeout(current.timer);
    current.reject(error);
  }

  function requestRecoveryViaSignal() {
    if (socket.readyState !== WebSocketImpl.OPEN) {
      return Promise.reject(new Error('WebRTC信令连接已断开'));
    }
    if (pendingRecovery) return pendingRecovery.promise;
    const recoveryId = `${Date.now()}-recovery-${++recoverySequence}`;
    let resolveRecovery;
    let rejectRecoveryPromise;
    const promise = new Promise((resolve, reject) => {
      resolveRecovery = resolve;
      rejectRecoveryPromise = reject;
    });
    const timer = window.setTimeout(() => {
      if (pendingRecovery?.recoveryId !== recoveryId) return;
      pendingRecovery = null;
      rejectRecoveryPromise(new Error('助手恢复确认超时'));
    }, RECOVERY_ACK_TIMEOUT_MS);
    pendingRecovery = {
      recoveryId,
      promise,
      resolve: resolveRecovery,
      reject: rejectRecoveryPromise,
      timer
    };
    socket.send(JSON.stringify({ type: 'recovery-request', recoveryId }));
    return promise;
  }

  async function readInboundFramesDecoded() {
    const report = await peer.getStats();
    for (const value of report.values()) {
      if (value.type === 'inbound-rtp' && value.kind === 'video') {
        return Number(value.framesDecoded || 0);
      }
    }
    return 0;
  }

  async function waitForRecoveredMedia(baselineFramesDecoded, baselineFrameMetaSequence, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (!closed && !closing && Date.now() < deadline) {
      const framesDecoded = await readInboundFramesDecoded();
      if (framesDecoded > baselineFramesDecoded && frameMetaSequence > baselineFrameMetaSequence) {
        return { framesDecoded, frameMetaSequence };
      }
      await new Promise((resolve) => window.setTimeout(resolve, RECOVERY_POLL_MS));
    }
    throw new Error('未收到新的远程画面，请重试');
  }

  async function performIceRestart() {
    if (closed || closing) throw new Error('远程连接已关闭，无法恢复');
    if (socket.readyState !== WebSocketImpl.OPEN) throw new Error('WebRTC信令连接已断开');
    iceRestartCount += 1;
    peer.restartIce();
    const offer = await peer.createOffer({ iceRestart: true });
    await peer.setLocalDescription(offer);
    socket.send(JSON.stringify({ type: 'restart-offer', sdp: peer.localDescription.sdp }));
  }

  async function recoverMediaAndControl() {
    if (closed || closing) throw new Error('远程连接已关闭，无法恢复');
    if (pendingRecovery) return pendingRecovery.promise;
    inputCommands.rejectAll(new Error('画面与控制正在恢复，请重试操作'));
    rejectControlRefresh(new Error('已切换为画面与控制恢复'));
    const baselineFrameMetaSequence = frameMetaSequence;
    const baselineFramesDecoded = await readInboundFramesDecoded();
    currentFrameMeta = null;
    onFrameMeta(null);
    connected = false;
    onStatus('reconnecting');

    await requestRecoveryViaSignal();
    try {
      const result = await waitForRecoveredMedia(
        baselineFramesDecoded,
        baselineFrameMetaSequence,
        RECOVERY_FRAME_TIMEOUT_MS
      );
      connected = true;
      onStatus('connected');
      return result;
    } catch (initialError) {
      if (iceRestartCount >= MAX_ICE_RESTARTS) throw initialError;
      await performIceRestart();
      await requestRecoveryViaSignal();
      const result = await waitForRecoveredMedia(
        baselineFramesDecoded,
        baselineFrameMetaSequence,
        RECOVERY_AFTER_ICE_TIMEOUT_MS
      );
      connected = true;
      onStatus('connected');
      return result;
    }
  }

  function scheduleIceRestart() {
    if (closed || closing) return;
    if (iceRestartCount >= MAX_ICE_RESTARTS || iceRestartTimer) {
      if (iceRestartCount >= MAX_ICE_RESTARTS) onStatus('failed');
      return;
    }
    iceRestartTimer = window.setTimeout(async () => {
      iceRestartTimer = 0;
      if (closed || closing) return;
      if (socket.readyState !== WebSocketImpl.OPEN) {
        onStatus('failed');
        return;
      }
      try {
        await performIceRestart();
      } catch {
        if (iceRestartCount < MAX_ICE_RESTARTS) scheduleIceRestart();
        else onStatus('failed');
      }
    }, ICE_RESTART_DELAY_MS);
  }

  async function readStats() {
    const report = await peer.getStats();
    let inbound;
    let selectedPair;
    let remoteCandidate;
    for (const value of report.values()) {
      if (value.type === 'inbound-rtp' && value.kind === 'video') inbound = value;
      if (value.type === 'transport' && value.selectedCandidatePairId) {
        selectedPair = report.get(value.selectedCandidatePairId);
      }
    }
    if (!selectedPair) {
      for (const value of report.values()) {
        if (value.type === 'candidate-pair' && value.state === 'succeeded' && value.nominated) {
          selectedPair = value;
          break;
        }
      }
    }
    if (selectedPair?.remoteCandidateId) remoteCandidate = report.get(selectedPair.remoteCandidateId);
    const timestamp = Number(inbound?.timestamp || 0);
    const bytes = Number(inbound?.bytesReceived || 0);
    const hasPreviousSample = previousTimestamp > 0;
    const elapsed = hasPreviousSample && timestamp > previousTimestamp ? (timestamp - previousTimestamp) / 1000 : 0;
    const bitrate = elapsed > 0 ? Math.max(0, Math.round((bytes - previousBytes) * 8 / elapsed)) : 0;
    const framesDecoded = Number(inbound?.framesDecoded || 0);
    const framesDropped = Number(inbound?.framesDropped || 0);
    const packetsLost = Number(inbound?.packetsLost || 0);
    const packetsReceived = Number(inbound?.packetsReceived || 0);
    const decodeFps = Number(inbound?.framesPerSecond || 0) ||
      (elapsed > 0 ? Math.max(0, (framesDecoded - previousFramesDecoded) / elapsed) : 0);
    const framesDecodedDelta = hasPreviousSample ? Math.max(0, framesDecoded - previousFramesDecoded) : 0;
    const framesDroppedDelta = hasPreviousSample ? Math.max(0, framesDropped - previousFramesDropped) : 0;
    const packetsLostDelta = hasPreviousSample ? Math.max(0, packetsLost - previousPacketsLost) : 0;
    const packetsReceivedDelta = hasPreviousSample ? Math.max(0, packetsReceived - previousPacketsReceived) : 0;
    const packetTotalDelta = packetsLostDelta + packetsReceivedDelta;
    previousBytes = bytes;
    previousTimestamp = timestamp;
    previousFramesDecoded = framesDecoded;
    previousFramesDropped = framesDropped;
    previousPacketsLost = packetsLost;
    previousPacketsReceived = packetsReceived;
    const usingTurn = remoteCandidate?.candidateType === 'relay';
    const stats = {
      width: Number(inbound?.frameWidth || 0),
      height: Number(inbound?.frameHeight || 0),
      framesPerSecond: decodeFps,
      decodeFps,
      bitrate,
      sampleSeconds: elapsed,
      framesDecodedDelta,
      framesDroppedDelta,
      roundTripTimeMs: Math.round(Number(selectedPair?.currentRoundTripTime || 0) * 1000),
      packetsLost,
      packetsLostDelta,
      packetsReceivedDelta,
      lossRate: packetTotalDelta > 0 ? packetsLostDelta / packetTotalDelta : 0,
      availableIncomingBitrate: Number(selectedPair?.availableIncomingBitrate || 0),
      connectionType: usingTurn ? 'turn' : 'peer',
      usingTurn
    };
    onStats(stats);
    const quality = qualityController.update(stats);
    if (quality.changed || !lastSentQualityLevel) sendQualityLevel(quality);
    if (usingTurn) onStatus('turn');
  }

  function scheduleStats() {
    window.clearTimeout(statsTimer);
    if (closed) return;
    statsTimer = window.setTimeout(async () => {
      try {
        await readStats();
      } finally {
        scheduleStats();
      }
    }, 1000);
  }

  function closeTransport(closeSocket = true) {
    if (closed) return;
    closing = true;
    closed = true;
    connected = false;
    inputCommands.rejectAll(new Error('远程输入连接已关闭'));
    rejectControlRefresh(new Error('远程输入连接已关闭'));
    rejectRecovery(new Error('远程输入连接已关闭'));
    window.clearTimeout(statsTimer);
    window.clearTimeout(iceRestartTimer);
    input?.close();
    peer.close();
    if (closeSocket && socket.readyState < WebSocketImpl.CLOSING) socket.close(1000, 'viewer_closed');
  }

  function close() { closeTransport(true); }

  return Object.freeze({ close, peer, recoverMediaAndControl, refreshControl, requestKeyFrame, sendInput, setQualityMode });
}
