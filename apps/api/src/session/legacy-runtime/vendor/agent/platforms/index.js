const { pddPlatformAdapter } = require('./pdd');
const { createPlatformAdapter } = require('./generic');

const adapters = Object.freeze({
  pdd: pddPlatformAdapter,
  taobao: createPlatformAdapter({
    platformCode: 'taobao', platformName: '淘宝/天猫', homeUrl: 'https://myseller.taobao.com/home.htm',
    allowedHosts: ['*.taobao.com', '*.tmall.com', '*.alipay.com', 'myseller.taobao.com', 'loginmyseller.taobao.com', 'login.taobao.com', 'passport.taobao.com', 'qn.taobao.com', 'sellercenter.tmall.com', 'work.taobao.com', 'auth.alipay.com', 'b.alipay.com'],
    allowedDomainSuffixes: ['taobao.com', 'tmall.com', 'alipay.com'],
    authenticationExcludedHosts: ['taobao.com', 'tmall.com'],
    authenticationExcludedDomainSuffixes: [
      'alipay.com', 'www.taobao.com', 'item.taobao.com', 'cart.taobao.com', 'buyertrade.taobao.com',
      'trade.taobao.com', 'm.taobao.com', 'www.tmall.com', 'detail.tmall.com'
    ],
    loginHosts: ['loginmyseller.taobao.com', 'login.taobao.com', 'passport.taobao.com'],
    authenticatedHosts: ['myseller.taobao.com', 'qn.taobao.com', 'sellercenter.tmall.com', 'work.taobao.com'],
    authenticatedDomainSuffixes: ['taobao.com', 'tmall.com'],
    authenticatedSignals: ['千牛工作台', '店铺管理', '交易管理', '商品管理']
  }),
  douyin: createPlatformAdapter({
    platformCode: 'douyin', platformName: '抖音电商', homeUrl: 'https://fxg.jinritemai.com/login/common',
    allowedHosts: ['*.jinritemai.com', 'fxg.jinritemai.com', 'doudian-sso.jinritemai.com'], loginHosts: ['doudian-sso.jinritemai.com'],
    authenticatedHosts: ['fxg.jinritemai.com'],
    authenticatedSignals: ['抖店工作台', '订单管理', '商品管理', '店铺管理']
  }),
  kuaishou: createPlatformAdapter({
    platformCode: 'kuaishou', platformName: '快手电商', homeUrl: 'https://s.kwaixiaodian.com/',
    allowedHosts: ['*.kwaixiaodian.com', 's.kwaixiaodian.com', 'login.kwaixiaodian.com'], loginHosts: ['login.kwaixiaodian.com'],
    authenticatedHosts: ['s.kwaixiaodian.com'],
    authenticatedSignals: ['快手小店', '订单管理', '商品管理', '店铺管理']
  }),
  jd: createPlatformAdapter({
    platformCode: 'jd', platformName: '京东', homeUrl: 'https://shop.jd.com/',
    allowedHosts: ['*.jd.com', '*.jdpay.com', 'shop.jd.com', 'login.shop.jd.com', 'passport.shop.jd.com', 'seller-v10.shop.jd.com', 'passport.jd.com', 'pay-mer.jd.com', 'wares-jdm.jd.com'],
    loginHosts: ['login.shop.jd.com', 'passport.shop.jd.com', 'passport.jd.com'],
    authenticatedHosts: ['shop.jd.com', 'seller-v10.shop.jd.com', 'pay-mer.jd.com', 'wares-jdm.jd.com'],
    authenticatedSignals: ['京麦', '订单管理', '商品管理', '店铺管理']
  })
});

const aliases = new Map([
  ['拼多多', 'pdd'], ['pdd', 'pdd'],
  ['淘宝', 'taobao'], ['天猫', 'taobao'], ['淘宝/天猫', 'taobao'], ['淘宝天猫', 'taobao'], ['taobao', 'taobao'], ['tmall', 'taobao'],
  ['抖音', 'douyin'], ['抖店', 'douyin'], ['抖音电商', 'douyin'], ['douyin', 'douyin'],
  ['快手', 'kuaishou'], ['快手电商', 'kuaishou'], ['快手小店', 'kuaishou'], ['kuaishou', 'kuaishou'],
  ['京东', 'jd'], ['京麦', 'jd'], ['京东商城', 'jd'], ['jd', 'jd']
]);

function normalizePlatform(value) {
  return aliases.get(String(value || '').trim().toLowerCase()) || 'unsupported_platform';
}

function getPlatformAdapter(platformCode) {
  const adapter = adapters[String(platformCode || '')];
  if (!adapter) throw new Error('该店铺平台暂未支持，不能打开店铺');
  return adapter;
}

module.exports = { getPlatformAdapter, normalizePlatform, platformAdapters: adapters };
