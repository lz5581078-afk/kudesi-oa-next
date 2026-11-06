'use strict';
const FEISHU_ORIGINS = new Set([
  'https://accounts.feishu.cn',
  'https://open.feishu.cn',
  'https://passport.feishu.cn',
  'https://login.feishu.cn',
]);
const JST_HOSTS = new Set(['erp321.com', 'www.erp321.com', 'innerorder.scm121.com', 'help.scm121.com', 'www.jushuitan.com', 'jushuitan.com', 'openweb.jushuitan.com']);
const {launch} = require('../build/navigation.json');
function isAfterSalesLaunch(value) {
  if (typeof value !== 'string') return false;
  const normalized = value.toLowerCase();
  return normalized === launch || normalized === launch + '/';
}
function allowedJst(url, {subframe=false} = {}) {
  try { const u = new URL(url); return u.protocol === 'https:' && !u.username && !u.password && (!u.port || u.port === '443') && (JST_HOSTS.has(u.hostname) || (subframe && u.hostname === 'src.erp321.com')); } catch { return false; }
}
function oaOrigin(value, packaged) {
  const u = new URL(value);
  if (u.username || u.password || (packaged ? u.origin !== 'https://lc.kudesi.com' : !['https://lc.kudesi.com', 'http://localhost:5173', 'http://127.0.0.1:5173', 'http://127.0.0.1:5186'].includes(u.origin))) throw new Error('不支持的 OA 地址');
  return u.origin;
}
function allowedOaNavigation(url, origin) {
  try {
    const u = new URL(url);
    return !u.username && !u.password && (u.origin === origin || FEISHU_ORIGINS.has(u.origin));
  } catch { return false; }
}
function feishuClientLink(value, oaOrigin) {
  const url = new URL(value);
  const callback = new URL(url.searchParams.get('redirect_uri') ?? '');
  const state = url.searchParams.get('state') ?? '';
  const appId = url.searchParams.get('client_id') ?? '';
  if (url.origin !== 'https://accounts.feishu.cn' || url.pathname !== '/open-apis/authen/v1/authorize' ||
    url.username || url.password || url.hash || callback.href !== oaOrigin + '/login' ||
    !/^desktop\.[A-Za-z0-9_-]{43}$/.test(state) || !/^cli_[A-Za-z0-9]+$/.test(appId)) {
    throw new Error('飞书桌面授权链接无效');
  }
  const authorize = new URL(url.origin + url.pathname);
  authorize.search = new URLSearchParams({ client_id: appId, response_type: 'code', redirect_uri: callback.href, state }).toString();
  const link = new URL('feishu://applink.feishu.cn/client/web_url/open');
  link.search = new URLSearchParams({ mode: 'window', url: authorize.href }).toString();
  return link.href;
}
function trustedSender(event, win, origin) {
  return !!win && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame && new URL(event.senderFrame.url).origin === origin;
}
function boundsOf(value, size) {
  if (!value || !['x','y','width','height'].every(k => Number.isFinite(value[k]))) throw new Error('无效的页面区域');
  const x = Math.max(0, Math.min(size[0], Math.round(value.x))), y = Math.max(0, Math.min(size[1], Math.round(value.y)));
  return { x, y, width: Math.max(0, Math.min(size[0]-x, Math.round(value.width))), height: Math.max(0, Math.min(size[1]-y, Math.round(value.height))) };
}
function pngBytes(value) {
  if (typeof value !== 'string' || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(value) || value.length > 14*1024*1024) throw new Error('截图超出限制');
  const b = Buffer.from(value.split(',')[1], 'base64');
  if (!b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || b.length > 10*1024*1024) throw new Error('截图格式无效');
  return b;
}
function replaceShortcut(shortcuts, previous, value, callback) {
  if(typeof value!=='string' || value.length>80 || !/^(CommandOrControl|Control|Command|Alt|Shift)[A-Za-z0-9+]*$/.test(value))return false;
  if(value===previous&&shortcuts.isRegistered(value))return true;
  try {if(!shortcuts.register(value,callback))return false;}catch{return false;}
  if(typeof previous==='string'&&value!==previous)shortcuts.unregister(previous);
  return true;
}
module.exports = { allowedJst, oaOrigin, allowedOaNavigation, feishuClientLink, isAfterSalesLaunch, trustedSender, boundsOf, pngBytes, replaceShortcut };
