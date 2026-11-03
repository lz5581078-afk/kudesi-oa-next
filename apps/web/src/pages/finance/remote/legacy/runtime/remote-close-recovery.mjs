export function pendingBrowserClose(browser) {
  if (browser?.status !== 'closing') return null;
  if (!browser.closeSession?.id) throw new Error('店铺仍在关闭，但关闭任务暂不可用，请刷新后重试；不能确认浏览器已关闭');
  return browser.closeSession;
}

export async function pollBrowserClose({ sessionId, fetchJson, onUpdate, signal, timeoutMs = 70000, intervalMs = 350 }) {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason || new DOMException('Aborted', 'AbortError'));
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(() => controller.abort(new Error('等待安全关闭超时，店铺浏览器可能仍在运行；可重试关闭或仅退出界面')), timeoutMs);
  let delayTimer;
  const aborted = new Promise((_, reject) => {
    const rejectAbort = () => reject(controller.signal.reason);
    if (controller.signal.aborted) rejectAbort();
    else controller.signal.addEventListener('abort', rejectAbort, { once: true });
  });
  try {
    while (true) {
      controller.signal.throwIfAborted();
      const next = await Promise.race([
        Promise.resolve().then(() => fetchJson(`/api/session-manager/remote-sessions/${sessionId}`, { signal: controller.signal })),
        aborted
      ]);
      controller.signal.throwIfAborted();
      onUpdate?.(next);
      if (next.status === 'ended' && next.closeStage === 'safe_closed') return next;
      if (['error', 'expired', 'closed', 'ended'].includes(next.status)) {
        throw new Error(next.error || '关闭尚未确认，店铺浏览器可能仍在运行，请重试关闭');
      }
      await Promise.race([new Promise((resolve) => { delayTimer = setTimeout(resolve, intervalMs); }), aborted]);
    }
  } finally {
    clearTimeout(timer);
    clearTimeout(delayTimer);
    signal?.removeEventListener('abort', abort);
  }
}

export async function fetchCloseJson(fetchJson, path, options = {}, timeoutMs = 15000) {
  options.signal?.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal.reason);
  options.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('关闭请求超时，不能确认店铺已关闭，请重试关闭')), timeoutMs);
  try {
    return await Promise.race([
      Promise.resolve().then(() => fetchJson(path, { ...options, signal: controller.signal })),
      new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true }))
    ]);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }
}
