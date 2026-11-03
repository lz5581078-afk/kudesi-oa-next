const { WebSocket, WebSocketServer } = require('ws');

const MAX_SIGNAL_BYTES = 64 * 1024;
const ALLOWED_SIGNAL_TYPES = new Set([
  'offer', 'answer', 'ice', 'restart-offer', 'restart-answer',
  'recovery-request', 'recovery-ack'
]);

function attachWebRtcSignalingServer(options) {
  const {
    server,
    path = '/api/session-manager/webrtc',
    ticketStore,
    authorize,
    authenticationTimeoutMs = 5_000,
    heartbeatIntervalMs = 25_000,
    onSessionClosed = async () => {},
    logger = console
  } = options;
  if (!server?.on || !ticketStore?.consume || typeof authorize !== 'function') {
    throw new Error('WebRTC signaling dependencies are incomplete');
  }
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_SIGNAL_BYTES, perMessageDeflate: false });
  const sessions = new Map();
  const log = (level, event, state, details = '') => {
    const role = state?.role || 'unknown';
    const session = shortSessionId(state?.binding?.remoteSessionId);
    const suffix = details ? ` ${details}` : '';
    logger?.[level]?.(`[webrtc-signal] ${event} role=${role} session=${session}${suffix}`);
  };
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (socket.readyState === WebSocket.OPEN) socket.ping();
    }
  }, heartbeatIntervalMs);
  heartbeat.unref?.();

  const onUpgrade = (request, socket, head) => {
    let pathname;
    try {
      pathname = new URL(request.url, 'http://localhost').pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (pathname !== path) return;
    wss.handleUpgrade(request, socket, head, (webSocket) => {
      wss.emit('connection', webSocket, request);
    });
  };
  server.on('upgrade', onUpgrade);

  wss.on('connection', (socket) => {
    const state = { authenticated: false, authenticating: false, role: '', binding: null };
    const authenticationTimer = setTimeout(() => closeProtocol(socket, 1008, 'authentication_timeout'), authenticationTimeoutMs);

    socket.on('message', async (data, isBinary) => {
      if (isBinary || Buffer.byteLength(data) > MAX_SIGNAL_BYTES) {
        closeProtocol(socket, 1009, 'message_too_large');
        return;
      }
      let message;
      try {
        message = JSON.parse(String(data));
      } catch {
        closeProtocol(socket, 1008, 'invalid_json');
        return;
      }
      if (!state.authenticated) {
        if (state.authenticating || message?.type !== 'authenticate') {
          closeProtocol(socket, 1008, 'authentication_required');
          return;
        }
        state.authenticating = true;
        try {
          const role = String(message.role || inferRole(message.ticket, ticketStore));
          const ticket = ticketStore.consume(message.ticket, role);
          if (!(await authorize(ticket))) throw new Error('binding_rejected');
          state.authenticated = true;
          state.role = ticket.role;
          state.binding = ticket.binding;
          clearTimeout(authenticationTimer);
          log('info', 'authenticated', state);
          const pairState = pairSocket(socket, state, sessions);
          if (pairState === 'paired') log('info', 'paired', { ...state, role: 'both' });
          else if (pairState === 'waiting') log('info', 'waiting', state);
        } catch {
          log('warn', 'authentication_failed', state);
          closeProtocol(socket, 1008, 'authentication_failed');
        }
        return;
      }

      if (!validSignalForRole(message, state.role)) {
        closeProtocol(socket, 1008, 'signal_rejected');
        return;
      }
      const peer = peerSocket(sessions.get(state.binding.remoteSessionId), state.role);
      if (!peer || peer.readyState !== WebSocket.OPEN) {
        closeProtocol(socket, 1011, 'peer_unavailable');
        return;
      }
      peer.send(JSON.stringify(message));
    });

    socket.once('close', (code, reason) => {
      clearTimeout(authenticationTimer);
      log('info', 'closed', state,
        `code=${Number(code) || 1006} reason=${sanitizeReason(reason) || 'none'}`);
      if (!state.authenticated) return;
      const id = state.binding.remoteSessionId;
      const pair = sessions.get(id);
      if (!pair || pair[state.role] !== socket) return;
      sessions.delete(id);
      const peer = peerSocket(pair, state.role);
      if (peer?.readyState === WebSocket.OPEN) peer.close(1000, 'peer_closed');
      Promise.resolve(onSessionClosed(state.binding, state.role)).catch(() => undefined);
    });
    socket.on('error', () => undefined);
  });

  return Object.freeze({
    async close() {
      server.off('upgrade', onUpgrade);
      clearInterval(heartbeat);
      for (const client of wss.clients) client.close(1001, 'server_shutdown');
      await new Promise((resolve) => wss.close(resolve));
    }
  });
}

function inferRole(ticket, store) {
  // Role is sent explicitly by production clients. Tests may omit it; trying viewer first
  // would consume an agent ticket, so omission is rejected without touching the store.
  void ticket;
  void store;
  return '';
}

function pairSocket(socket, state, sessions) {
  const id = state.binding.remoteSessionId;
  const pair = sessions.get(id) || { binding: state.binding, viewer: null, agent: null };
  if (!sameBinding(pair.binding, state.binding) || pair[state.role]) {
    closeProtocol(socket, 1008, 'binding_conflict');
    return 'conflict';
  }
  pair[state.role] = socket;
  sessions.set(id, pair);
  if (!pair.viewer || !pair.agent) {
    socket.send(JSON.stringify({ type: 'waiting' }));
    return 'waiting';
  }
  pair.viewer.send(JSON.stringify({ type: 'paired' }));
  pair.agent.send(JSON.stringify({ type: 'paired' }));
  return 'paired';
}

function shortSessionId(value) {
  const text = String(value || '');
  return /^[0-9a-f-]{36}$/i.test(text) ? text.slice(-8).toLowerCase() : 'unknown';
}

function sanitizeReason(value) {
  return String(Buffer.isBuffer(value) ? value.toString('utf8') : (value || ''))
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .slice(0, 80);
}

function sameBinding(left, right) {
  return left.companyId === right.companyId && left.userId === right.userId &&
    left.shopId === right.shopId && left.deviceId === right.deviceId &&
    left.browserSessionId === right.browserSessionId && left.remoteSessionId === right.remoteSessionId;
}

function peerSocket(pair, role) {
  if (!pair) return null;
  return role === 'viewer' ? pair.agent : pair.viewer;
}

function validSignalForRole(message, role) {
  if (!message || !ALLOWED_SIGNAL_TYPES.has(message.type)) return false;
  if (message.type === 'offer' && role !== 'agent') return false;
  if (message.type === 'answer' && role !== 'viewer') return false;
  if (message.type === 'restart-offer' && role !== 'viewer') return false;
  if (message.type === 'restart-answer' && role !== 'agent') return false;
  if (message.type === 'recovery-request') {
    return role === 'viewer' && typeof message.recoveryId === 'string' &&
      message.recoveryId.length > 0 && message.recoveryId.length <= 100;
  }
  if (message.type === 'recovery-ack') {
    return role === 'agent' && typeof message.recoveryId === 'string' &&
      message.recoveryId.length > 0 && message.recoveryId.length <= 100 &&
      typeof message.ok === 'boolean' &&
      (message.error === undefined || (typeof message.error === 'string' && message.error.length <= 200));
  }
  if (['offer', 'answer', 'restart-offer', 'restart-answer'].includes(message.type)) {
    return typeof message.sdp === 'string' && message.sdp.length > 0 && message.sdp.length <= 60_000;
  }
  return message.candidate === null ||
    (typeof message.candidate === 'string' && message.candidate.length <= 4_096);
}

function closeProtocol(socket, code, reason) {
  if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
    socket.close(code, reason);
  }
}

module.exports = { attachWebRtcSignalingServer, sameBinding, validSignalForRole };
