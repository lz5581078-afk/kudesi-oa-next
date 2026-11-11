'use strict';

// Evaluated in the allowlisted ERP top-level document. Never read field values,
// cookies, storage, or the signed-in user's account name.
function inspectJushuitanSession() {
  const visible = element => !!element?.getClientRects().length &&
    getComputedStyle(element).visibility !== 'hidden' && !element.closest('[hidden],[aria-hidden="true"]');
  const text = element => (element?.innerText || '').trim();
  const body = text(document.body);
  const loginRoute = /(?:^|[\/#.])(login|signin|sign-in|passport)(?:$|[\/?#.])/i.test(location.pathname + location.hash);
  const loginPrompt = /(?:^|\n)\s*(?:账号登录|帐号登录|扫码登录|密码登录|手机验证码登录|请重新登录|登录已过期|登录已失效|会话已过期)\s*(?:$|\n|[：:。])/m;
  const expired = [...document.querySelectorAll('[role="alert"],.ant-modal-body,.ant-message-error,.ant-alert-error')]
    .some(element => visible(element) && /请重新登录|登录(?:状态|信息|凭证)?(?:已)?(?:失效|过期)/.test(text(element)));
  const password = [...document.querySelectorAll('input[type="password"]')].some(visible);
  if (loginRoute || expired || loginPrompt.test(body) || (password && /登录|登入/.test(body))) {
    return {state:'login_required'};
  }
  if (!/^\/epaas(?:\/|$)/i.test(location.pathname) || !document.body) return {state:'unavailable'};
  const company = body.split('\n').map(line => line.trim())
    .find(line => /^[^\[\]\r\n]{1,80}\s*\[[^\[\]\r\n]{1,80}\]$/.test(line))
    ?.match(/^([^\[\]]{1,80})\s*\[/)?.[1]?.trim();
  const shell = !!document.querySelector('[class*="groupItemWrap"], .ant-menu, [role="menu"]') ||
    /售后[（(]极速版[）)]|退出登录|用户中心|切换公司|工作台/.test(body);
  return company && shell ? {state:'authenticated',sourceCompany:company} : {state:'checking'};
}

module.exports = {inspectJushuitanSession};
