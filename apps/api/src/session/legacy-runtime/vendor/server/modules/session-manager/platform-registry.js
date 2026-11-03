const PLATFORM_CODES = ['pdd', 'taobao', 'douyin', 'kuaishou', 'jd'];

const DEFINITIONS = Object.freeze({
  pdd: Object.freeze({
    platformCode: 'pdd', platformName: '拼多多', supported: true,
    aliases: ['拼多多', 'pdd'], homeUrl: 'https://mms.pinduoduo.com/',
    allowedHosts: ['*.pinduoduo.com', 'pinduoduo.com']
  }),
  taobao: Object.freeze({
    platformCode: 'taobao', platformName: '淘宝/天猫', supported: true,
    aliases: ['淘宝', '天猫', '淘宝/天猫', '淘宝天猫', 'taobao', 'tmall'],
    homeUrl: 'https://myseller.taobao.com/home.htm',
    allowedHosts: ['*.taobao.com', '*.tmall.com', '*.alipay.com', 'myseller.taobao.com', 'loginmyseller.taobao.com', 'login.taobao.com', 'passport.taobao.com', 'qn.taobao.com', 'sellercenter.tmall.com', 'work.taobao.com', 'auth.alipay.com', 'b.alipay.com'],
    allowedDomainSuffixes: ['taobao.com', 'tmall.com', 'alipay.com']
  }),
  douyin: Object.freeze({
    platformCode: 'douyin', platformName: '抖音电商', supported: true,
    aliases: ['抖音', '抖店', '抖音电商', 'douyin'], homeUrl: 'https://fxg.jinritemai.com/login/common',
    allowedHosts: ['*.jinritemai.com', 'fxg.jinritemai.com', 'doudian-sso.jinritemai.com']
  }),
  kuaishou: Object.freeze({
    platformCode: 'kuaishou', platformName: '快手电商', supported: true,
    aliases: ['快手', '快手电商', '快手小店', 'kuaishou'], homeUrl: 'https://s.kwaixiaodian.com/',
    allowedHosts: ['*.kwaixiaodian.com', 's.kwaixiaodian.com', 'login.kwaixiaodian.com']
  }),
  jd: Object.freeze({
    platformCode: 'jd', platformName: '京东', supported: true,
    aliases: ['京东', '京麦', '京东商城', 'jd'], homeUrl: 'https://shop.jd.com/',
    allowedHosts: ['*.jd.com', '*.jdpay.com', 'shop.jd.com', 'login.shop.jd.com', 'passport.shop.jd.com', 'seller-v10.shop.jd.com', 'passport.jd.com', 'pay-mer.jd.com', 'wares-jdm.jd.com']
  })
});

const ALIAS_TO_CODE = new Map();
for (const definition of Object.values(DEFINITIONS)) {
  for (const alias of definition.aliases) ALIAS_TO_CODE.set(alias.toLowerCase(), definition.platformCode);
}

function normalizePlatform(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return ALIAS_TO_CODE.get(normalized) || 'unsupported_platform';
}

function platformDefinition(value) {
  const code = DEFINITIONS[value] ? value : normalizePlatform(value);
  return DEFINITIONS[code] || Object.freeze({
    platformCode: 'unsupported_platform', platformName: String(value || '未知平台') || '未知平台',
    supported: false, aliases: [], homeUrl: '', allowedHosts: []
  });
}

function isAllowedPlatformUrl(platformCode, value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:') return false;
    const host = url.hostname.toLowerCase();
    const definition = platformDefinition(platformCode);
    const matchesHostOrSubdomain = (expected) => host === expected || host.endsWith(`.${expected}`);
    if ((definition.deniedExactHosts || []).includes(host)) return false;
    if ((definition.deniedHosts || []).some(matchesHostOrSubdomain)) return false;
    return definition.allowedHosts.some((allowed) => (
      allowed.startsWith('*.') ? matchesHostOrSubdomain(allowed.slice(2)) : host === allowed
    )) || (definition.allowedDomainSuffixes || []).some(matchesHostOrSubdomain);
  } catch {
    return false;
  }
}

function supportedPlatformValues() {
  return Object.values(DEFINITIONS).flatMap((definition) => definition.aliases.filter((alias) => /[\u4e00-\u9fff]/.test(alias)));
}

module.exports = {
  PLATFORM_CODES,
  isAllowedPlatformUrl,
  normalizePlatform,
  platformDefinition,
  supportedPlatformValues
};
