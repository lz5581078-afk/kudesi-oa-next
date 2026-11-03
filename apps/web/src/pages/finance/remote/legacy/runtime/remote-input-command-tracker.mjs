export const INPUT_RESULT_TIMEOUT_MS = 5_000;

export function createRemoteInputCommandTracker(options = {}) {
  const {
    timeoutMs = INPUT_RESULT_TIMEOUT_MS,
    setTimer = globalThis.setTimeout,
    clearTimer = globalThis.clearTimeout
  } = options;
  const pending = new Map();

  function waitForResult(commandId) {
    if (!commandId || pending.has(commandId)) throw new Error('远程输入命令编号无效');
    return new Promise((resolve, reject) => {
      const timer = setTimer(() => {
        pending.delete(commandId);
        reject(new Error('操作确认超时，请重试'));
      }, timeoutMs);
      pending.set(commandId, { resolve, reject, timer });
    });
  }

  function settle(commandId, action, value) {
    const current = pending.get(commandId);
    if (!current) return false;
    pending.delete(commandId);
    clearTimer(current.timer);
    current[action](value);
    return true;
  }

  function resolve(result) {
    return settle(String(result?.commandId || ''), 'resolve', result);
  }

  function reject(commandId, error) {
    return settle(String(commandId || ''), 'reject', error);
  }

  function rejectAll(error) {
    for (const commandId of [...pending.keys()]) reject(commandId, error);
  }

  return Object.freeze({ pendingCount: () => pending.size, reject, rejectAll, resolve, waitForResult });
}
