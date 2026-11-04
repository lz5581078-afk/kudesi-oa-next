import { useEffect, useRef, useState } from 'react';
import { Hand, Maximize2, MousePointer2, RefreshCw, X } from 'lucide-react';
import { fetchBlob as defaultFetchBlob, fetchJson as defaultFetchJson } from '../legacyTransport';
import { mapVideoPointerToCapture } from './remote-video-coordinate.mjs';
import { createVideoFrameObserver } from './video-frame-observer.mjs';
import { connectViewerWebRtc } from './webrtc-remote-client.js';
import { REMOTE_QUALITY_PROFILES } from './remote-quality-controller.mjs';
import { browserCloseConfirmed, fetchCloseJson, pendingBrowserClose, pollBrowserClose } from './remote-close-recovery.mjs';

const WEBRTC_REMOTE_ENABLED = import.meta.env.VITE_SESSION_MANAGER_WEBRTC_REMOTE !== 'false';

const REFRESH_MS = 350;
const REMOTE_LEASE_HEARTBEAT_MS = 30_000;
const TERMINAL = new Set(['ended', 'closed', 'expired', 'error']);
const STATUS_LABELS = {
  requesting: '正在请求远程电脑',
  waiting: '等待助手打开店铺浏览器',
  requested: '等待助手连接',
  connected: '已连接',
  closing: '正在安全关闭',
  ended: '店铺已安全关闭',
  closed: '已结束',
  expired: '会话已过期',
  error: '远程操作异常',
  offline: '助手离线',
  browser_missing: '浏览器窗口不存在'
};
const CLOSE_STAGE_LABELS = {
  stopping_remote: '正在停止远程控制',
  notifying_agent: '正在通知 Windows 助手',
  saving_profile: '正在安全保存本机 Profile',
  closing_browser: '正在关闭店铺浏览器',
  safe_closed: '店铺已安全关闭',
  close_failed: '关闭失败，店铺浏览器可能仍在运行'
};
const CLOSE_STAGE_PROGRESS = {
  stopping_remote: 20,
  notifying_agent: 40,
  saving_profile: 65,
  closing_browser: 85,
  safe_closed: 100
};
const ZOOM_LEVELS = [1, 1.5, 2, 2.5, 5, 6, 7, 8];

function versionAtLeast(actual, minimum) {
  const parse = (value) => String(value || '').split('.').map((part) => Number(part) || 0);
  const current = parse(actual);
  const required = parse(minimum);
  for (let index = 0; index < Math.max(current.length, required.length, 3); index += 1) {
    if ((current[index] || 0) !== (required[index] || 0)) {
      return (current[index] || 0) > (required[index] || 0);
    }
  }
  return true;
}

function wait(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(resolve, milliseconds);
    signal.addEventListener('abort', () => {
      window.clearTimeout(timer);
      const error = new Error('Aborted');
      error.name = 'AbortError';
      reject(error);
    }, { once: true });
  });
}

async function findManagedBrowser(shop, fetchJson = defaultFetchJson) {
  const params = new URLSearchParams({ shopId: String(shop.id), deviceId: shop.savedDeviceId });
  return (await fetchJson(`/api/session-manager/browser-sessions/active?${params}`)).browserSession;
}

async function ensureRemoteSessionForClose(sessionRef, shop, fetchJson = defaultFetchJson) {
  if (sessionRef.current?.id) return sessionRef.current;
  const browser = await findManagedBrowser(shop, fetchJson);
  if (!browser) return null;
  const pendingClose = pendingBrowserClose(browser);
  if (pendingClose) {
    sessionRef.current = pendingClose;
    return pendingClose;
  }
  const session = await fetchJson('/api/session-manager/remote-sessions', {
    method: 'POST',
    body: JSON.stringify({ browserSessionId: browser.id, deviceId: shop.savedDeviceId, shopId: shop.id })
  });
  sessionRef.current = session;
  return session;
}

function pointFromEvent(event) {
  const rect = event.currentTarget.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
    y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
    t: Date.now()
  };
}

function statusForError(message, fallback = 'error') {
  const value = String(message || '');
  if (value.includes('助手离线') || value.includes('电脑或浏览器窗口已离线')) return 'offline';
  if (value.includes('浏览器窗口不存在')) return 'browser_missing';
  if (value.includes('离开所属平台') || value.includes('页面已离开')) return 'page_not_allowed';
  if (value.includes('会话已过期')) return 'expired';
  return fallback;
}

const WEBRTC_STATUS_LABELS = {
  requesting: '正在请求',
  waiting: '等待助手打开店铺浏览器',
  waiting_agent: '等待助手连接',
  negotiating: '正在协商',
  connected: '已连接',
  turn: '已连接（TURN中继）',
  network_poor: '网络较差',
  offline: '助手离线',
  browser_missing: '浏览器窗口不存在',
  page_not_allowed: '页面已离开所属平台',
  expired: '会话已过期',
  ended: '已结束',
  disconnected: '连接已断开',
  failed: '连接失败',
  reconnecting: '正在恢复实时连接',
  jpeg_fallback: 'JPEG只读降级',
  error: '连接失败'
};
const NAMED_KEYS = new Set([
  'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'Backspace', 'Delete',
  'End', 'Enter', 'Escape', 'Home', 'PageDown', 'PageUp', ' ', 'Tab'
]);

function WebRtcRemoteAssistDialog({ shop, onClose, onRequestChange, requestJson = defaultFetchJson, requestBlob = defaultFetchBlob }) {
  const fetchJson = requestJson;
  const fetchBlob = requestBlob;
  const connectionRecoverySupported = versionAtLeast(shop.savedDeviceAgentVersion, '0.3.26');
  const qualityControlSupported = versionAtLeast(shop.savedDeviceAgentVersion, '0.3.31');
  const [status, setStatus] = useState('requesting');
  const [message, setMessage] = useState('正在检查远程电脑上的店铺窗口...');
  const [stats, setStats] = useState(null);
  const [qualityMode, setQualityMode] = useState('auto');
  const [qualityLevel, setQualityLevel] = useState('balanced');
  const [frameUpdatedAt, setFrameUpdatedAt] = useState(null);
  const [operation, setOperation] = useState('');
  const [zoom, setZoom] = useState(1);
  const [fit, setFit] = useState(true);
  const [panMode, setPanMode] = useState(false);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [streamReady, setStreamReady] = useState(false);
  const [jpegFallback, setJpegFallback] = useState(false);
  const [jpegFrame, setJpegFrame] = useState('');
  const [ending, setEnding] = useState(false);
  const [recoveringConnection, setRecoveringConnection] = useState(false);
  const [closeStage, setCloseStage] = useState('');
  const [closeError, setCloseError] = useState('');
  const controllerRef = useRef(null);
  const qualityModeRef = useRef('auto');
  const sessionRef = useRef(null);
  const openRequestRef = useRef(null);
  const videoRef = useRef(null);
  const stageRef = useRef(null);
  const keyboardRef = useRef(null);
  const pointerRef = useRef(null);
  const composingRef = useRef(false);
  const endedRef = useRef(false);
  const endingRef = useRef(false);
  const closeTimerRef = useRef(0);
  const reconnectRef = useRef(null);
  const frameMetaRef = useRef(null);
  const operationSequenceRef = useRef(0);
  const wheelRef = useRef(null);
  const closeAbortRef = useRef(null);

  useEffect(() => {
    const abort = new AbortController();
    closeAbortRef.current = abort;
    let frameObserver = null;
    let currentJpegUrl = '';
    let fallbackActive = false;
    let fallbackStarting = false;
    let connectionGeneration = 0;
    const findBrowser = () => findManagedBrowser(shop, fetchJson);
    const updateStatus = (next, expectedGeneration = null) => {
      if (expectedGeneration !== null && expectedGeneration !== connectionGeneration) return;
      setStatus(next);
      setMessage(WEBRTC_STATUS_LABELS[next] || next);
      if (next === 'failed' && !endingRef.current) void enableJpegFallback(expectedGeneration);
    };
    const observeFrames = () => {
      if (frameObserver || !videoRef.current?.requestVideoFrameCallback || abort.signal.aborted) return;
      frameObserver = createVideoFrameObserver({
        video: videoRef.current,
        minUpdateIntervalMs: 1000,
        onFrame: () => setFrameUpdatedAt(new Date())
      });
      frameObserver.start();
    };
    async function pollJpegFrames(session) {
      let sequence = 0;
      while (fallbackActive && !abort.signal.aborted && !endingRef.current) {
        const next = await fetchJson(`/api/session-manager/remote-sessions/${session.id}`);
        sessionRef.current = next;
        if (next.transportMode !== 'jpeg_fallback') return;
        if (next.frameAvailable && next.frameSequence > sequence) {
          const result = await fetchBlob(`/api/session-manager/remote-sessions/${session.id}/frame`);
          const objectUrl = URL.createObjectURL(result.blob);
          if (currentJpegUrl) URL.revokeObjectURL(currentJpegUrl);
          currentJpegUrl = objectUrl;
          sequence = next.frameSequence;
          setJpegFrame(objectUrl);
          setFrameUpdatedAt(new Date());
        }
        await wait(700, abort.signal);
      }
    }
    async function enableJpegFallback(expectedGeneration = null) {
      if (expectedGeneration !== null && expectedGeneration !== connectionGeneration) return;
      const session = sessionRef.current;
      if (!session?.id || fallbackActive || fallbackStarting || endingRef.current || abort.signal.aborted) return;
      fallbackStarting = true;
      try {
        if (expectedGeneration !== null && expectedGeneration !== connectionGeneration) return;
        controllerRef.current?.close();
        controllerRef.current = null;
        if (videoRef.current) videoRef.current.srcObject = null;
        await fetchJson(`/api/session-manager/remote-sessions/${session.id}/jpeg-fallback`, {
          method: 'POST', body: '{}'
        });
        fallbackActive = true;
        setJpegFallback(true);
        setStreamReady(false);
        setStatus('jpeg_fallback');
        setMessage('实时连接不可用，当前仅可查看低帧率画面，鼠标和键盘已禁用');
        await pollJpegFrames(session);
      } catch (error) {
        if (error.name !== 'AbortError' && !endingRef.current) {
          setStatus('failed');
          setMessage(error.message || 'JPEG只读降级启动失败');
        }
      } finally {
        fallbackStarting = false;
      }
    }
    async function connectViewer(session, recovering = false) {
      if (recovering) {
        await fetchJson(`/api/session-manager/remote-sessions/${session.id}/webrtc-recover`, {
          method: 'POST', body: '{}'
        });
      }
      fallbackActive = false;
      setJpegFallback(false);
      if (currentJpegUrl) {
        URL.revokeObjectURL(currentJpegUrl);
        currentJpegUrl = '';
        setJpegFrame('');
      }
      updateStatus(recovering ? 'reconnecting' : 'waiting_agent');
      const ticket = await fetchJson(`/api/session-manager/remote-sessions/${session.id}/webrtc-ticket`, {
        method: 'POST', body: '{}'
      });
      if (abort.signal.aborted || endingRef.current) return;
      const generation = ++connectionGeneration;
      const controller = connectViewerWebRtc({
        ...ticket,
        onStatus: (next) => updateStatus(next, generation),
        onStats: setStats,
        qualityControlEnabled: qualityControlSupported,
        initialQualityMode: qualityModeRef.current,
        onQualityChange: (quality) => setQualityLevel(quality.level),
        onFrameMeta: (frameMeta) => { frameMetaRef.current = frameMeta; },
        onSocketClose: ({ code, reason }) => {
          if (generation === connectionGeneration && !abort.signal.aborted && !endingRef.current && code !== 1000) {
            setMessage(reason || `信令连接已关闭（${code}）`);
            void enableJpegFallback(generation);
          }
        },
        onStream: (stream) => {
          if (generation !== connectionGeneration || !videoRef.current || abort.signal.aborted || endingRef.current) return;
          videoRef.current.srcObject = stream;
          setStreamReady(true);
          observeFrames();
        }
      });
      if (generation !== connectionGeneration || abort.signal.aborted || endingRef.current) {
        controller.close();
        return;
      }
      controllerRef.current = controller;
    }
    async function resumePendingClose(browser) {
      const session = pendingBrowserClose(browser);
      if (!session) return false;
      sessionRef.current = session;
      endingRef.current = true;
      setEnding(true);
      setStatus('closing');
      setMessage('正在恢复上次关闭任务，不会重新打开店铺');
      try {
        await pollSafeClose(session.id, abort.signal);
      } catch (error) {
        if (abort.signal.aborted) return true;
        endingRef.current = false;
        setEnding(false);
        setStatus('error');
        setCloseStage('close_failed');
        setCloseError(error.message);
        setMessage(error.message);
      }
      return true;
    }
    async function createReplacementSession() {
      const browser = await findBrowser();
      if (!browser) throw new Error('浏览器窗口不存在，无法恢复远程连接');
      if (await resumePendingClose(browser)) return null;
      const session = await fetchJson('/api/session-manager/remote-sessions', {
        method: 'POST',
        body: JSON.stringify({ browserSessionId: browser.id, deviceId: shop.savedDeviceId, shopId: shop.id })
      });
      sessionRef.current = session;
      return session;
    }
    reconnectRef.current = async () => {
      if (endingRef.current) return;
      try {
        connectionGeneration += 1;
        controllerRef.current?.close();
        controllerRef.current = null;
        if (videoRef.current) videoRef.current.srcObject = null;
        setStreamReady(false);
        const session = await createReplacementSession();
        if (!session) return false;
        await connectViewer(session);
        return true;
      } catch (error) {
        setMessage(error.message || '实时连接恢复失败');
        await enableJpegFallback();
        return false;
      }
    };
    const leaseTimer = window.setInterval(() => {
      const session = sessionRef.current;
      if (!session?.id || endingRef.current || TERMINAL.has(session.status)) return;
      void fetchJson(`/api/session-manager/remote-sessions/${session.id}/heartbeat`, {
        method: 'POST', body: '{}'
      }).catch(() => undefined);
    }, REMOTE_LEASE_HEARTBEAT_MS);
    async function connect() {
      let browser = await findBrowser();
      if (!browser) {
        updateStatus('waiting');
        setMessage(`正在通知 ${shop.savedDeviceName || '远程电脑'} 打开独立 Profile...`);
        const request = await fetchJson('/api/session-manager/open-requests', {
          method: 'POST',
          body: JSON.stringify({ storeId: shop.id, deviceId: shop.savedDeviceId })
        });
        openRequestRef.current = request;
        onRequestChange?.(request);
        while (!abort.signal.aborted && !browser) {
          const progress = await fetchJson(`/api/session-manager/open-requests/${request.id}`);
          onRequestChange?.(progress.request);
          browser = await findBrowser();
          if (browser) break;
          if (progress.request.status === 'failed') throw new Error(progress.request.errorMessage || '远程电脑打开店铺失败');
          if (progress.request.status === 'cancelled') throw new Error('打开店铺请求已取消');
          if (!browser) await wait(REFRESH_MS, abort.signal);
        }
      }
      if (!browser || abort.signal.aborted) return;
      if (await resumePendingClose(browser)) return;
      const session = await fetchJson('/api/session-manager/remote-sessions', {
        method: 'POST',
        body: JSON.stringify({ browserSessionId: browser.id, deviceId: shop.savedDeviceId, shopId: shop.id })
      });
      sessionRef.current = session;
      await connectViewer(session);
    }
    connect().catch((error) => {
      if (error.name === 'AbortError') return;
      const next = statusForError(error.message, 'failed');
      setStatus(next);
      setMessage(error.message || '远程操作连接失败');
    });
    return () => {
      abort.abort();
      frameObserver?.stop();
      frameObserver = null;
      controllerRef.current?.close();
      controllerRef.current = null;
      reconnectRef.current = null;
      if (videoRef.current) videoRef.current.srcObject = null;
      if (currentJpegUrl) URL.revokeObjectURL(currentJpegUrl);
      window.clearTimeout(closeTimerRef.current);
      window.clearTimeout(wheelRef.current?.timer);
      window.clearInterval(leaseTimer);
    };
  }, [shop.id, shop.savedDeviceId]);

  function sendInput(command) {
    const operationSequence = ++operationSequenceRef.current;
    try {
      if (endingRef.current) throw new Error('店铺正在安全关闭，不能继续操作');
      if (jpegFallback) throw new Error('JPEG只读降级不能发送输入');
      setOperation('操作发送中');
      const result = controllerRef.current?.sendInput(command);
      if (!result) throw new Error('远程输入通道尚未连接');
      result.then((inputResult) => {
        if (operationSequence !== operationSequenceRef.current) return;
        if (inputResult.ok) setOperation('操作成功');
        else setOperation(`操作失败：${inputResult.error || '输入执行失败'}`);
      }).catch((error) => {
        if (operationSequence === operationSequenceRef.current) {
          setOperation(`操作失败：${error.message || '输入确认失败'}`);
        }
      });
    } catch (error) {
      if (operationSequence === operationSequenceRef.current) setOperation(`操作失败：${error.message}`);
    }
  }

  async function recoverConnection() {
    if (endingRef.current || recoveringConnection || jpegFallback) return;
    if (!connectionRecoverySupported) {
      setOperation('请先将该电脑的 Windows 助手升级到 v0.3.26');
      return;
    }
    const operationSequence = ++operationSequenceRef.current;
    setRecoveringConnection(true);
    setOperation('正在恢复画面与控制');
    try {
      const controller = controllerRef.current;
      if (!controller || ['failed', 'disconnected', 'expired', 'closed'].includes(status)) {
        const recovered = await reconnectRef.current?.();
        if (recovered && operationSequence === operationSequenceRef.current) setOperation('远程连接已重新建立');
        return;
      }
      await controller.recoverMediaAndControl();
      if (operationSequence === operationSequenceRef.current) setOperation('画面与控制已恢复');
      keyboardRef.current?.focus({ preventScroll: true });
    } catch (error) {
      if (reconnectRef.current) {
        const recovered = await reconnectRef.current();
        if (recovered && operationSequence === operationSequenceRef.current) setOperation('远程连接已重新建立');
        return;
      }
      if (operationSequence === operationSequenceRef.current) {
        setOperation(`恢复失败：${error.message || '画面与控制恢复失败'}`);
      }
    } finally {
      setRecoveringConnection(false);
    }
  }

  function videoPoint(event) {
    const video = videoRef.current;
    const rect = video?.getBoundingClientRect();
    if (!video || !rect?.width || !rect?.height) return null;
    return mapVideoPointerToCapture({
      clientX: event.clientX,
      clientY: event.clientY,
      elementRect: rect,
      videoWidth: video.videoWidth,
      videoHeight: video.videoHeight
    });
  }

  function positionKeyboardCapture(event) {
    const keyboard = keyboardRef.current;
    const stage = stageRef.current;
    const rect = stage?.getBoundingClientRect();
    if (!keyboard || !rect?.width || !rect?.height) return;
    keyboard.style.left = `${Math.max(8, Math.min(rect.width - 8, event.clientX - rect.left))}px`;
    keyboard.style.top = `${Math.max(8, Math.min(rect.height - 8, event.clientY - rect.top))}px`;
  }

  function onPointerDown(event) {
    event.currentTarget.setPointerCapture(event.pointerId);
    positionKeyboardCapture(event);
    keyboardRef.current?.focus({ preventScroll: true });
    pointerRef.current = {
      point: videoPoint(event),
      clientX: event.clientX,
      clientY: event.clientY,
      pan
    };
  }

  function onPointerMove(event) {
    if (!pointerRef.current || !panMode) return;
    setPan({
      x: pointerRef.current.pan.x + event.clientX - pointerRef.current.clientX,
      y: pointerRef.current.pan.y + event.clientY - pointerRef.current.clientY
    });
  }

  function onPointerUp(event) {
    const gesture = pointerRef.current;
    pointerRef.current = null;
    if (!gesture || panMode || !gesture.point) return;
    keyboardRef.current?.focus({ preventScroll: true });
    const end = videoPoint(event);
    if (!end) return;
    const captureWidth = videoRef.current.videoWidth;
    const captureHeight = videoRef.current.videoHeight;
    if (Math.hypot(end.x - gesture.point.x, end.y - gesture.point.y) < 6) {
      sendInput({ type: 'click', ...end, captureWidth, captureHeight });
    } else {
      sendInput({ type: 'drag', start: gesture.point, end, captureWidth, captureHeight });
    }
  }

  function onDoubleClick(event) {
    const point = videoPoint(event);
    if (point) sendInput({
      type: 'doubleClick', ...point,
      captureWidth: videoRef.current.videoWidth,
      captureHeight: videoRef.current.videoHeight
    });
  }

  function onWheel(event) {
    event.preventDefault();
    if (panMode) return;
    const point = videoPoint(event);
    if (!point) return;
    const current = wheelRef.current;
    const next = current || {
      deltaX: 0,
      deltaY: 0,
      timer: window.setTimeout(() => {
        const pending = wheelRef.current;
        wheelRef.current = null;
        if (!pending) return;
        sendInput({
          type: 'scroll',
          ...pending.point,
          captureWidth: pending.captureWidth,
          captureHeight: pending.captureHeight,
          deltaX: Math.max(-2000, Math.min(2000, Math.round(pending.deltaX))),
          deltaY: Math.max(-2000, Math.min(2000, Math.round(pending.deltaY)))
        });
      }, 50)
    };
    next.point = point;
    next.captureWidth = videoRef.current.videoWidth;
    next.captureHeight = videoRef.current.videoHeight;
    next.deltaX += event.deltaX;
    next.deltaY += event.deltaY;
    wheelRef.current = next;
  }

  function onKeyboard(event) {
    if (event.isComposing || composingRef.current || event.key === 'Process') return;
    if (event.key === 'Escape' && document.fullscreenElement) {
      event.preventDefault();
      event.stopPropagation();
      document.exitFullscreen().catch(() => undefined);
      return;
    }
    const isSpace = event.key === ' ' || event.key === 'Spacebar';
    const isLocalImeSwitch = (
      ((event.ctrlKey || event.metaKey) && !event.altKey && isSpace) ||
      (event.shiftKey && (event.ctrlKey || event.altKey) &&
        ['Alt', 'Control', 'Shift'].includes(event.key))
    );
    if (isLocalImeSwitch) return;
    if (event.ctrlKey && !event.altKey && !event.metaKey && event.key === 'Tab') {
      event.preventDefault();
      sendInput({ type: event.shiftKey ? 'previousTab' : 'nextTab' });
      return;
    }
    if (event.ctrlKey && !event.altKey && !event.metaKey && event.key.toLowerCase() === 'w') {
      event.preventDefault();
      sendInput({ type: 'closeTab' });
      return;
    }
    if (event.ctrlKey || event.altKey || event.metaKey) {
      event.preventDefault();
      return;
    }
    if (NAMED_KEYS.has(event.key)) {
      event.preventDefault();
      sendInput({ type: 'key', key: `${event.shiftKey ? 'Shift+' : ''}${event.key === ' ' ? 'Space' : event.key}` });
    }
  }

  function onTextInput(event) {
    if (composingRef.current || event.nativeEvent?.isComposing) return;
    const text = event.currentTarget.value;
    event.currentTarget.value = '';
    if (text) sendInput({ type: 'text', text });
  }

  async function pollSafeClose(id, signal = closeAbortRef.current?.signal) {
    await pollBrowserClose({ sessionId: id, fetchJson, signal, onUpdate: (next) => {
      sessionRef.current = next;
      if (next.closeStage && (next.closeStage !== 'safe_closed' || browserCloseConfirmed(next))) setCloseStage(next.closeStage);
      setStatus(next.status === 'ended' && !browserCloseConfirmed(next) ? 'closed' : next.status);
      setMessage(next.error || CLOSE_STAGE_LABELS[next.closeStage === 'safe_closed' && !browserCloseConfirmed(next) ? '' : next.closeStage] || WEBRTC_STATUS_LABELS[next.status] || next.status);
    } });
    endingRef.current = false;
    endedRef.current = true;
    setEnding(false);
    setCloseError('');
    setCloseStage('safe_closed');
    setMessage('店铺已安全关闭');
    onRequestChange?.({ status: 'completed', currentStep: 'browser_closed', progress: 100 });
    closeTimerRef.current = window.setTimeout(onClose, 600);
  }

  async function closeRemote() {
    if (status === 'ended' && endedRef.current) {
      onClose();
      return;
    }
    if (endingRef.current) return;
    const confirmed = window.confirm(
      `确认结束远程操作并关闭“${shop.name}”吗？\n\n将关闭远程电脑上的当前店铺浏览器，本机 Profile 会完成落盘；更换电脑后需要重新登录。`
    );
    if (!confirmed) return;
    endingRef.current = true;
    setEnding(true);
    setCloseError('');
    setStatus('closing');
    setCloseStage('stopping_remote');
    setMessage('正在停止远程控制');
    try {
      const closeFetchJson = (path, options) => fetchCloseJson(fetchJson, path, { ...options, signal: closeAbortRef.current?.signal });
      const closeSession = await ensureRemoteSessionForClose(sessionRef, shop, closeFetchJson);
      const id = closeSession?.id;
      if (!id) {
        if (openRequestRef.current?.id) {
          await closeFetchJson(`/api/session-manager/open-requests/${openRequestRef.current.id}`, { method: 'DELETE' })
            .catch((error) => {
              if (!String(error.message || '').includes('不存在或已经结束')) throw error;
            });
        }
        endingRef.current = false;
        setEnding(false);
        onClose();
        return;
      }
      const result = await closeFetchJson(`/api/session-manager/remote-sessions/${id}`, { method: 'DELETE' });
      setCloseStage(browserCloseConfirmed(result) ? 'safe_closed' : 'notifying_agent');
      controllerRef.current?.close();
      controllerRef.current = null;
      if (videoRef.current) videoRef.current.srcObject = null;
      setStreamReady(false);
      if (browserCloseConfirmed(result)) {
        endingRef.current = false;
        endedRef.current = true;
        setEnding(false);
        setStatus('ended');
        setMessage('店铺已安全关闭');
        closeTimerRef.current = window.setTimeout(onClose, 600);
        return;
      }
      await pollSafeClose(id);
    } catch (error) {
      if (closeAbortRef.current?.signal.aborted) return;
      endingRef.current = false;
      setEnding(false);
      setStatus('error');
      setCloseStage('close_failed');
      setCloseError(error.message || '关闭失败，店铺浏览器可能仍在运行');
      setMessage(error.message || '关闭失败，店铺浏览器可能仍在运行');
    }
  }

  function dismissFailedClose() {
    if (!window.confirm('关闭任务尚未成功，远程电脑上的店铺浏览器可能仍在运行。确认仅退出当前界面吗？')) return;
    controllerRef.current?.close();
    controllerRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    onClose();
  }

  function changeQualityMode(event) {
    const mode = event.target.value;
    qualityModeRef.current = mode;
    setQualityMode(mode);
    const quality = controllerRef.current?.setQualityMode(mode);
    if (quality?.level) setQualityLevel(quality.level);
    setOperation(mode === 'auto'
      ? `画质已设为自动（当前${REMOTE_QUALITY_PROFILES[quality?.level || qualityLevel].label}）`
      : `画质已锁定为${REMOTE_QUALITY_PROFILES[mode].label}`);
  }

  const connectionFailed = ['failed', 'error', 'offline', 'browser_missing', 'page_not_allowed', 'expired', 'closed', 'disconnected'].includes(status);
  const authorizationFailed = /未允许远程控制|未启用远程|未开启远程|无权|没有.*权限/.test(message);
  const awaitingMedia = !connectionFailed && !ending && status !== 'ended';
  const noMediaText = status === 'ended' ? '视频已结束' : connectionFailed ? '暂无视频画面' : '等待视频统计';
  const metrics = stats
    ? `${stats.width || 0}×${stats.height || 0} · ${Math.round(stats.decodeFps || 0)} FPS · ${Math.round((stats.bitrate || 0) / 1000)} kbps · RTT ${stats.roundTripTimeMs || 0} ms · 丢包 ${stats.packetsLost || 0} · ${stats.connectionType === 'turn' ? 'TURN' : 'P2P'}`
    : noMediaText;

  return <div className="sm-remote-backdrop" role="presentation">
    <section className="sm-remote-dialog" role="dialog" aria-modal="true" aria-labelledby="sm-remote-title">
      <header><div><span className={`sm-remote-dot ${status}`} /><div><h2 id="sm-remote-title">{shop.name} · 远程操作</h2><p>{WEBRTC_STATUS_LABELS[status] || status}：{message}</p></div></div><button onClick={closeRemote} aria-label="关闭"><X size={20} /></button></header>
      <div className="sm-remote-toolbar">
        <div className="sm-remote-tools">
        <button className={panMode ? '' : 'active'} onClick={() => setPanMode(false)}><MousePointer2 size={15} />操作画面</button>
        <button className={panMode ? 'active' : ''} onClick={() => setPanMode(true)}><Hand size={15} />移动画面</button>
        <button onClick={() => { setFit(true); setZoom(1); setPan({ x: 0, y: 0 }); }}>适应窗口</button>
        <label><Maximize2 size={15} />缩放<select value={zoom} onChange={(event) => { setFit(false); setZoom(Number(event.target.value)); setPan({ x: 0, y: 0 }); }}>{ZOOM_LEVELS.map((level) => <option key={level} value={level}>{level}×</option>)}</select></label>
        <label title={qualityControlSupported ? '自动模式根据网络质量切换传输码率' : '请先将该电脑的 Windows 助手升级到 v0.3.31'}>画质<select value={qualityMode} disabled={!qualityControlSupported || ending || jpegFallback} onChange={changeQualityMode}><option value="auto">自动（{REMOTE_QUALITY_PROFILES[qualityLevel].label}）</option><option value="clear">清晰</option><option value="balanced">均衡</option><option value="smooth">流畅</option></select></label>
        <button onClick={() => stageRef.current?.requestFullscreen?.()}><Maximize2 size={15} />全屏</button>
        {!jpegFallback && <button onClick={recoverConnection} disabled={ending || recoveringConnection || !connectionRecoverySupported} title={connectionRecoverySupported ? '在当前远程会话内恢复画面与控制，不重新打开店铺' : '请先将该电脑的 Windows 助手升级到 v0.3.26'}><RefreshCw className={recoveringConnection ? 'spinning' : ''} size={15} />{recoveringConnection ? '恢复中' : '恢复连接'}</button>}
        {jpegFallback && <button onClick={() => reconnectRef.current?.()}>重试实时连接</button>}
        </div>
        <div className="sm-remote-telemetry" aria-live="polite"><span>{frameUpdatedAt ? `画面更新 ${frameUpdatedAt.toLocaleTimeString('zh-CN', { hour12: false })}` : metrics}</span>
        <strong>{operation}</strong></div>
      </div>
      <div ref={stageRef} className={`sm-remote-stage ${!streamReady && !jpegFrame ? 'empty' : 'has-media'} ${panMode ? 'pan' : 'control'}`}>
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className={`${fit ? 'fit' : 'actual'}${!streamReady ? ' sm-remote-media-unready' : ''}`}
          style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => { pointerRef.current = null; }}
          onDoubleClick={onDoubleClick}
          onWheel={onWheel}
        />
        {jpegFallback && jpegFrame && <img className="sm-remote-fallback-frame" src={jpegFrame} alt="JPEG只读降级画面" />}
        <textarea
          ref={keyboardRef}
          className="sm-remote-keyboard-capture"
          aria-label="远程键盘输入"
          disabled={jpegFallback || ending}
          onKeyDown={onKeyboard}
          onInput={onTextInput}
          onCompositionStart={() => { composingRef.current = true; }}
          onCompositionEnd={(event) => {
            composingRef.current = false;
            const text = event.data || event.currentTarget.value;
            event.currentTarget.value = '';
            if (text) sendInput({ type: 'text', text });
          }}
        />
        <button
          type="button"
          className="sm-remote-fullscreen-exit"
          onClick={() => document.exitFullscreen?.().catch(() => undefined)}
        >
          <X size={16} />退出全屏
        </button>
        {!streamReady && !jpegFrame && <div className={`sm-remote-wait ${connectionFailed ? 'error' : ''}`} role={connectionFailed ? 'alert' : 'status'}>{awaitingMedia && <span className="sm-remote-spinner" />}<strong>{WEBRTC_STATUS_LABELS[status] || '正在请求'}</strong><p>{message}</p>{authorizationFailed ? <small>请由管理员在当前用途的「授权电脑 → 远程协助设置」中核对负责电脑{shop.savedDeviceName ? `「${shop.savedDeviceName}」` : ''}{shop.savedDeviceCode ? `（${shop.savedDeviceCode}）` : ''}的授权；授权后可恢复连接。</small> : <small>Windows 助手主动连接 OA，不开放电脑入站端口。</small>}</div>}
      </div>
      <footer>
        <span>{closeStage ? `${CLOSE_STAGE_LABELS[closeStage] || closeStage}${CLOSE_STAGE_PROGRESS[closeStage] ? `（${CLOSE_STAGE_PROGRESS[closeStage]}%）` : ''}` : `${metrics}。仅控制当前店铺所属平台的商家网页，不支持桌面、文件或剪贴板操作。`}{closeError ? `：${closeError}` : ''}</span>
        <button className={status === 'ended' ? '' : 'sm-danger'} disabled={ending} onClick={closeRemote}>
          {ending ? '正在安全关闭...' : status === 'ended' ? '完成' : closeError ? '重试关闭' : '结束远程操作'}
        </button>
        {closeError && !ending && <button onClick={dismissFailedClose}>仅退出界面</button>}
      </footer>
    </section>
  </div>;
}

function LegacyPddRemoteAssistDialog({ shop, onClose, onRequestChange, requestJson = defaultFetchJson, requestBlob = defaultFetchBlob }) {
  const fetchJson = requestJson;
  const fetchBlob = requestBlob;
  const [status, setStatus] = useState('requesting');
  const [message, setMessage] = useState('正在检查远程电脑上的店铺窗口...');
  const [remoteSession, setRemoteSession] = useState(null);
  const [frame, setFrame] = useState({ current: '', previous: '', frameSequence: 0 });
  const [frameUpdatedAt, setFrameUpdatedAt] = useState(null);
  const [operation, setOperation] = useState('');
  const [ending, setEnding] = useState(false);
  const [closeStage, setCloseStage] = useState('');
  const [closeError, setCloseError] = useState('');
  const [zoom, setZoom] = useState(1);
  const [panMode, setPanMode] = useState(false);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const pointer = useRef(null);
  const sessionRef = useRef(null);
  const openRequestRef = useRef(null);
  const closeAbortRef = useRef(null);

  useEffect(() => {
    const controller = new AbortController();
    closeAbortRef.current = controller;
    let currentObjectUrl = '';
    let previousObjectUrl = '';
    const findBrowser = () => findManagedBrowser(shop, fetchJson);
    async function connect() {
      let browser = await findBrowser();
      if (!browser) {
        setStatus('waiting');
        setMessage(`正在通知 ${shop.savedDeviceName || '远程电脑'} 打开独立 Profile...`);
        const request = await fetchJson('/api/session-manager/open-requests', {
          method: 'POST',
          body: JSON.stringify({ storeId: shop.id, deviceId: shop.savedDeviceId })
        });
        openRequestRef.current = request;
        onRequestChange?.(request);
        while (!controller.signal.aborted && !browser) {
          const progress = await fetchJson(`/api/session-manager/open-requests/${request.id}`);
          onRequestChange?.(progress.request);
          browser = await findBrowser();
          if (browser) break;
          if (progress.request.status === 'failed') throw new Error(progress.request.errorMessage || '远程电脑打开店铺失败');
          if (progress.request.status === 'cancelled') throw new Error('打开店铺请求已取消');
          if (!browser) await wait(REFRESH_MS, controller.signal);
        }
      }
      if (!browser || controller.signal.aborted) return;
      const pendingClose = pendingBrowserClose(browser);
      if (pendingClose) {
        sessionRef.current = pendingClose;
        setRemoteSession(pendingClose);
        setEnding(true);
        setStatus('closing');
        setMessage('正在恢复上次关闭任务，不会重新打开店铺');
        await pollSafeClose(pendingClose.id, controller.signal);
        return;
      }
      setStatus('requested');
      setMessage('浏览器窗口已打开，正在等待助手传输画面...');
      const session = await fetchJson('/api/session-manager/remote-sessions', {
        method: 'POST',
        body: JSON.stringify({ browserSessionId: browser.id, deviceId: shop.savedDeviceId, shopId: shop.id })
      });
      sessionRef.current = session;
      setRemoteSession(session);
      while (!controller.signal.aborted) {
        const next = await fetchJson(`/api/session-manager/remote-sessions/${session.id}`);
        setRemoteSession(next);
        setStatus(statusForError(next.error, next.status === 'ended' && !browserCloseConfirmed(next) ? 'closed' : next.status));
        setMessage(next.error || STATUS_LABELS[next.status === 'ended' && !browserCloseConfirmed(next) ? 'closed' : next.status] || next.status);
        if (next.closeStage && (next.closeStage !== 'safe_closed' || browserCloseConfirmed(next))) setCloseStage(next.closeStage);
        if (browserCloseConfirmed(next)) {
          setEnding(false);
          setCloseError('');
          setCloseStage('safe_closed');
        } else if (next.status === 'error' && next.closeRequestedAt) {
          setEnding(false);
          setCloseError(next.error || '关闭失败，店铺浏览器可能仍在运行');
          setCloseStage('close_failed');
        }
        if (next.frameAvailable && next.frameSequence > Number(sessionRef.current?.frameSequence || 0)) {
          const result = await fetchBlob(`/api/session-manager/remote-sessions/${session.id}/frame`);
          const objectUrl = URL.createObjectURL(result.blob);
          if (previousObjectUrl) URL.revokeObjectURL(previousObjectUrl);
          previousObjectUrl = currentObjectUrl;
          currentObjectUrl = objectUrl;
          sessionRef.current = { ...next, frameSequence: next.frameSequence };
          setFrame({ current: objectUrl, previous: previousObjectUrl, frameSequence: next.frameSequence });
          setFrameUpdatedAt(new Date());
        }
        if (TERMINAL.has(next.status)) return;
        await wait(REFRESH_MS, controller.signal);
      }
    }
    connect().catch((error) => {
      if (error.name === 'AbortError') return;
      if (sessionRef.current?.closeRequestedAt) {
        setEnding(false);
        setCloseStage('close_failed');
        setCloseError(error.message);
      }
      setStatus(statusForError(error.message));
      setMessage(error.message || '远程操作连接失败');
    });
    return () => {
      controller.abort();
      if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
      if (previousObjectUrl) URL.revokeObjectURL(previousObjectUrl);
    };
  }, [shop.id, shop.savedDeviceId]);

  async function sendCommand(command) {
    if (!remoteSession?.id || status !== 'connected') return;
    setOperation('操作发送中');
    try {
      const queued = await fetchJson(`/api/session-manager/remote-sessions/${remoteSession.id}/commands`, {
        method: 'POST', body: JSON.stringify(command)
      });
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const result = await fetchJson(`/api/session-manager/remote-sessions/${remoteSession.id}/commands/${queued.id}`);
        if (result.status === 'completed') {
          setOperation('操作成功');
          return;
        }
        if (['failed', 'cancelled'].includes(result.status)) throw new Error(result.error || '助手未能执行操作');
        await new Promise((resolve) => window.setTimeout(resolve, 120));
      }
      throw new Error('等待助手回报操作结果超时');
    } catch (error) {
      setOperation(`操作失败：${error.message}`);
    }
  }

  async function pollSafeClose(id, signal = closeAbortRef.current?.signal) {
    await pollBrowserClose({ sessionId: id, fetchJson, signal, onUpdate: (next) => {
      sessionRef.current = next;
      setRemoteSession(next);
      setStatus(next.status === 'ended' && !browserCloseConfirmed(next) ? 'closed' : next.status);
      if (next.closeStage && (next.closeStage !== 'safe_closed' || browserCloseConfirmed(next))) setCloseStage(next.closeStage);
      setMessage(next.error || CLOSE_STAGE_LABELS[next.closeStage === 'safe_closed' && !browserCloseConfirmed(next) ? '' : next.closeStage] || STATUS_LABELS[next.status === 'ended' && !browserCloseConfirmed(next) ? 'closed' : next.status]);
    } });
    setEnding(false);
    setCloseError('');
    setCloseStage('safe_closed');
    setMessage('店铺已安全关闭');
    onRequestChange?.({ status: 'completed', currentStep: 'browser_closed', progress: 100 });
  }

  async function endRemoteOperation() {
    if (status === 'ended') {
      onClose();
      return;
    }
    if (ending) return;
    const confirmed = window.confirm(
      `确认结束远程操作并关闭“${shop.name}”吗？\n\n将关闭远程电脑上的当前店铺浏览器，本机 Profile 会完成落盘；更换电脑后需要重新登录。`
    );
    if (!confirmed) return;
    setEnding(true);
    setCloseError('');
    setStatus('closing');
    setCloseStage('stopping_remote');
    setMessage('正在停止远程控制');
    try {
      const closeFetchJson = (path, options) => fetchCloseJson(fetchJson, path, { ...options, signal: closeAbortRef.current?.signal });
      const closeSession = await ensureRemoteSessionForClose(sessionRef, shop, closeFetchJson);
      const id = closeSession?.id;
      if (!id) {
        const requestId = openRequestRef.current?.id;
        if (requestId) {
          await closeFetchJson(`/api/session-manager/open-requests/${requestId}`, { method: 'DELETE' })
            .catch((error) => {
              if (!String(error.message || '').includes('不存在或已经结束')) throw error;
            });
        }
        setEnding(false);
        onClose();
        return;
      }
      const result = await closeFetchJson(`/api/session-manager/remote-sessions/${id}`, { method: 'DELETE' });
      setCloseStage(browserCloseConfirmed(result) ? 'safe_closed' : 'notifying_agent');
      if (browserCloseConfirmed(result)) {
        setStatus('ended');
        setEnding(false);
        setMessage('店铺已安全关闭');
        return;
      }
      await pollSafeClose(id);
    } catch (error) {
      if (closeAbortRef.current?.signal.aborted) return;
      setEnding(false);
      setStatus('error');
      setCloseStage('close_failed');
      setCloseError(error.message || '关闭失败，店铺浏览器可能仍在运行');
      setMessage(error.message || '关闭失败，店铺浏览器可能仍在运行');
    }
  }

  function onPointerDown(event) {
    event.currentTarget.setPointerCapture(event.pointerId);
    pointer.current = { start: pointFromEvent(event), clientX: event.clientX, clientY: event.clientY, pan, points: [] };
  }

  function onPointerMove(event) {
    if (!pointer.current) return;
    if (panMode) {
      setPan({ x: pointer.current.pan.x + event.clientX - pointer.current.clientX, y: pointer.current.pan.y + event.clientY - pointer.current.clientY });
      return;
    }
    const point = pointFromEvent(event);
    pointer.current.points.push({ ...point, t: point.t - pointer.current.start.t });
  }

  function onPointerUp(event) {
    if (!pointer.current) return;
    const gesture = pointer.current;
    pointer.current = null;
    if (panMode) return;
    const end = pointFromEvent(event);
    const distance = Math.hypot(end.x - gesture.start.x, end.y - gesture.start.y);
    if (distance < 0.006) {
      void sendCommand({ kind: 'click', point: end });
      return;
    }
    const points = [{ ...gesture.start, t: 0 }, ...gesture.points, { ...end, t: end.t - gesture.start.t }].slice(0, 80);
    void sendCommand({ kind: 'drag', points });
  }

  function onWheel(event) {
    event.preventDefault();
    void sendCommand({ kind: 'scroll', deltaY: Math.max(-2000, Math.min(2000, Math.round(event.deltaY))) });
  }

  const connectionFailed = ['error', 'offline', 'browser_missing', 'page_not_allowed', 'expired', 'closed'].includes(status);
  const authorizationFailed = /未允许远程控制|未启用远程|未开启远程|无权|没有.*权限/.test(message);

  return <div className="sm-remote-backdrop" role="presentation">
    <section className="sm-remote-dialog" role="dialog" aria-modal="true" aria-labelledby="sm-remote-title">
      <header><div><span className={`sm-remote-dot ${status}`} /><div><h2 id="sm-remote-title">{shop.name} · 远程操作</h2><p>{STATUS_LABELS[status] || status}：{message}</p></div></div><button onClick={endRemoteOperation} aria-label="关闭"><X size={20} /></button></header>
      <div className="sm-remote-toolbar">
        <button className={panMode ? '' : 'active'} onClick={() => setPanMode(false)}><MousePointer2 size={15} />操作画面</button>
        <button className={panMode ? 'active' : ''} onClick={() => setPanMode(true)}><Hand size={15} />移动画面</button>
        <label><Maximize2 size={15} />缩放<select value={zoom} onChange={(event) => { setZoom(Number(event.target.value)); setPan({ x: 0, y: 0 }); }}>{ZOOM_LEVELS.map((level) => <option key={level} value={level}>{level}×</option>)}</select></label>
        <span>{frameUpdatedAt ? `画面更新 ${frameUpdatedAt.toLocaleTimeString('zh-CN', { hour12: false })}` : connectionFailed ? '暂无视频画面' : '尚未收到画面'}</span>
        <strong>{operation}</strong>
      </div>
      <div className={`sm-remote-stage ${frame.current ? 'has-media' : 'empty'} ${panMode ? 'pan' : 'control'}`}>
        {frame.previous && <img className="previous" src={frame.previous} alt="上一帧远程画面" />}
        {frame.current ? <img
          key={frame.frameSequence}
          src={frame.current}
          alt="店铺远程画面"
          draggable="false"
          style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => { pointer.current = null; }}
          onWheel={onWheel}
        /> : <div className={`sm-remote-wait ${connectionFailed ? 'error' : ''}`} role={connectionFailed ? 'alert' : 'status'}>{!connectionFailed && !ending && status !== 'ended' && <span className="sm-remote-spinner" />}<strong>{STATUS_LABELS[status] || '正在请求'}</strong><p>{message}</p>{authorizationFailed ? <small>请由管理员在当前用途的「授权电脑 → 远程协助设置」中核对负责电脑{shop.savedDeviceName ? `「${shop.savedDeviceName}」` : ''}{shop.savedDeviceCode ? `（${shop.savedDeviceCode}）` : ''}的授权；授权后重试。</small> : <small>远程电脑不开放入站端口，由 Windows 助手主动连接 OA。</small>}</div>}
      </div>
      <footer>
        <span>{closeStage ? `${CLOSE_STAGE_LABELS[closeStage] || closeStage}${CLOSE_STAGE_PROGRESS[closeStage] ? `（${CLOSE_STAGE_PROGRESS[closeStage]}%）` : ''}` : '仅允许点击、拖动和滚动，不支持键盘、文本输入或文件操作。'}{closeError ? `：${closeError}` : ''}</span>
        <button className={status === 'ended' ? '' : 'sm-danger'} disabled={ending} onClick={endRemoteOperation}>
          {ending ? '正在安全关闭...' : status === 'ended' ? '完成' : closeError ? '重试关闭' : '结束远程操作'}
        </button>
      </footer>
    </section>
  </div>;
}

export default function PddRemoteAssistDialog(props) {
  return WEBRTC_REMOTE_ENABLED
    ? <WebRtcRemoteAssistDialog {...props} />
    : <LegacyPddRemoteAssistDialog {...props} />;
}
