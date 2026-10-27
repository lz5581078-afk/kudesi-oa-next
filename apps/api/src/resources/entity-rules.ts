import { BadRequestException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { normalizePhone, normalizeReconcileDay, todayShanghai } from '@kudesi/shared';
import { AuthUser } from '../common/auth.decorators';
import { ResourceRecord, User } from '../entities';
import type { AfterSaveContext, BeforeSaveContext, RuleHost } from './resource-rules';

/**
 * 证照与主体类资料（营业执照、借用/使用记录、商标及店铺授权、合作人、税务、银行账户、U 盾）的专属规则。
 * 口径照旧系统：借出情况显示在执照上、银行账户为准回写执照公户/法人卡、商标授权回写店铺、U 盾个数等。
 */

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const norm = (v: unknown) => String(v ?? '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();
const digits = (v: unknown) => String(v ?? '').replace(/[\s-]/g, '');

/** 按字段值找记录，不含已归档的。 */
async function findLive(host: RuleHost, em: EntityManager, companyId: number, type: string, field: string, value: string | number) {
  return (await host.findWhere(em, companyId, type, field, value)).filter((r) => !r.archivedAt);
}

const ITEM_LABEL: Record<string, string> = { original: '正本', copy: '副本', official: '公章', finance: '财务章', legal: '法人章', invoice: '发票章' };

// ---------- 营业执照 ----------

/** 照旧页面的实物联动：正本/副本缺失、KT 板无，对应位置清空。 */
export function custodyRules(data: Record<string, unknown>) {
  if (data.originalState === 'missing') data.originalLocationId = null;
  if (data.copyState === 'missing') data.copyLocationId = null;
  if (data.ktBoard === 'none') data.ktBoardLocationId = null;
}

/** 执照上的派生标记：年审月份、公户/印章/位置/照片情况（列表筛选用，系统计算）。 */
export function licenseFlags(ctx: BeforeSaveContext) {
  const d = ctx.data;
  const month = str(d.annualAuditDay).slice(0, 2);
  d.annualAuditMonth = month || null;
  const hasPublic = Boolean(d.publicAccountName || d.publicAccountBank || ctx.hasSensitive('publicAccountNo'));
  d.publicAccountFlag = hasPublic || ctx.existing?.data.publicAccountFlag === 'yes' ? 'yes' : 'no';
  const sealMissing = ['official', 'finance', 'legal', 'invoice'].some((p) => d[`${p}State`] === 'missing');
  d.sealFlag = sealMissing ? 'lost' : 'ok';
  d.locationFlag = d.locationId || d.originalLocationId || d.copyLocationId ? null : 'none';
  const has = (k: string) => Array.isArray(d[k]) && (d[k] as unknown[]).length > 0;
  d.photoFlag = has('originalPhoto') && has('copyPhoto') ? null : 'gap';
}

/** 借出的正本/副本/印章显示在执照的“借出情况”上（借出中、逾期都算借出）。 */
async function refreshBorrowedSummary(em: EntityManager, host: RuleHost, user: AuthUser, licenseId: unknown) {
  if (typeof licenseId !== 'number') return;
  const rows = (await findLive(host, em, user.companyId, 'license-borrows', 'licenseId', licenseId)).filter((r) => ['borrowed', 'overdue'].includes(r.status));
  rows.sort((a, b) => a.id - b.id);
  const text = rows
    .map((r) => `${ITEM_LABEL[str(r.data.item)] ?? str(r.data.item)}：${str(r.data.borrower)}借走${r.data.expectedReturnAt ? `，预计 ${str(r.data.expectedReturnAt)} 归还` : ''}`)
    .join('；');
  await host.patchData(em, user, 'licenses', licenseId, { borrowedSummary: text || null }, '借出情况随借用记录更新');
}

async function licenseBorrowBefore(ctx: BeforeSaveContext) {
  const d = ctx.data;
  const { borrowedAt, expectedReturnAt, returnedAt } = d as Record<string, string | undefined>;
  if (expectedReturnAt && borrowedAt && expectedReturnAt < borrowedAt) throw new BadRequestException('预计归还日期不能早于借用日期');
  if (returnedAt && borrowedAt && returnedAt < borrowedAt) throw new BadRequestException('归还日期不能早于借用日期');
  let name = str(d.borrowerName).trim();
  if (typeof d.borrowerUserId === 'number') {
    const u = await ctx.em.findOne(User, { where: { id: d.borrowerUserId, companyId: ctx.user.companyId } });
    name = u?.name ?? name;
    d.borrowerName = null;
  }
  if (!name) throw new BadRequestException('请选择借用人（员工），或填写外部人员姓名');
  d.borrower = name;
  // 登记归还：状态变成已归还就补上今天的归还日期；填了归还日期就是已归还；改回借出则清掉归还日期
  const wasReturned = ctx.existing?.status === 'returned';
  if (ctx.status === 'returned' && !d.returnedAt) d.returnedAt = todayShanghai();
  else if (d.returnedAt && ctx.status !== 'returned' && !wasReturned) ctx.status = 'returned';
  else if (d.returnedAt && ctx.status !== 'returned') d.returnedAt = null;
}

// ---------- 银行账户 ⇄ 营业执照 ----------

const PUBLIC_KINDS = ['company_public', 'store_public'];
const CARD_KINDS = ['company_card', 'store_personal_card'];

function pickAccount(list: Array<{ rec: ResourceRecord; no: string }>, preferredNo: string | undefined) {
  if (!list.length) return null;
  const preferred = preferredNo ? list.find((a) => digits(a.no) === digits(preferredNo)) : undefined;
  if (preferred) return preferred;
  const active = list.filter((a) => a.rec.status !== 'inactive');
  const pool = active.length ? active : list;
  return [...pool].sort((a, b) => new Date(b.rec.updatedAt).getTime() - new Date(a.rec.updatedAt).getTime() || b.rec.id - a.rec.id)[0];
}

/** 银行账户为准：把该执照的公户、法人银行卡信息回写到执照上登记的栏目。 */
export async function writeBackLicenseBank(em: EntityManager, host: RuleHost, user: AuthUser, licenseId: unknown) {
  if (typeof licenseId !== 'number') return;
  const license = await em.findOne(ResourceRecord, { where: { id: licenseId, companyId: user.companyId, type: 'licenses' } });
  if (!license) return;
  const accounts = (await findLive(host, em, user.companyId, 'bank-accounts', 'licenseId', licenseId)).map((rec) => ({ rec, no: host.sensitiveOf(rec, 'accountNo') ?? '' }));
  const pubs = accounts.filter((a) => PUBLIC_KINDS.includes(str(a.rec.data.kind)));
  const cards = accounts.filter((a) => CARD_KINDS.includes(str(a.rec.data.kind)));
  const legal = norm(license.data.legalPerson);
  const legalCards = legal ? cards.filter((c) => norm(c.rec.data.ownerName) === legal || norm(c.rec.data.accountName) === legal) : [];
  const pub = pickAccount(pubs, host.sensitiveOf(license, 'publicAccountNo'));
  const card = pickAccount(legalCards.length ? legalCards : cards, host.sensitiveOf(license, 'legalCardNo'));
  const patch: Record<string, unknown> = {};
  if (pub) {
    patch.publicAccountName = pub.rec.data.accountName ?? null;
    patch.publicAccountBank = pub.rec.data.bank ?? null;
  }
  if (card) {
    patch.legalCardName = card.rec.data.accountName ?? null;
    patch.legalCardBank = card.rec.data.bank ?? null;
    patch.legalCardPhone = card.rec.data.reservedPhoneNumber ?? null;
  }
  if (pubs.some((a) => a.rec.status !== 'inactive')) patch.publicAccountFlag = 'yes';
  const note = '执照登记的公户/法人银行卡按银行账户同步';
  if (Object.keys(patch).length) await host.patchData(em, user, 'licenses', licenseId, patch, note);
  if (pub && pub.no) await host.setSensitive(em, user, 'licenses', licenseId, 'publicAccountNo', pub.no, note);
  if (card && card.no) await host.setSensitive(em, user, 'licenses', licenseId, 'legalCardNo', card.no, note);
}

// ---------- 商标授权 ⇄ 店铺 ----------

async function trademarksByName(em: EntityManager, companyId: number, name: string) {
  const key = norm(name);
  if (!key) return [];
  const rows = await em.find(ResourceRecord, { where: { companyId, type: 'trademarks' }, select: ['id', 'title', 'status'] });
  return rows.filter((r) => norm(r.title) === key);
}

/** 店铺的“授权商标/授权商标到期”由授权关联回写：取授权到期最晚的（有日期的排在没日期的前面）。 */
export async function syncStoreTrademark(em: EntityManager, host: RuleHost, user: AuthUser, storeId: unknown) {
  if (typeof storeId !== 'number') return;
  const store = await em.findOne(ResourceRecord, { where: { id: storeId, companyId: user.companyId, type: 'stores' } });
  if (!store) return;
  const auths = (await findLive(host, em, user.companyId, 'trademark-authorizations', 'storeId', storeId)).filter((a) => a.status === 'normal');
  auths.sort((a, b) => {
    const av = str(a.data.validTo);
    const bv = str(b.data.validTo);
    if (av && bv && av !== bv) return av < bv ? 1 : -1;
    if (av && !bv) return -1;
    if (!av && bv) return 1;
    return b.id - a.id;
  });
  const note = '店铺授权商标按商标授权关联同步';
  const top = auths[0];
  if (!top) {
    // 没有授权了：清掉来自商标档案的值，对不上任何商标的手写文字保留
    const current = str(store.data.trademark);
    if (current && (await trademarksByName(em, user.companyId, current)).length) await host.patchData(em, user, 'stores', storeId, { trademark: null, trademarkExpireAt: null }, note);
    return;
  }
  const name = (await host.titleOf(em, user.companyId, 'trademarks', Number(top.data.trademarkId))) ?? '';
  await host.patchData(em, user, 'stores', storeId, { trademark: name || null, trademarkExpireAt: top.data.validTo ?? null }, note);
}

async function storeAfterSave(ctx: AfterSaveContext) {
  const { em, host, user, record, existing } = ctx;
  const name = str(record.data.trademark).trim();
  const expire = str(record.data.trademarkExpireAt);
  if (existing && str(existing.data.trademark).trim() === name && str(existing.data.trademarkExpireAt) === expire) return;
  if (!name) return syncStoreTrademark(em, host, user, record.id);
  const matches = await trademarksByName(em, user.companyId, name);
  if (matches.length !== 1) return; // 对不上档案的商标名称，保留为店铺上的手写文字
  const auths = (await findLive(host, em, user.companyId, 'trademark-authorizations', 'storeId', record.id)).filter((a) => Number(a.data.trademarkId) === matches[0].id);
  if (auths.length === 0) {
    await host.createRecord(em, user, 'trademark-authorizations', { trademarkId: matches[0].id, storeId: record.id, validTo: expire || undefined }, '店铺授权商标');
  } else if (str(auths[0].data.validTo) !== expire) {
    await host.patchData(em, user, 'trademark-authorizations', auths[0].id, { validTo: expire || null }, '店铺授权商标到期日');
    await syncStoreTrademark(em, host, user, record.id);
  } else {
    await syncStoreTrademark(em, host, user, record.id);
  }
}

// ---------- 规则表 ----------

type Before = (ctx: BeforeSaveContext) => Promise<void> | void;
type After = (ctx: AfterSaveContext) => Promise<void>;

export const CERT_BEFORE_SAVE: Record<string, Before> = {
  'license-borrows': licenseBorrowBefore,

  'license-usages': (ctx) => {
    if (!ctx.data.usageType) ctx.data.usageType = '业务办理';
  },

  trademarks: async (ctx) => {
    const d = ctx.data;
    if (!d.applicant && typeof d.licenseId === 'number') {
      d.applicant = (await ctx.host.titleOf(ctx.em, ctx.user.companyId, 'licenses', d.licenseId)) ?? undefined;
    }
    // 新增时按日期推断状态：有注册日期=已注册，有受理日期=已受理
    if (!ctx.existing && ctx.status === 'applying') {
      if (d.registeredAt) ctx.status = 'registered';
      else if (d.acceptedAt) ctx.status = 'accepted';
    }
  },

  'trademark-authorizations': async (ctx) => {
    const d = ctx.data as Record<string, unknown>;
    if (d.validFrom && d.validTo && String(d.validTo) < String(d.validFrom)) throw new BadRequestException('授权到期不能早于授权开始');
    const t = typeof d.trademarkId === 'number' ? await ctx.host.titleOf(ctx.em, ctx.user.companyId, 'trademarks', d.trademarkId) : '';
    const s = typeof d.storeId === 'number' ? await ctx.host.titleOf(ctx.em, ctx.user.companyId, 'stores', d.storeId) : '';
    d.label = `${t ?? ''} → ${s ?? ''}`;
  },

  partners: async (ctx) => {
    const d = ctx.data;
    if (!d.partnerType) d.partnerType = 'partner';
    if (d.startedAt && d.endedAt && String(d.endedAt) < String(d.startedAt)) throw new BadRequestException('结束时间不能早于开始时间');
    // 预留手机号：选了手机号档案就以档案为准、文字回写；只填了号码则按档案自动匹配
    if (typeof d.cardPhoneId === 'number') {
      const phone = await ctx.em.findOne(ResourceRecord, { where: { id: d.cardPhoneId, companyId: ctx.user.companyId, type: 'phones' } });
      if (phone) d.cardPhone = str(phone.data.number) || phone.title;
    } else if (d.cardPhone) {
      const number = normalizePhone(String(d.cardPhone));
      const phone = number ? await ctx.host.findByUnique(ctx.em, ctx.user.companyId, 'phones', number) : null;
      if (phone) d.cardPhoneId = phone.id;
    }
    d.cardFlag = d.cardHolder || d.cardBank || ctx.hasSensitive('cardNo') ? 'yes' : 'no';
  },

  'tax-profiles': async (ctx) => {
    const d = ctx.data;
    if (typeof d.licenseId === 'number') {
      const lic = await ctx.em.findOne(ResourceRecord, { where: { id: d.licenseId, companyId: ctx.user.companyId, type: 'licenses' } });
      if (lic) {
        if (!d.taxCategory) d.taxCategory = lic.data.category === 'ecommerce' ? 'ecommerce' : 'operation';
        if (!d.taxpayerName) d.taxpayerName = lic.data.companyName;
        if (!d.taxpayerNo) d.taxpayerNo = lic.data.creditCode;
      }
    }
    if (!d.taxCategory) d.taxCategory = 'operation';
    if (!d.taxpayerName) throw new BadRequestException('纳税人名称不能为空');
  },

  'bank-accounts': async (ctx) => {
    const d = ctx.data;
    const rd = normalizeReconcileDay(str(d.reconcileCycle), str(d.reconcileDay));
    if (rd.error) throw new BadRequestException(rd.error);
    if (rd.value) d.reconcileDay = rd.value;
    const reserved = d.reservedPhoneNumber;
    if (reserved) {
      const number = normalizePhone(String(reserved));
      const phone = await ctx.host.findByUnique(ctx.em, ctx.user.companyId, 'phones', number);
      if (phone) d.phoneId = phone.id;
    }
    // 选了手机号档案、没填文字时，文字按档案回写
    if (typeof d.phoneId === 'number' && !reserved) {
      const phone = await ctx.em.findOne(ResourceRecord, { where: { id: d.phoneId, companyId: ctx.user.companyId, type: 'phones' } });
      if (phone) d.reservedPhoneNumber = str(phone.data.number) || phone.title;
    }
    d.phoneFlag = d.phoneId ? 'linked' : d.reservedPhoneNumber ? 'unlinked' : 'none';
    let hasStore = typeof d.storeId === 'number';
    if (!hasStore && ctx.existing) hasStore = (await ctx.host.countWhere(ctx.em, ctx.user.companyId, 'bank-store-links', 'bankAccountId', ctx.existing.id)) > 0;
    d.storeFlag = hasStore ? 'yes' : 'no';
  },

  'bank-store-links': async (ctx) => {
    const d = ctx.data as Record<string, unknown>;
    const a = typeof d.bankAccountId === 'number' ? await ctx.host.titleOf(ctx.em, ctx.user.companyId, 'bank-accounts', d.bankAccountId) : '';
    const s = typeof d.storeId === 'number' ? await ctx.host.titleOf(ctx.em, ctx.user.companyId, 'stores', d.storeId) : '';
    d.label = `${a ?? ''} → ${s ?? ''}`;
  },

  'u-shields': async (ctx) => {
    const d = ctx.data;
    // 新增时保管人默认取银行账户的保管人
    if (!ctx.existing && !d.keeperUserId && typeof d.bankAccountId === 'number') {
      const bank = await ctx.em.findOne(ResourceRecord, { where: { id: d.bankAccountId, companyId: ctx.user.companyId, type: 'bank-accounts' } });
      if (bank && typeof bank.data.keeperUserId === 'number') d.keeperUserId = bank.data.keeperUserId;
    }
  },
};

async function recountShields(ctx: AfterSaveContext | { em: EntityManager; host: RuleHost; user: AuthUser; record: ResourceRecord }) {
  const { em, host, user, record } = ctx;
  const bankId = record.data.bankAccountId;
  if (typeof bankId !== 'number') return;
  const n = (await findLive(host, em, user.companyId, 'u-shields', 'bankAccountId', bankId)).filter((s) => s.status !== 'inactive').length;
  await host.patchData(em, user, 'bank-accounts', bankId, { shieldCount: n, shieldFlag: n > 0 ? 'has' : 'none' }, 'U 盾个数更新');
}

async function refreshStoreFlag(ctx: { em: EntityManager; host: RuleHost; user: AuthUser; record: ResourceRecord }) {
  const { em, host, user, record } = ctx;
  const bankId = record.data.bankAccountId;
  if (typeof bankId !== 'number') return;
  const bank = await em.findOne(ResourceRecord, { where: { id: bankId, companyId: user.companyId, type: 'bank-accounts' } });
  if (!bank) return;
  const links = (await findLive(host, em, user.companyId, 'bank-store-links', 'bankAccountId', bankId)).filter((l) => l.status !== 'inactive').length;
  await host.patchData(em, user, 'bank-accounts', bankId, { storeFlag: typeof bank.data.storeId === 'number' || links > 0 ? 'yes' : 'no' });
}

export const CERT_AFTER_SAVE: Record<string, After> = {
  'license-borrows': async ({ em, host, user, record, existing }) => {
    await refreshBorrowedSummary(em, host, user, record.data.licenseId);
    if (existing && existing.data.licenseId !== record.data.licenseId) await refreshBorrowedSummary(em, host, user, existing.data.licenseId);
  },
  trademarks: async ({ em, host, user, record, existing }) => {
    if (!existing || existing.title === record.title) return;
    // 商标改名：授权名称、被授权店铺上的授权商标一并更新
    for (const a of await findLive(host, em, user.companyId, 'trademark-authorizations', 'trademarkId', record.id)) {
      const store = await host.titleOf(em, user.companyId, 'stores', Number(a.data.storeId));
      await host.patchData(em, user, 'trademark-authorizations', a.id, { label: `${record.title} → ${store ?? ''}` });
      await syncStoreTrademark(em, host, user, Number(a.data.storeId));
    }
  },
  'trademark-authorizations': async ({ em, host, user, record, existing }) => {
    await syncStoreTrademark(em, host, user, record.data.storeId);
    if (existing && existing.data.storeId !== record.data.storeId) await syncStoreTrademark(em, host, user, existing.data.storeId);
  },
  stores: storeAfterSave,
  'bank-accounts': async ({ em, host, user, record, existing }) => {
    await writeBackLicenseBank(em, host, user, record.data.licenseId);
    if (existing && existing.data.licenseId !== record.data.licenseId) await writeBackLicenseBank(em, host, user, existing.data.licenseId);
  },
  'bank-store-links': async (ctx) => refreshStoreFlag(ctx),
  'u-shields': async (ctx) => recountShields(ctx),
};

export const CERT_AFTER_DELETE: Record<string, (ctx: { em: EntityManager; host: RuleHost; user: AuthUser; record: ResourceRecord }) => Promise<void>> = {
  'license-borrows': async ({ em, host, user, record }) => refreshBorrowedSummary(em, host, user, record.data.licenseId),
  'trademark-authorizations': async ({ em, host, user, record }) => syncStoreTrademark(em, host, user, record.data.storeId),
  'bank-accounts': async ({ em, host, user, record }) => writeBackLicenseBank(em, host, user, record.data.licenseId),
  'bank-store-links': async (ctx) => refreshStoreFlag(ctx),
  'u-shields': async (ctx) => recountShields(ctx),
};
