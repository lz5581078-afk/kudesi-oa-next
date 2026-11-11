'use strict';

// Runs only in the verified Express list frame during an OA-initiated query.
// Observe the page's own check without initiating or changing its requests.
async function expressRecordingResponse(command, afterSaleIds = []) {
  const key = Symbol.for('kudesi.oa.expressRecordingResponse');
  if (command === 'stop') return window[key]?.stop();
  if (command === 'read') return window[key]?.read(afterSaleIds) ?? [];
  if (command !== 'start' || window[key]) return;

  const endpoint = 'https://sc.scm121.com/api/company/after-sale/ipc/has-video';
  const matches = value => {
    try {
      const url = new URL(value, location.href);
      return !url.username && !url.password && url.origin + url.pathname === endpoint;
    } catch { return false; }
  };
  const available = new Set();
  const checked = new Set();
  let active = true;
  let pending = 0;
  function normalizeIds(values) {
    if (!Array.isArray(values) || values.length > 1000) return null;
    const ids = values.map(value => typeof value === 'string' || Number.isSafeInteger(value) ? String(value) : '');
    return ids.every(id => /^\d{4,40}$/.test(id)) ? new Set(ids) : null;
  }
  function requestScope(raw) {
    if (typeof raw !== 'string' || raw.length > 64000) return null;
    try { return normalizeIds(JSON.parse(raw)); }
    catch { return null; }
  }
  function capture(body, scope) {
    if (!active || body?.success !== true) return;
    const returned = normalizeIds(body.data);
    if (!returned) return;
    for (const id of returned) {
      if (!scope || scope.has(id)) available.add(id);
    }
    // A complete successful batch returns only the IDs with recordings.
    if (scope && body.hasNext === false && [...returned].every(id => scope.has(id))) {
      for (const id of scope) checked.add(id);
    }
  }

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  const originalFetch = window.fetch;
  const watched = new WeakSet();
  function open(method, url, ...rest) {
    const result = originalOpen.call(this, method, url, ...rest);
    if (String(method).toUpperCase() === 'POST' && matches(url)) watched.add(this);
    else watched.delete(this);
    return result;
  }
  function send(...args) {
    if (!watched.has(this)) return originalSend.apply(this, args);
    const scope = requestScope(args[0]);
    const complete = () => {
      pending--;
      if (!active || this.status < 200 || this.status >= 300 || !matches(this.responseURL)) return;
      try { capture(this.responseType === 'json' ? this.response : JSON.parse(this.responseText), scope); }
      catch { /* An unusable response leaves the recording status unknown. */ }
    };
    this.addEventListener('loadend', complete, {once: true});
    pending++;
    try { return originalSend.apply(this, args); }
    catch (error) {
      this.removeEventListener('loadend', complete);
      pending--;
      throw error;
    }
  }
  function fetch(input, options) {
    if (String(options?.method ?? input?.method).toUpperCase() !== 'POST' || !matches(input?.url ?? input)) {
      return originalFetch.apply(this, arguments);
    }
    let scope = Promise.resolve(requestScope(options?.body));
    if (options?.body === undefined && typeof input?.clone === 'function') {
      try { scope = input.clone().text().then(requestScope).catch(() => null); }
      catch { /* A consumed request still permits positive results. */ }
    }
    const result = originalFetch.apply(this, arguments);
    pending++;
    void result.then(response => {
      if (active && response.ok && matches(response.url)) {
        return Promise.all([response.clone().json(), scope]).then(([body, ids]) => capture(body, ids));
      }
    }).catch(() => {}).finally(() => { pending--; });
    return result;
  }

  XMLHttpRequest.prototype.open = open;
  XMLHttpRequest.prototype.send = send;
  if (typeof originalFetch === 'function') window.fetch = fetch;
  window[key] = {
    async read(requested) {
      const deadline = Date.now() + 550;
      while (active && pending && !requested.every(id => available.has(id)) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      return requested.flatMap(id => available.has(id) ? [[id,'available']] :
        checked.has(id) ? [[id,'unavailable']] : []);
    },
    stop() {
      active = false;
      if (XMLHttpRequest.prototype.open === open) XMLHttpRequest.prototype.open = originalOpen;
      if (XMLHttpRequest.prototype.send === send) XMLHttpRequest.prototype.send = originalSend;
      if (window.fetch === fetch) window.fetch = originalFetch;
      delete window[key];
    },
  };
}

module.exports = {expressRecordingResponse};
