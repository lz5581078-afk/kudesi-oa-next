/**
 * 助手端到端：真实 Chromium + 本机假平台后台 + 真实 OA 接口（需要 API 在 4000 端口、库已迁移）。
 *   KUDESI_CHROME=<chrome路径> node scripts/e2e.cjs
 * 第二部分用一个迷你 OA 桩验证截图上传（真实 OA 的七牛在本机不可用，上传接口已有数据库测试覆盖）。
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const API = process.env.OA_API || 'http://127.0.0.1:4000';
const ok = (c, m) => { if (!c) throw new Error('断言失败：' + m); console.log('  ✓', m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms, what) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('等待超时：' + what); await sleep(300); } };

function fakePlatform() {
  const stats = { logins: 0, wrong: 0 };
  const srv = http.createServer((req, res) => {
    const cookie = req.headers.cookie || '';
    if (req.url === '/login' && req.method === 'POST') {
      let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => {
        const q = new URLSearchParams(b);
        if (q.get('account') === 'shop1' && q.get('password') === 'pw-123456') { stats.logins++; res.writeHead(302, { 'set-cookie': 'sid=ok; Path=/; Max-Age=86400', location: '/' }); res.end(); }
        else { stats.wrong++; res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(form('账号或密码错误')); }
      }); return;
    }
    if (req.url === '/login') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(form('')); return; }
    if (!cookie.includes('sid=ok')) { res.writeHead(302, { location: '/login' }); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<html><body><h1>模拟商家后台</h1><nav>订单管理 商品管理 店铺管理</nav><p>可提现余额 ¥1,234.56</p></body></html>');
  });
  function form(msg) { return `<html><body><h2>商家登录</h2><p>${msg}</p><form method="post" action="/login"><input name="account" placeholder="请输入账号"><input type="password" name="password" placeholder="请输入密码"><button type="submit">登录</button></form></body></html>`; }
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, stats, url: `http://127.0.0.1:${srv.address().port}/` })));
}

async function partA(plat) {
  console.log('A. 真实 OA 接口 + 假平台');
  const { runAgent } = require('../dist/main');
  const { registerWithCode } = require('../dist/api');
  const { saveConfig, loadConfig } = require('../dist/config');
  const call = async (p, body, method = 'POST', h) => { const r = await fetch(API + '/api' + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }); const t = await r.text(); if (!r.ok) throw new Error(p + ' ' + r.status + ' ' + t); return t ? JSON.parse(t) : {}; };
  const lg = await call('/auth/login', { companyCode: 'demo', account: 'admin', password: 'Admin-Test-2026!' }, 'POST', { 'content-type': 'application/json' });
  const H = { authorization: 'Bearer ' + lg.accessToken, 'content-type': 'application/json' };
  const sfx = String(Date.now() % 100000);
  const store = await call('/resources/stores', { values: { platform: 'pdd', name: '助手测试店' + sfx } }, 'POST', H);
  const { code } = await call('/session/bind-codes', {}, 'POST', H);
  const reg = await registerWithCode(API, { code, name: '测试电脑' + sfx, os: 'e2e', agentVersion: '1.0.0' });
  ok(reg.token && reg.token.length === 64, '绑定码换到设备令牌');
  await saveConfig({ serverUrl: API, deviceId: reg.deviceId, deviceNo: reg.deviceNo, deviceToken: reg.token, name: '测试电脑' + sfx, profiles: {} });
  const ctl = new AbortController();
  const running = runAgent(await loadConfig(), { stopSignal: ctl.signal, heartbeatMs: 1000, pollMs: 500, loginTimeoutMs: 60000 });
  const dev = async () => (await call('/session/devices', undefined, 'GET', H)).find((d) => d.id === reg.deviceId);
  await until(async () => (await dev())?.online, 15000, '助手上线');
  ok(true, 'OA 看到助手在线');
  await call('/session/shops', { storeIds: [store.id], deviceId: reg.deviceId }, 'POST', H);
  const shop = async () => (await call('/session/overview', undefined, 'GET', H)).shops.find((s) => s.storeId === store.id);
  // 密码错：自动登录被拒绝，报失败且不泄露密码
  await call(`/session/shops/${(await shop()).id}`, { loginAccount: 'shop1', loginPassword: 'wrong-pass', autoLogin: true }, 'POST', H);
  let r1 = await call(`/session/shops/${(await shop()).id}/open`, {}, 'POST', H);
  const hist = async () => (await call(`/session/shops/${(await shop()).id}/history`, undefined, 'GET', H))[0];
  await until(async () => ['failed', 'succeeded'].includes((await hist()).status), 40000, '错误密码的请求结束');
  let h = await hist();
  ok(h.status === 'failed' && /密码/.test(h.errorText) && !JSON.stringify(h).includes('wrong-pass'), `错误密码：失败且提示“${h.errorText}”，文字里没有密码`);
  ok((await shop()).loginState === 'error', '店铺状态为 登录异常');
  // 正确密码：自动登录成功
  await call(`/session/shops/${(await shop()).id}`, { loginPassword: 'pw-123456' }, 'POST', H);
  await call(`/session/shops/${(await shop()).id}/open`, {}, 'POST', H);
  await until(async () => (await hist()).status === 'succeeded', 40000, '自动登录成功');
  ok((await shop()).loginState === 'valid' && plat.stats.logins === 1, '自动登录成功，店铺状态为 登录有效（平台收到 1 次登录）');
  // 第二次：本机登录态还在，不再提交密码
  await call(`/session/shops/${(await shop()).id}/open`, {}, 'POST', H);
  await until(async () => { const x = await call(`/session/shops/${(await shop()).id}/history`, undefined, 'GET', H); return x.filter((y) => y.status === 'succeeded').length === 2; }, 40000, '第二次打开');
  ok(plat.stats.logins === 1, '第二次打开复用本机登录态，平台没有再收到登录');
  ctl.abort(); await running; ok(true, '助手可以正常停止');
  const d2 = await dev(); ok(d2.name.startsWith('测试电脑'), '设备仍在 OA 中');
}

async function partB(plat) {
  console.log('B. 截图（迷你 OA 桩）');
  const got = { uploads: [], reports: [] };
  let handedOut = 0;
  const reqs = [
    { id: 1, kind: 'first', store: { id: 77, name: '桩店铺', platform: 'pdd', url: '' }, credentials: { account: 'shop1', password: 'pw-123456' } },
    { id: 2, kind: 'capture', store: { id: 77, name: '桩店铺', platform: 'pdd', url: '' }, credentials: null },
    { id: 3, kind: 'capture', store: { id: 88, name: '另一家', platform: 'pdd', url: '' }, credentials: null },
  ];
  const stub = http.createServer((req, res) => {
    const json = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.headers['x-device-token'] !== 't'.repeat(64)) return json({ message: '设备未授权' }, 401);
    const chunks = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => {
      const body = Buffer.concat(chunks);
      if (req.url === '/api/agent/heartbeat') return json({ ok: true, pending: 0 });
      if (req.url === '/api/agent/claim') return json({ request: reqs[handedOut] && got.reports.length + got.uploads.length >= handedOut ? reqs[handedOut++] : null });
      const m = req.url.match(/^\/api\/agent\/requests\/(\d+)\/(report|upload)$/);
      if (m && m[2] === 'report') { got.reports.push({ id: +m[1], ...JSON.parse(body.toString()) }); return json({ ok: true }); }
      if (m && m[2] === 'upload') { got.uploads.push({ id: +m[1], size: body.length, isMultipart: /multipart\/form-data/.test(req.headers['content-type'] || ''), hasPng: body.includes(Buffer.from([0x89, 0x50, 0x4e, 0x47])), field: /name="file"/.test(body.toString('latin1')) }); return json({ ok: true, fileId: 1 }); }
      json({ message: 'not found' }, 404);
    });
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${stub.address().port}`;
  const { runAgent } = require('../dist/main');
  const ctl = new AbortController();
  const done = runAgent({ serverUrl: base, deviceId: 1, deviceNo: 'N', deviceToken: 't'.repeat(64), name: '桩', profiles: {} }, { stopSignal: ctl.signal, heartbeatMs: 500, pollMs: 300, loginTimeoutMs: 20000 });
  await until(() => got.reports.length >= 3 || (got.reports.length >= 2 && got.uploads.length >= 1), 60000, '桩收到全部回报');
  ctl.abort(); await done; stub.close();
  ok(got.reports.find((r) => r.id === 1)?.status === 'succeeded', '店铺窗口打开并登录成功后回报 succeeded');
  const up = got.uploads.find((u) => u.id === 2);
  ok(up && up.isMultipart && up.field && up.hasPng && up.size > 2000, `截图以 multipart 上传，是 PNG，${up?.size} 字节`);
  const bad = got.reports.find((r) => r.id === 3);
  ok(bad?.status === 'failed' && bad.errorCode === 'no_window' && /没有打开/.test(bad.errorText), `没打开窗口的店铺截图被拒绝：${bad?.errorText}`);
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kagent-e2e-'));
  process.env.KUDESI_AGENT_DATA_DIR = dir;
  process.env.KUDESI_AGENT_HEADLESS = '1';
  const plat = await fakePlatform();
  process.env.KUDESI_AGENT_TEST_URL = plat.url;
  try {
    if (process.env.SKIP_REAL_OA !== '1') await partA(plat);
    await partB(plat);
    console.log('全部通过');
  } finally { plat.srv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
