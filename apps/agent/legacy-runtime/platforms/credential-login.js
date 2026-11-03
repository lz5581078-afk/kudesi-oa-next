const ACCOUNT_SELECTORS = Object.freeze([
  'input[autocomplete="username"]',
  'input[name="username"]',
  'input[name="account"]',
  'input[name="mobile"]',
  'input[type="tel"]',
  'input[placeholder*="账号"]',
  'input[placeholder*="用户名"]',
  'input[placeholder*="手机号"]'
]);

const PASSWORD_SELECTORS = Object.freeze([
  'input[autocomplete="current-password"]',
  'input[name="password"]',
  'input[type="password"]',
  'input[placeholder*="密码"]'
]);

const SUBMIT_SELECTORS = Object.freeze([
  'button[type="submit"]',
  'input[type="submit"]',
  'button:has-text("登录")',
  '[role="button"]:has-text("登录")'
]);

const PASSWORD_MODE_SELECTORS = Object.freeze([
  'text=账号登录',
  'text=密码登录',
  'text=账号密码登录',
  '[role="tab"]:has-text("账号登录")',
  '[role="tab"]:has-text("密码登录")',
  '[role="tab"]:has-text("账号密码登录")'
]);

const PLATFORM_LOGIN_CONFIGS = Object.freeze({
  pdd: Object.freeze({}),
  taobao: Object.freeze({
    accountSelectors: Object.freeze(['#fm-login-id', 'input[name="fm-login-id"]']),
    passwordSelectors: Object.freeze(['#fm-login-password', 'input[name="fm-login-password"]']),
    submitSelectors: Object.freeze(['button.fm-button', '.fm-button', '.password-login button[type="submit"]']),
    passwordModeSelectors: Object.freeze(['.password-login-tab-item', '.password-login-link'])
  }),
  douyin: Object.freeze({
    accountSelectors: Object.freeze(['input[placeholder*="邮箱"]', 'input[type="email"]', 'input[placeholder*="手机号"]']),
    passwordSelectors: Object.freeze(['input[placeholder*="登录密码"]']),
    submitSelectors: Object.freeze(['button:has-text("立即登录")']),
    passwordModeSelectors: Object.freeze(['text=邮箱登录', 'text=账号密码登录'])
  }),
  kuaishou: Object.freeze({
    accountSelectors: Object.freeze(['input[placeholder="请输入手机号"]']),
    passwordSelectors: Object.freeze(['input[placeholder="请输入密码"]']),
    submitSelectors: Object.freeze(['button:has-text("登录")']),
    passwordModeSelectors: Object.freeze(['text=账号登录'])
  }),
  jd: Object.freeze({
    accountSelectors: Object.freeze([
      'input[placeholder="请输入京东账号"]',
      'input[placeholder="请输入账号名/邮箱"]',
      '#loginname'
    ]),
    passwordSelectors: Object.freeze(['input[placeholder="请输入登录密码"]', '#nloginpwd']),
    submitSelectors: Object.freeze(['button:has-text("立即登录")', '#loginsubmit']),
    passwordModeSelectors: Object.freeze(['text=密码登录', '[role="tab"]:has-text("密码登录")'])
  })
});

const VERIFICATION_PATTERN = /短信验证码|图形验证码|手机验证|安全验证|安全校验|身份验证|滑块|拖动滑块|请进行验证|请完成验证|请完成安全验证|风险验证|异地登录/;
const LOGIN_ERROR_PATTERN = /账号或密码错误|账号密码错误|手机号或密码错误|账号名或密码不正确|账号名或登录密码不正确|用户名或密码不正确|账户名与密码不匹配|密码错误|账号不存在|用户不存在|登录失败|登录异常/;
const LOGIN_FORM_TIMEOUT_MS = 10_000;
const LOGIN_RESULT_TIMEOUT_MS = 15_000;
const LOGIN_POLL_INTERVAL_MS = 250;

function uniqueSelectors(...groups) {
  return [...new Set(groups.flat().filter(Boolean))];
}

function loginConfig(platformCode) {
  const platform = PLATFORM_LOGIN_CONFIGS[String(platformCode || '')] || {};
  return {
    accountSelectors: uniqueSelectors(platform.accountSelectors || [], ACCOUNT_SELECTORS),
    passwordSelectors: uniqueSelectors(platform.passwordSelectors || [], PASSWORD_SELECTORS),
    submitSelectors: uniqueSelectors(platform.submitSelectors || [], SUBMIT_SELECTORS),
    passwordModeSelectors: uniqueSelectors(platform.passwordModeSelectors || [], PASSWORD_MODE_SELECTORS)
  };
}

function locatorScopes(page) {
  const frames = typeof page?.frames === 'function' ? page.frames() : [];
  return [page, ...frames].filter((scope, index, all) => scope?.locator && all.indexOf(scope) === index);
}

async function firstVisible(page, selectors) {
  for (const selector of selectors) {
    for (const scope of locatorScopes(page)) {
      const locator = scope.locator(selector).first();
      if (await locator.isVisible().catch(() => false)) return locator;
    }
  }
  return null;
}

async function waitForFirstVisible(page, selectors, timeoutMs, pollIntervalMs = LOGIN_POLL_INTERVAL_MS) {
  const attempts = Math.max(1, Math.ceil(timeoutMs / pollIntervalMs));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const locator = await firstVisible(page, selectors);
    if (locator) return locator;
    if (attempt + 1 < attempts) await page.waitForTimeout(pollIntervalMs);
  }
  return null;
}

async function waitForCredentialInputs(page, config, timeoutMs, pollIntervalMs = LOGIN_POLL_INTERVAL_MS) {
  const attempts = Math.max(1, Math.ceil(timeoutMs / pollIntervalMs));
  let passwordModeAttempted = false;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!passwordModeAttempted) {
      const passwordMode = await firstVisible(page, config.passwordModeSelectors);
      if (passwordMode) {
        passwordModeAttempted = true;
        await passwordMode.click().catch(() => undefined);
      }
    }
    const [accountInput, passwordInput] = await Promise.all([
      firstVisible(page, config.accountSelectors),
      firstVisible(page, config.passwordSelectors)
    ]);
    if (accountInput && passwordInput) return { accountInput, passwordInput };
    if (attempt + 1 < attempts) await page.waitForTimeout(pollIntervalMs);
  }
  return null;
}

async function pageAndFrameText(page) {
  const values = await Promise.all(locatorScopes(page).map((scope) => (
    scope.locator('body').innerText({ timeout: 1_000 }).catch(() => '')
  )));
  return values.filter(Boolean).join('\n');
}

function verificationMessage(body, boundPhones = '') {
  if (!VERIFICATION_PATTERN.test(String(body || ''))) return '';
  const phoneHint = String(boundPhones || '').trim();
  return phoneHint
    ? `平台要求手机或安全验证，请由有权人员在远程窗口完成（店铺绑定手机：${phoneHint}）`
    : '平台要求手机或安全验证，请由有权人员在远程窗口完成';
}

async function loginWithCredentials({
  context,
  page,
  credentials,
  findAuthenticatedPage,
  platformCode = '',
  formTimeoutMs = LOGIN_FORM_TIMEOUT_MS,
  resultTimeoutMs = LOGIN_RESULT_TIMEOUT_MS,
  pollIntervalMs = LOGIN_POLL_INTERVAL_MS
}) {
  const account = String(credentials?.account || '').trim();
  const password = String(credentials?.password || '');
  if (!account || !password) {
    return { status: 'manual_required', message: '提现店铺列表未完整维护运营账号和密码，请人工登录' };
  }

  const config = loginConfig(platformCode);
  const loginInputs = await waitForCredentialInputs(page, config, formTimeoutMs, pollIntervalMs);
  if (!loginInputs) {
    return { status: 'manual_required', message: '等待登录页面完成加载后仍未识别到账号密码输入框，请人工完成登录' };
  }

  await loginInputs.accountInput.fill(account);
  await loginInputs.passwordInput.fill(password);
  const submit = await waitForFirstVisible(page, config.submitSelectors, Math.min(formTimeoutMs, 5_000), pollIntervalMs);
  if (!submit) {
    return { status: 'manual_required', message: '账号密码已填写，请人工确认并提交登录' };
  }
  await submit.click();

  const resultAttempts = Math.max(1, Math.ceil(resultTimeoutMs / pollIntervalMs));
  for (let attempt = 0; attempt < resultAttempts; attempt += 1) {
    const authenticatedPage = await findAuthenticatedPage(context, page).catch(() => null);
    if (authenticatedPage) return { status: 'authenticated', page: authenticatedPage };
    const body = await pageAndFrameText(page);
    const message = verificationMessage(body, credentials?.boundPhones);
    if (message) return { status: 'verification_required', message };
    if (LOGIN_ERROR_PATTERN.test(String(body || ''))) {
      return { status: 'manual_required', message: '平台提示运营账号或密码错误，请核对凭据后人工登录' };
    }
    if (attempt + 1 < resultAttempts) await page.waitForTimeout(pollIntervalMs);
  }
  return { status: 'manual_required', message: '账号密码已提交，但在等待时间内未确认登录成功，请人工处理平台提示' };
}

module.exports = {
  ACCOUNT_SELECTORS,
  PASSWORD_SELECTORS,
  SUBMIT_SELECTORS,
  LOGIN_FORM_TIMEOUT_MS,
  LOGIN_RESULT_TIMEOUT_MS,
  LOGIN_POLL_INTERVAL_MS,
  LOGIN_ERROR_PATTERN,
  PLATFORM_LOGIN_CONFIGS,
  VERIFICATION_PATTERN,
  loginConfig,
  loginWithCredentials,
  locatorScopes,
  pageAndFrameText,
  waitForCredentialInputs,
  waitForFirstVisible,
  verificationMessage
};
