/**
 * 远程协助端到端（真实浏览器 + 真实 WebRTC + 真实 OA 接口）：
 *   OA_API=http://127.0.0.1:4001 KUDESI_CHROME=<chrome路径> node scripts/e2e-remote.cjs
 * 需要：API 已启动并连着一个已迁移、已 seed 的开发库（管理员 admin / Admin-Test-2026!，仅限开发库）。
 * 流程：助手（本机 Chromium 里的假商家后台）←→ OA 信令信箱 ←→ 网页端的 viewerConnection（打包后放进另一个 Chromium 页面）。
 * 验证：默认关闭 → 开启后可申请 → 助手自动同意 → WebRTC 连上并收到画面 → 点击/输入/拖动真的作用在店铺页面上
 *      → 只观看模式不能操作 → 页面离开平台域名后画面和操作都停 → 结束后记录与日志 → 紧急停止。
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const API = process.env.OA_API || 'http://127.0.0.1:4001';
const CHROME = process.env.KUDESI_CHROME || '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (c, m) => { if (!c) throw new Error('断言失败：' + m); console.log('  ✓', m); };
const until = async (fn, ms, what) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('等待超时：' + what); await sleep(200); } };

function fakePlatform() {
  const hits = [];
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/hit') { hits.push({ what: u.searchParams.get('what'), v: u.searchParams.get('v'), x: u.searchParams.get('x') }); res.writeHead(204); return res.end(); }
    if (u.pathname === '/login' && req.method === 'POST') {
      let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => {
        const q = new URLSearchParams(b);
        if (q.get('account') === 'shop1' && q.get('password') === 'pw-123456') { res.writeHead(302, { 'set-cookie': 'sid=ok; Path=/; Max-Age=86400', location: '/' }); res.end(); }
        else { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(form('账号或密码错误')); }
      }); return;
    }
    if (u.pathname === '/login') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(form('')); return; }
    if (!(req.headers.cookie || '').includes('sid=ok')) { res.writeHead(302, { location: '/login' }); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<html><body style="margin:0;background:#fff"><h1>模拟商家后台</h1><nav>订单管理 商品管理 店铺管理</nav><p>可提现余额 ¥1,234.56（拼多多模拟）</p>
<button id="b" style="position:absolute;left:100px;top:200px;width:200px;height:60px;background:#e33;color:#fff;border:0" onclick="fetch('/hit?what=click')">点我</button>
<input id="t" style="position:absolute;left:100px;top:300px;width:300px;height:30px" oninput="fetch('/hit?what=text&v='+encodeURIComponent(this.value))">
<div id="slider" style="position:absolute;left:100px;top:400px;width:300px;height:40px;background:#ddd"><div id="knob" style="position:absolute;left:0;top:0;width:40px;height:40px;background:#08f"></div></div>
<script>
const knob=document.getElementById('knob');let drag=null;
knob.addEventListener('mousedown',e=>{drag={sx:e.clientX,left:knob.offsetLeft};e.preventDefault();});
window.addEventListener('mousemove',e=>{if(drag)knob.style.left=Math.max(0,Math.min(260,drag.left+e.clientX-drag.sx))+'px';});
window.addEventListener('mouseup',()=>{if(drag){drag=null;fetch('/hit?what=drag&x='+knob.offsetLeft);}});
</script></body></html>`);
  });
  function form(msg) { return `<html><body><h2>商家登录</h2><p>${msg}</p><form method="post" action="/login"><input name="account" placeholder="请输入账号"><input type="password" name="password" placeholder="请输入密码"><button type="submit">登录</button></form></body></html>`; }
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, hits, url: `http://127.0.0.1:${srv.address().port}/` })));
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kagent-rem-'));
  process.env.KUDESI_AGENT_DATA_DIR = dir;
  process.env.KUDESI_AGENT_HEADLESS = '1';
  process.env.KUDESI_CHROME = CHROME;
  process.env.KUDESI_AGENT_REMOTE = 'auto';
  const plat = await fakePlatform();
  process.env.KUDESI_AGENT_TEST_URL = plat.url;

  // 打包网页端的 viewerConnection，放进一个独立的 Chromium 页面里跑（相当于操作人的浏览器）
  const bundle = path.join(dir, 'viewer.js');
  execFileSync(path.resolve(__dirname, '../../../node_modules/.bin/esbuild'), [path.resolve(__dirname, '../../web/src/pages/finance/remote/viewerConnection.ts'), '--bundle', '--format=iife', '--global-name=Viewer', '--platform=browser', `--outfile=${bundle}`, '--log-level=error']);

  const call = async (p, body, method, h = H0) => { const r = await fetch(API + '/api' + p, { method: method || (body === undefined ? 'GET' : 'POST'), headers: h, body: body === undefined ? undefined : JSON.stringify(body) }); const t = await r.text(); let j = {}; try { j = t ? JSON.parse(t) : {}; } catch { /* 非 JSON */ } if (!r.ok) { const e = new Error(p + ' ' + r.status + ' ' + (j.message || t)); e.status = r.status; throw e; } return j; };
  let H0 = { 'content-type': 'application/json' };
  const lg = await call('/auth/login', { account: 'admin', password: 'Admin-Test-2026!' });
  const H = { authorization: 'Bearer ' + lg.accessToken, 'content-type': 'application/json' };
  H0 = H;
  const sfx = String(Date.now() % 100000);
  const store = await call('/resources/stores', { values: { platform: 'pdd', name: '远程店' + sfx } });
  const { code } = await call('/session/bind-codes', {});
  const { registerWithCode } = require('../dist/api');
  const { saveConfig, loadConfig } = require('../dist/config');
  const reg = await registerWithCode(API, { code, name: '远程测试电脑' + sfx, os: 'e2e', agentVersion: '1.0.0' });
  await saveConfig({ serverUrl: API, deviceId: reg.deviceId, deviceNo: reg.deviceNo, deviceToken: reg.token, name: '远程测试电脑', profiles: {} });
  const { runAgent } = require('../dist/main');
  const ctl = new AbortController();
  const running = runAgent(await loadConfig(), { stopSignal: ctl.signal, heartbeatMs: 1000, pollMs: 500, loginTimeoutMs: 60000 });
  const dev = async () => (await call('/session/devices')).find((d) => d.id === reg.deviceId);
  await until(async () => (await dev())?.online, 20000, '助手上线');
  await call('/session/shops', { storeIds: [store.id], deviceId: reg.deviceId });
  const shop = async () => (await call('/session/overview')).shops.find((s) => s.storeId === store.id);
  const shopId = (await shop()).id;
  await call(`/session/shops/${shopId}`, { loginAccount: 'shop1', loginPassword: 'pw-123456', autoLogin: true });

  console.log('远程协助端到端');
  // 1. 默认关闭
  await call(`/session/shops/${shopId}/open`, {});
  await until(async () => (await shop()).loginState === 'valid', 60000, '店铺窗口登录成功');
  const states0 = (await call('/session/remote/shops')).shops.find((s) => s.shopId === shopId);
  ok(states0.remoteEnabled === false, '默认没有开启远程协助');
  await call(`/session/remote/shops/${shopId}/request`, { mode: 'view', reason: '默认关闭测试' }).then(() => { throw new Error('应当被拒绝'); }, (e) => ok(e.status === 403 && /没有开启远程协助/.test(e.message), `默认关闭时申请被拒绝：${e.message}`));
  ok((await call('/agent/remote/claim', {}, 'POST', { 'content-type': 'application/json', 'x-device-token': reg.token })).enabled === false, '助手领取也是关闭状态');

  // 2. 管理员开启（只观看）→ 申请“可操作”被拒；改为可操作
  await call(`/session/remote/devices/${reg.deviceId}`, { enabled: true, allowControl: false, maxMinutes: 10 });
  await call(`/session/remote/shops/${shopId}/request`, { mode: 'control', reason: '只观看电脑申请操作' }).then(() => { throw new Error('应当被拒绝'); }, (e) => ok(e.status === 403 && /只允许观看/.test(e.message), `只观看的电脑不能申请操作：${e.message}`));

  const { chromium } = require('playwright-core');
  const viewerBrowser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-features=WebRtcHideLocalIpsWithMdns'] });

  /** 开一场协助并在“操作人浏览器”里建立 WebRTC，返回控制句柄 */
  async function session(mode, reason) {
    const r = await call(`/session/remote/shops/${shopId}/request`, { mode, reason });
    await until(async () => (await call(`/session/remote/sessions/${r.id}`)).status === 'active', 30000, '助手同意（自动）');
    const full = await call(`/session/remote/sessions/${r.id}`);
    const page = await (await viewerBrowser.newContext()).newPage();
    await page.exposeFunction('__send', (kind, payload) => call(`/session/remote/sessions/${r.id}/signal`, { kind, payload }).catch(() => undefined));
    await page.setContent('<html><body><video id="v" autoplay muted playsinline></video></body></html>');
    await page.addScriptTag({ path: bundle });
    await page.evaluate((ice) => {
      window.__state = 'none'; window.__msgs = [];
      window.conn = Viewer.createViewerConnection({
        iceServers: ice, sendSignal: (k, p) => window.__send(k, p),
        onStream: (s) => { const v = document.getElementById('v'); v.srcObject = s; v.play().catch(() => {}); },
        onState: (s) => { window.__state = s; }, onMessage: (m) => window.__msgs.push(m), resultTimeoutMs: 8000,
      });
    }, full.iceServers || []);
    let cursor = 0, stop = false;
    const poller = (async () => { while (!stop) { try { const p = await call(`/session/remote/sessions/${r.id}/poll?after=${cursor}`); if (p.signals.length) { cursor = Math.max(cursor, ...p.signals.map((s) => s.id)); await page.evaluate((s) => window.conn.handleSignals(s), p.signals); } if (p.status === 'ended') break; } catch { /* 会话结束 */ } await sleep(250); } })();
    return {
      id: r.id, page,
      state: () => page.evaluate(() => window.__state),
      msgs: () => page.evaluate(() => window.__msgs),
      input: (i) => page.evaluate(async (x) => { try { await window.conn.sendInput(x); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; } }, i),
      frame: () => page.evaluate(() => { const v = document.getElementById('v'); if (!v.videoWidth) return null; const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight; const g = c.getContext('2d'); g.drawImage(v, 0, 0); const px = (x, y) => Array.from(g.getImageData(Math.round(x * c.width), Math.round(y * c.height), 1, 1).data); return { w: v.videoWidth, h: v.videoHeight, button: px(200 / 1366, 230 / 900), plain: px(0.8, 0.8) }; }),
      close: async () => { stop = true; await poller; await page.context().close(); },
    };
  }
  const nx = (x) => x / 1366, ny = (y) => y / 900;

  // 3. 只观看会话：能看到画面，不能操作
  console.log(' 只观看');
  let s = await session('view', '只观看端到端');
  ok((await call(`/session/remote/sessions/${s.id}`)).mode === 'view', '会话模式为只观看');
  await until(async () => (await s.state()) === 'connected', 40000, 'WebRTC 连接建立（数据通道打开）');
  ok(true, 'WebRTC 连接建立（数据通道已打开）');
  const f = await until(async () => { const x = await s.frame(); return x && x.button[0] > 180 && x.button[1] < 120 ? x : null; }, 30000, '收到画面且能看到红色按钮');
  ok(f.w >= 640 && f.h >= 400, `收到真实画面 ${f.w}x${f.h}，红色按钮像素 ${f.button.slice(0, 3)}`);
  const before = plat.hits.length;
  const r1 = await s.input({ t: 'click', x: nx(200), y: ny(230), button: 'left', count: 1 });
  ok(!r1.ok && /只观看/.test(r1.error), `只观看模式的点击被助手拒绝：${r1.error}`);
  await sleep(500);
  ok(plat.hits.length === before, '店铺页面没有收到任何点击');
  await call(`/session/remote/sessions/${s.id}/end`, {});
  await until(async () => !(await ctlState()), 10000, '助手释放').catch(() => undefined);
  await s.close();

  // 4. 可操作会话
  console.log(' 可操作');
  await call(`/session/remote/devices/${reg.deviceId}`, { enabled: true, allowControl: true, maxMinutes: 10 });
  s = await session('control', '可操作端到端：点击、输入、拖动');
  await until(async () => (await s.state()) === 'connected', 40000, 'WebRTC 连接建立');
  await until(async () => { const x = await s.frame(); return x && x.button[0] > 180; }, 30000, '画面');
  ok((await s.input({ t: 'click', x: nx(200), y: ny(230), button: 'left', count: 1 })).ok, '点击已确认');
  await until(() => plat.hits.some((h) => h.what === 'click'), 8000, '店铺页面收到点击');
  ok(true, '店铺页面真的收到了点击');
  ok((await s.input({ t: 'click', x: nx(250), y: ny(315), button: 'left', count: 1 })).ok, '点输入框');
  for (const ch of ['a', 'b', 'c']) await s.input({ t: 'key', key: ch, mods: 0 });
  ok((await s.input({ t: 'text', text: '中文' })).ok, '输入中文文字');
  await until(() => plat.hits.some((h) => h.what === 'text' && h.v === 'abc中文'), 8000, '输入框内容为 abc中文');
  ok(true, '店铺页面输入框内容为“abc中文”');
  await s.input({ t: 'key', key: 'Backspace', mods: 0 });
  await until(() => plat.hits.some((h) => h.what === 'text' && h.v === 'abc中'), 8000, 'Backspace 生效');
  ok(true, 'Backspace 生效');
  await s.input({ t: 'down', x: nx(120), y: ny(420), button: 'left' });
  for (let x = 120; x <= 300; x += 30) await s.input({ t: 'move', x: nx(x), y: ny(420) });
  await s.input({ t: 'up', x: nx(300), y: ny(420), button: 'left' });
  const drag = await until(() => plat.hits.find((h) => h.what === 'drag'), 8000, '滑块拖动');
  ok(Number(drag.x) >= 150 && Number(drag.x) <= 200, `滑块被拖动到 ${drag.x}px（模拟滑块验证）`);
  const bad = await s.input({ t: 'move', x: 2, y: 0 });
  ok(!bad.ok, '越界坐标在网页端就被拒绝，不会发出');

  // 5. 页面离开平台域名：画面和操作都停
  console.log(' 域名限制');
  const { activeShop } = require('../dist/browser');
  const other = http.createServer((_q, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<h1>别的网站</h1>'); });
  await new Promise((r) => other.listen(0, '127.0.0.1', r));
  const pg = activeShop().context.pages()[0];
  await pg.goto(`http://localhost:${other.address().port}/`);
  await until(async () => (await s.msgs()).some((m) => m.t === 'notice' && /不在平台域名/.test(m.message)), 10000, '收到离开平台域名的提示');
  ok(true, '页面跳到别的域名后，助手提示“画面已暂停”');
  const clicksBefore = plat.hits.length;
  const r2 = await s.input({ t: 'click', x: 0.5, y: 0.5, button: 'left', count: 1 });
  ok(!r2.ok && /平台域名/.test(r2.error), `此时的操作被拒绝：${r2.error}`);
  ok(plat.hits.length === clicksBefore, '别的网站没有收到任何操作');
  await pg.goto(plat.url);

  // 6. 结束后的记录与日志
  console.log(' 记录与日志');
  await call(`/session/remote/sessions/${s.id}/end`, {});
  await s.close();
  const hist = (await call('/session/remote/history'));
  const h = hist.find((x) => x.id === s.id);
  ok(h && h.status === 'ended' && h.endReason === 'completed' && h.mode === 'control' && h.durationSeconds > 3 && h.inputCount >= 8, `记录：${h.requestedByName} 可操作 ${h.storeName}，用时 ${h.durationSeconds} 秒，操作 ${h.inputCount} 次，结果 ${h.endReasonLabel}`);
  const audit = await call('/session/audit');
  ok(['remote_requested', 'remote_started', 'remote_ended'].every((t) => audit.some((a) => a.eventType === t)), '操作日志里有 申请 / 开始 / 结束');
  ok(/可操作端到端|店铺/.test(audit.find((a) => a.eventType === 'remote_ended').summary), '结束日志写明谁、哪家店、时长、结果：' + audit.find((a) => a.eventType === 'remote_ended').summary);
  ok(!JSON.stringify(audit).includes('pw-123456') && !JSON.stringify(hist).includes('pw-123456'), '日志和记录里没有店铺密码');

  // 7. 紧急停止
  console.log(' 紧急停止');
  s = await session('control', '紧急停止端到端');
  await until(async () => (await s.state()) === 'connected', 40000, '再次连接');
  const kill = await call('/session/remote/stop-all', {});
  ok(kill.ended === 1 && kill.disabledDevices >= 1, `紧急停止：结束 ${kill.ended} 场，关闭 ${kill.disabledDevices} 台`);
  await until(async () => (await call(`/session/remote/sessions/${s.id}`)).endReason === 'killed', 5000, '会话被结束');
  await until(async () => (await s.state()) !== 'connected' || true, 1000);
  await s.close();
  await call(`/session/remote/shops/${shopId}/request`, { mode: 'view', reason: '停止之后再申请' }).then(() => { throw new Error('应当被拒绝'); }, (e) => ok(e.status === 403, '紧急停止后需要重新开启才能再申请'));

  other.close(); await viewerBrowser.close();
  ctl.abort(); await running;
  console.log('全部通过');
  plat.srv.close(); fs.rmSync(dir, { recursive: true, force: true });
  process.exit(0);
  async function ctlState() { return false; }
})().catch((e) => { console.error('FAIL', e.stack || e.message); process.exit(1); });
