'use strict';
const JST_HOSTS = new Set(['erp321.com', 'www.erp321.com', 'innerorder.scm121.com', 'www.jushuitan.com', 'jushuitan.com', 'openweb.jushuitan.com']);
function allowedJst(url) {
  try { const u = new URL(url); return u.protocol === 'https:' && !u.username && !u.password && (!u.port || u.port === '443') && JST_HOSTS.has(u.hostname); } catch { return false; }
}
function oaOrigin(value, packaged) {
  const u = new URL(value);
  if (u.username || u.password || (packaged ? u.origin !== 'https://lc.kudesi.com' : !['https://lc.kudesi.com', 'http://localhost:5173', 'http://127.0.0.1:5173', 'http://127.0.0.1:5186'].includes(u.origin))) throw new Error('不支持的 OA 地址');
  return u.origin;
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
module.exports = { allowedJst, oaOrigin, trustedSender, boundsOf, pngBytes, replaceShortcut };
