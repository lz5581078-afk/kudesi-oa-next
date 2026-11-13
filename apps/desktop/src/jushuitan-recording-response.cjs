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
  const states = new Map();
  const latest = new Map();
  let sequence = 0;
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
  function begin(scope) {
    const version=++sequence;
    for(const id of scope??[]){latest.set(id,version);states.delete(id);}
    return version;
  }
  function capture(body, scope, version) {
    if (!active || !scope || body?.success !== true) return;
    const returned = normalizeIds(body.data);
    if (!returned || [...returned].some(id=>!scope.has(id))) return;
    for(const id of scope){
      if(latest.get(id)!==version)continue;
      if(returned.has(id))states.set(id,'available');
      // This endpoint returns the complete set of IDs with recordings, not a page.
      // The source UI tests membership in data; it does not require hasNext.
      else if(body.hasNext===undefined||body.hasNext===false)states.set(id,'unavailable');
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
    const version=begin(scope);
    const complete = () => {
      pending--;
      if (!active || this.status < 200 || this.status >= 300 || !matches(this.responseURL)) return;
      try { capture(this.responseType === 'json' ? this.response : JSON.parse(this.responseText), scope, version); }
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
      catch { /* A consumed request cannot establish the recording identity. */ }
    }
    const version=++sequence;
    scope=scope.then(ids=>{for(const id of ids??[]){if((latest.get(id)??0)<version){latest.set(id,version);states.delete(id);}}return ids;});
    const result = originalFetch.apply(this, arguments);
    pending++;
    void result.then(response => {
      if (active && response.ok && matches(response.url)) {
        return Promise.all([response.clone().json(), scope]).then(([body, ids]) => capture(body, ids, version));
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
      while (active && pending && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      return requested.flatMap(id => states.has(id) ? [[id,states.get(id)]] : []);
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
