const STATE_DEFINITIONS = Object.freeze({
  online_idle: { displayState: '在线空闲', color: 'green', priority: 10 },
  working: { displayState: '工作中', color: 'blue', priority: 40 },
  remote_active: { displayState: '正在远程操作', color: 'blue', priority: 50 },
  saving_profile: { displayState: '正在保存最新登录态', color: 'blue', priority: 60 },
  component_installing: { displayState: '浏览器组件正在安装', color: 'orange', priority: 30 },
  update_deferred: { displayState: '店铺浏览器运行中，更新已延期', color: 'orange', priority: 70 },
  updating: { displayState: '正在更新助手', color: 'orange', priority: 80 },
  offline_retrying: { displayState: 'OA 连接中断，正在自动重试', color: 'gray', priority: 20 },
  unbound: { displayState: '助手尚未绑定', color: 'gray', priority: 90 },
  revoked: { displayState: '电脑授权已撤销', color: 'red', priority: 100 },
  error: { displayState: '助手运行异常', color: 'red', priority: 110 },
  exiting: { displayState: '正在退出', color: 'gray', priority: 120 }
});

const ALIASES = Object.freeze({
  idle: 'online_idle',
  offline: 'offline_retrying',
  retrying: 'offline_retrying',
  installing_components: 'component_installing',
  opening_shop: 'working',
  waiting_login: 'working',
  validating: 'working',
  revoked: 'revoked'
});

const STEP_LABELS = Object.freeze({
  opening_browser: '正在打开店铺',
  opening_profile: '正在打开店铺',
  checking_local: '正在检查本机登录态',
  auto_login: '正在自动输入账号密码',
  restoring_profile: '正在打开本机店铺 Profile',
  restoring_remote: '正在打开本机店铺 Profile',
  waiting_login: '正在等待人工完成验证',
  validating_login: '正在验证登录状态',
  remote_active: '正在远程操作',
  saving_profile: '正在保存最新登录态',
  saving_session: '正在保存最新登录态',
  closing_browser: '正在安全关闭店铺浏览器',
  claiming: '正在领取更新任务',
  downloading: '正在下载助手更新',
  verifying: '正在校验更新包',
  staged: '更新包已准备完成',
  applying: '正在安装更新',
  restarting: '正在重启助手',
  checking_browser: '正在检查浏览器组件',
  browser_component_failed: '浏览器组件修复失败',
  authorization_revoked: '电脑授权已撤销'
});

function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(value || '').trim());
  return match ? match.slice(1).map(Number) : null;
}

function compareSemanticVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return 0;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

function versionConclusion(currentVersion, latestVersion) {
  if (!parseVersion(latestVersion)) return '无法获取线上版本';
  return compareSemanticVersions(currentVersion, latestVersion) < 0
    ? `发现新版本 v${latestVersion}`
    : '已是最新版本';
}

function normalizeState(value) {
  const raw = String(value || 'online_idle').trim();
  return STATE_DEFINITIONS[raw] ? raw : (ALIASES[raw] || 'working');
}

function sanitizeText(value, maxLength = 200) {
  return String(value || '')
    .replace(/(?:token|cookie|authorization|password)\s*[=:]\s*\S+/gi, '[敏感信息已隐藏]')
    .replace(/(?:Error:|at\s+\S+\s*\([^)]*\))/g, '')
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function createDisplayStatus(input = {}) {
  const state = normalizeState(input.state);
  const definition = STATE_DEFINITIONS[state];
  const step = String(input.currentStep || '').trim();
  const currentVersion = String(input.currentVersion || '').slice(0, 40);
  const latestVersion = String(input.latestVersion || '').slice(0, 40);
  const displayState = step === 'verifying'
    ? (state === 'updating' ? '正在校验更新包' : '正在验证登录状态')
    : (STEP_LABELS[step] || definition.displayState);
  return {
    state,
    displayState,
    color: definition.color,
    priority: definition.priority,
    currentStep: step.slice(0, 60),
    progress: Math.max(0, Math.min(100, Math.floor(Number(input.progress || 0)))),
    taskType: String(input.taskType || '').slice(0, 40),
    taskName: sanitizeText(input.taskName, 80),
    currentVersion,
    latestVersion,
    versionConclusion: versionConclusion(currentVersion, latestVersion),
    updateAvailable: Boolean(input.updateAvailable),
    lastConnectedAt: input.lastConnectedAt || null,
    message: sanitizeText(input.message, 300)
  };
}

function shouldReplaceStatus(current, next) {
  const currentDefinition = STATE_DEFINITIONS[normalizeState(current?.state)];
  const nextDefinition = STATE_DEFINITIONS[normalizeState(next?.state)];
  return nextDefinition.priority >= currentDefinition.priority;
}

module.exports = {
  STATE_DEFINITIONS,
  compareSemanticVersions,
  createDisplayStatus,
  normalizeState,
  shouldReplaceStatus,
  versionConclusion
};
