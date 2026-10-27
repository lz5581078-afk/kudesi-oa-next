import { BadRequestException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { addDays, normalizePhone, normalizeReconcileDay } from '@kudesi/shared';
import { AuthUser } from '../common/auth.decorators';
import { ResourceLink, ResourceRecord } from '../entities';
import { CERT_AFTER_DELETE, CERT_AFTER_SAVE, CERT_BEFORE_SAVE, custodyRules, licenseFlags } from './entity-rules';
import { FINANCE_AFTER_DELETE, FINANCE_AFTER_SAVE, FINANCE_BEFORE_SAVE } from './finance-rules';
import { ASSET_BEFORE_DELETE, ASSET_BEFORE_SAVE } from './asset-rules';

/**
 * 各类资料的专属业务规则。通用的校验（必填、枚举、唯一、引用、停用原因）在 ResourcesService，
 * 这里只放“只有这一类资料才有”的规则，一条规则一个函数，便于单独测试。
 */
export interface RuleHost {
  findByUnique(em: EntityManager, companyId: number, type: string, uniqueKey: string): Promise<ResourceRecord | null>;
  /** 走与手工新增完全相同的校验、日志、关联流程 */
  createRecord(
    em: EntityManager,
    user: AuthUser,
    type: string,
    values: Record<string, unknown>,
    note?: string,
  ): Promise<ResourceRecord>;
  titleOf(em: EntityManager, companyId: number, type: string, id: number): Promise<string | null>;
  countWhere(em: EntityManager, companyId: number, type: string, field: string, value: unknown): Promise<number>;
  findWhere(em: EntityManager, companyId: number, type: string, field: string, value: string | number): Promise<ResourceRecord[]>;
  setStatusDirect(em: EntityManager, user: AuthUser, type: string, id: number, status: string, note?: string): Promise<void>;
  /** syncRefs：改了引用字段时同步关联表（默认不同步） */
  patchData(em: EntityManager, user: AuthUser, type: string, id: number, patch: Record<string, unknown>, note?: string, syncRefs?: boolean): Promise<void>;
  /** 读加密字段明文（仅服务端内部） */
  sensitiveOf(record: ResourceRecord, field: string): string | undefined;
  /** 改别的记录的加密字段；value 为空即清除 */
  setSensitive(em: EntityManager, user: AuthUser, type: string, id: number, field: string, value: string | null, note?: string): Promise<void>;
}

export interface BeforeSaveContext {
  em: EntityManager;
  host: RuleHost;
  user: AuthUser;
  /** 将要保存的字段值（可修改） */
  data: Record<string, unknown>;
  existing: ResourceRecord | null;
  /** 将要保存的状态；规则可以修改（如固定资产新建时有使用人就是使用中） */
  status: string;
  /** 加密字段（证件号/卡号）在保存后是否有值 */
  hasSensitive: (key: string) => boolean;
}

export interface AfterCreateContext {
  em: EntityManager;
  host: RuleHost;
  user: AuthUser;
  record: ResourceRecord;
  /** 校验后的完整提交值（含敏感字段明文，仅在内存中使用） */
  plain: Record<string, unknown>;
}

/**
 * 手机号绑定（店铺严格、微信/自媒体宽松）：号码文本和手机号档案选择器两种填法都要认。
 * - 填了号码文本：按文本匹配档案（店铺找不到就报错）；
 * - 只选了档案：号码文本取档案的号码，不能把绑定清掉；
 * - 同时改了档案选择器、没改文本：以新选的档案为准；
 * - 只清空了档案选择器：视为取消绑定，文本一并清掉。
 */
async function matchPhone(ctx: BeforeSaveContext, strict: boolean) {
  const raw = ctx.data.phoneNumber;
  const hasText = !(raw === undefined || raw === null || raw === '');
  const oldText = ctx.existing?.data.phoneNumber;
  const oldId = ctx.existing?.data.phoneId;
  const pickedId = typeof ctx.data.phoneId === 'number' ? (ctx.data.phoneId as number) : null;
  const textUnchanged = hasText && ctx.existing != null && normalizePhone(String(raw)) === normalizePhone(String(oldText ?? ''));
  const pickerChanged = ctx.existing != null && pickedId !== (typeof oldId === 'number' ? oldId : null);

  if (hasText && textUnchanged && pickerChanged) {
    if (pickedId === null) {
      ctx.data.phoneNumber = null;
      ctx.data.phoneId = null;
      return;
    }
    // 换了档案：号码跟着档案走（下面按“只选了档案”处理）
    ctx.data.phoneNumber = null;
  }
  const text = ctx.data.phoneNumber;
  if (text === undefined || text === null || text === '') {
    if (pickedId !== null) {
      const number = await ctx.host.titleOf(ctx.em, ctx.user.companyId, 'phones', pickedId);
      if (!number) throw new BadRequestException('手机号档案不存在');
      ctx.data.phoneNumber = number;
      ctx.data.phoneId = pickedId;
      return;
    }
    ctx.data.phoneId = null;
    return;
  }
  const number = normalizePhone(String(text));
  ctx.data.phoneNumber = number;
  const phone = await ctx.host.findByUnique(ctx.em, ctx.user.companyId, 'phones', number);
  if (!phone) {
    if (strict) throw new BadRequestException(`手机号 ${number} 还没有建档，请先到“手机号”里新增`);
    ctx.data.phoneId = null;
    return;
  }
  ctx.data.phoneId = phone.id;
}

function uniqueIds(...lists: unknown[]): number[] {
  const out: number[] = [];
  for (const l of lists) for (const v of Array.isArray(l) ? l : [l]) if (typeof v === 'number' && !out.includes(v)) out.push(v);
  return out;
}

/** 店铺可绑多个手机号：主号（phoneId）+ 更多（phoneIds）；同一手机号在同一平台只能绑一个店铺。 */
async function storePhones(ctx: BeforeSaveContext) {
  const ids = uniqueIds(ctx.data.phoneId, ctx.data.phoneIds);
  ctx.data.phoneId = ids[0] ?? null;
  ctx.data.phoneIds = ids.length > 1 ? ids.slice(1) : null;
  if (!ids.length || !ctx.data.platform) return;
  const stores = await ctx.em.find(ResourceRecord, { where: { companyId: ctx.user.companyId, type: 'stores' }, select: ['id', 'data'] });
  for (const st of stores) {
    if (st.id === ctx.existing?.id || st.data.platform !== ctx.data.platform) continue;
    const theirs = uniqueIds(st.data.phoneId, st.data.phoneIds);
    const hit = ids.find((id) => theirs.includes(id));
    if (hit !== undefined) throw new BadRequestException('该手机号在这个平台已绑定了其他店铺');
  }
}

/** 一个自媒体账号可关联多个店铺：主店铺（storeId）+ 更多（storeIds）。 */
function selfMediaStores(ctx: BeforeSaveContext) {
  const ids = uniqueIds(ctx.data.storeId, ctx.data.storeIds);
  ctx.data.storeId = ids[0] ?? null;
  ctx.data.storeIds = ids.length > 1 ? ids.slice(1) : null;
}

/**
 * 异常原因：可以直接输入新原因，库里没有就自动记入原因库；库里有同名的直接引用。
 * 刚改为异常状态时必须有原因。
 */
async function abnormalReason(ctx: BeforeSaveContext, lib: string) {
  const typed = typeof ctx.data.abnormalReasonText === 'string' ? ctx.data.abnormalReasonText.trim() : '';
  ctx.data.abnormalReasonText = null;
  if (ctx.status !== 'abnormal') return;
  if (typed) {
    const hit = await ctx.host.findByUnique(ctx.em, ctx.user.companyId, lib, typed);
    const rec = hit ?? (await ctx.host.createRecord(ctx.em, ctx.user, lib, { reason: typed.slice(0, 100) }, '异常原因自动记入库'));
    ctx.data.abnormalReason = rec.id;
  }
  if (ctx.existing?.status !== 'abnormal' && !ctx.data.abnormalReason) throw new BadRequestException('改为异常必须填写异常原因');
}

/** 店铺领取：预留/已领取/推广限制必须有运营人；推广限制必须有解除日；批量只给运营人时，公共店铺自动变已领取。 */
function storeClaim(ctx: BeforeSaveContext) {
  const d = ctx.data;
  const old = ctx.existing?.data ?? {};
  if (!d.claimStatus) d.claimStatus = d.operatorUserId ? 'claimed' : 'public';
  if (d.claimStatus === 'public' && old.claimStatus === 'public' && d.operatorUserId && d.operatorUserId !== old.operatorUserId) d.claimStatus = 'claimed';
  if (d.claimStatus === 'public') {
    delete d.operatorUserId;
    delete d.promotionReleaseAt;
    return;
  }
  const changed = !ctx.existing || d.claimStatus !== old.claimStatus || d.operatorUserId !== old.operatorUserId;
  if (!changed) return;
  if (!d.operatorUserId) throw new BadRequestException('指派店铺必须选择运营人');
  if (d.claimStatus === 'promotion_limited' && !d.promotionReleaseAt) throw new BadRequestException('推广限制店铺必须填写解除日期');
}

function checkReconcileDay(data: Record<string, unknown>) {
  const r = normalizeReconcileDay(data.reconcileCycle as string | undefined, data.reconcileDay as string | undefined);
  if (r.error) throw new BadRequestException(r.error);
  if (r.value) data.reconcileDay = r.value;
}

async function storeTitle(ctx: BeforeSaveContext): Promise<string> {
  const id = ctx.data.storeId;
  if (typeof id !== 'number') return '';
  return (await ctx.host.titleOf(ctx.em, ctx.user.companyId, 'stores', id)) ?? '';
}

/**
 * 印章联动（照旧页面）：缺失就清空种类和位置；普通章在位只能是自刻章，自刻章必然是普通章在位；
 * 普通章在位时只把种类改回防伪章（状态没动）= 取消普通章，回到“在位”；没缺失又没种类的补成防伪章。
 */
function applySealRules(data: Record<string, unknown>, existing: ResourceRecord | null) {
  for (const prefix of ['official', 'finance', 'legal', 'invoice']) {
    const state = `${prefix}State`;
    const kind = `${prefix}Kind`;
    const loc = `${prefix}LocationId`;
    const status = data[state];
    if (status === 'missing') {
      data[kind] = null;
      data[loc] = null;
      continue;
    }
    const kindChanged = existing ? (data[kind] ?? null) !== (existing.data[kind] ?? null) : false;
    const statusChanged = existing ? (status ?? null) !== (existing.data[state] ?? null) : false;
    if (status === 'ordinary_kept' && data[kind] === 'anti_fake' && kindChanged && !statusChanged) data[state] = 'kept';
    else if (status === 'ordinary_kept') data[kind] = 'self_carved';
    else if (data[kind] === 'self_carved' && (status === 'kept' || status === undefined || status === null)) data[state] = 'ordinary_kept';
    if (status && !data[kind]) data[kind] = 'anti_fake';
  }
}

/**
 * 总位置同步：存放总位置变化时，正本 / 副本位置为空或等于旧总位置就跟着改；
 * 印章总位置同理，缺失的印章不动。
 */
function syncLocations(data: Record<string, unknown>, existing: ResourceRecord | null) {
  const follow = (totalKey: string, keys: string[], skip?: (key: string) => boolean) => {
    const next = data[totalKey];
    const old = existing?.data[totalKey];
    if (next === undefined || next === null || next === old) return;
    for (const k of keys) {
      if (skip?.(k)) continue;
      if (data[k] === undefined || data[k] === null || data[k] === old) data[k] = next;
    }
  };
  follow('locationId', ['originalLocationId', 'copyLocationId']);
  follow('sealLocationId', ['official', 'finance', 'legal', 'invoice'].map((p) => `${p}LocationId`), (k) => data[k.replace('LocationId', 'State')] === 'missing');
}

export async function beforeSaveRule(type: string, ctx: BeforeSaveContext): Promise<void> {
  const financeRule = FINANCE_BEFORE_SAVE[type];
  if (financeRule) return financeRule(ctx);
  const assetRule = ASSET_BEFORE_SAVE[type];
  if (assetRule) return assetRule(ctx);
  switch (type) {
    case 'stores':
      await matchPhone(ctx, true);
      await storePhones(ctx);
      storeClaim(ctx);
      await abnormalReason(ctx, 'store-abnormal-reasons');
      return;
    case 'wechat':
      await matchPhone(ctx, false);
      return;
    case 'self-media':
      await matchPhone(ctx, false);
      selfMediaStores(ctx);
      return;
    case 'phones': {
      await abnormalReason(ctx, 'phone-abnormal-reasons');
      // 新建时的默认值（旧系统）：运营商中国移动
      if (!ctx.existing && !ctx.data.carrier) ctx.data.carrier = '中国移动';
      // 保管人：选了员工就以员工为准，手填姓名只在没选员工时保留
      if (ctx.data.keeperUserId) ctx.data.keeperName = null;
      const last = ctx.data.lastRechargeAt as string | undefined;
      if (last) {
        if (!ctx.data.rechargeCycleDays) ctx.data.rechargeCycleDays = 30;
        const cycle = Number(ctx.data.rechargeCycleDays);
        if (cycle < 1 || cycle > 3650) throw new BadRequestException('充值周期应在 1 到 3650 天之间');
        ctx.data.nextRechargeAt = addDays(last, cycle);
      } else {
        ctx.data.nextRechargeAt = null;
      }
      return;
    }
    case 'licenses':
      checkReconcileDay(ctx.data);
      applySealRules(ctx.data, ctx.existing);
      syncLocations(ctx.data, ctx.existing);
      custodyRules(ctx.data);
      licenseFlags(ctx);
      return;
    case 'store-daily-metrics': {
      const d = ctx.data as Record<string, unknown>;
      const n = (k: string) => (typeof d[k] === 'number' ? (d[k] as number) : 0);
      d.profit = n('sales') - n('refund') - n('adCost') - n('platformFee') - n('purchaseCost') - n('otherCost');
      d.source = d.source ?? 'manual';
      d.label = `${await storeTitle(ctx)} ${d.day}`;
      return;
    }
    case 'store-promotions': {
      const d = ctx.data as Record<string, unknown>;
      const spend = typeof d.spend === 'number' ? d.spend : 0;
      const gmv = typeof d.gmv === 'number' ? d.gmv : 0;
      d.roiPercent = spend > 0 ? Math.round((gmv / spend) * 100) : null;
      d.source = d.source ?? 'manual';
      d.label = `${await storeTitle(ctx)} ${d.day} ${d.campaign}`;
      return;
    }
    case 'store-funds': {
      const d = ctx.data as Record<string, unknown>;
      d.source = d.source ?? 'manual';
      d.label = `${await storeTitle(ctx)} ${d.snapshotDate} 资金`;
      return;
    }
    case 'store-scores': {
      const d = ctx.data as Record<string, unknown>;
      d.source = d.source ?? 'manual';
      d.label = `${await storeTitle(ctx)} ${d.snapshotDate} ${d.metric}`;
      return;
    }
    default:
      return CERT_BEFORE_SAVE[type]?.(ctx);
  }
}

export interface AfterSaveContext {
  em: EntityManager;
  host: RuleHost;
  user: AuthUser;
  record: ResourceRecord;
  /** 保存前的记录（新建为 null） */
  existing: ResourceRecord | null;
  /** 本次提交校验后的值（含加密字段明文，仅内存使用） */
  plain?: Record<string, unknown>;
}

/** 删除记录之前（在“还被引用就不能删”的检查之前）：如删除位置时把各处对它的引用置空。 */
export async function beforeDeleteRule(type: string, ctx: { em: EntityManager; host: RuleHost; user: AuthUser; record: ResourceRecord }): Promise<void> {
  const rule = ASSET_BEFORE_DELETE[type];
  if (rule) await rule(ctx);
}

/** 删除记录之后（记录已不存在，record 是删除前的内容）。 */
export async function afterDeleteRule(type: string, ctx: { em: EntityManager; host: RuleHost; user: AuthUser; record: ResourceRecord }): Promise<void> {
  const rule = FINANCE_AFTER_DELETE[type];
  if (rule) await rule(ctx);
  await CERT_AFTER_DELETE[type]?.(ctx);
}

/** 每次保存（新建、修改、改状态）之后：用于同步别的记录，如组合行变化后刷新组合编码。 */
export async function afterSaveRule(type: string, ctx: AfterSaveContext): Promise<void> {
  const rule = FINANCE_AFTER_SAVE[type];
  if (rule) await rule(ctx);
  await CERT_AFTER_SAVE[type]?.(ctx);
}

/** 找到手机号档案，没有就建（外部使用）；返回档案 id。 */
async function ensurePhone(ctx: AfterCreateContext, raw: unknown, holder: string, note: string): Promise<number | null> {
  const number = raw ? normalizePhone(String(raw)) : '';
  if (!number) return null;
  const { em, host, user } = ctx;
  const hit = await host.findByUnique(em, user.companyId, 'phones', number);
  if (hit) return hit.id;
  return (await host.createRecord(em, user, 'phones', { number, usageType: 'external_used', externalUser: holder }, note)).id;
}

/**
 * 营业执照建好后（照旧系统），自动补齐：法人手机号档案、法人合作人、税务资料、对公账户和法人银行卡。
 * 已经存在的档案复用并补上关联，不重复建。
 */
export async function afterCreateRule(type: string, ctx: AfterCreateContext): Promise<void> {
  if (type !== 'licenses' || ctx.em.queryRunner?.data.legacyImport) return;
  const { em, host, user, record, plain } = ctx;
  const note = `由营业执照「${record.title}」自动生成`;
  const legalPerson = String(plain.legalPerson ?? '');
  const legalPhone = plain.legalPhone ? normalizePhone(String(plain.legalPhone)) : '';
  const cardPhone = plain.legalCardPhone ? normalizePhone(String(plain.legalCardPhone)) : '';

  // 法人手机号：法人预留手机、法人银行卡预留手机，都建手机号档案
  await ensurePhone(ctx, legalPhone, legalPerson, note);
  const cardPhoneId = await ensurePhone(ctx, cardPhone, legalPerson, note);

  if (legalPerson) {
    const exists = await em
      .createQueryBuilder(ResourceRecord, 'r')
      .where('r.company_id = :c AND r.type = :t AND r.title = :n', { c: user.companyId, t: 'partners', n: legalPerson })
      .andWhere("JSON_UNQUOTE(JSON_EXTRACT(r.data, '$.partnerType')) = 'legal'")
      .getOne();
    const card = {
      cardHolder: plain.legalCardName || legalPerson,
      cardBank: plain.legalCardBank,
      cardPhone: cardPhone || undefined,
      cardPhoneId: cardPhoneId ?? undefined,
    };
    if (!exists) {
      await host.createRecord(
        em,
        user,
        'partners',
        {
          partnerType: 'legal',
          name: legalPerson,
          phone: legalPhone || cardPhone || undefined,
          licenseId: record.id,
          contactName: legalPerson,
          contactNote: '营业执照法人自动关联',
          cooperationScope: '营业执照法人',
          ...(plain.legalCardNo ? { cardNo: plain.legalCardNo, ...card } : {}),
        },
        note,
      );
    } else {
      // 同名法人已有档案：没挂执照就补上，已挂别的执照就多关联一张；银行卡信息空着的补上
      const own = exists.data.licenseId;
      if (own === undefined || own === null) await host.patchData(em, user, 'partners', exists.id, { licenseId: record.id }, note, true);
      else if (own !== record.id) {
        await em.insert(ResourceLink, { companyId: user.companyId, sourceType: 'partners', sourceId: exists.id, relation: 'manual', targetType: 'licenses', targetId: record.id });
      }
      const fill: Record<string, unknown> = {};
      if (plain.legalCardNo) {
        for (const [k, v] of Object.entries(card)) if (v !== undefined && !exists.data[k]) fill[k] = v;
        if (Object.keys(fill).length) await host.patchData(em, user, 'partners', exists.id, fill, note);
        if (!host.sensitiveOf(exists, 'cardNo')) await host.setSensitive(em, user, 'partners', exists.id, 'cardNo', String(plain.legalCardNo), note);
      }
    }
  }

  // 税务资料：按“识别号+类别”找已有的复用（没挂执照就挂上），没有才新建
  const taxCategory = plain.category === 'ecommerce' ? 'ecommerce' : 'operation';
  const taxes = await host.findWhere(em, user.companyId, 'tax-profiles', 'taxpayerNo', String(plain.creditCode));
  const sameTax = taxes.find((t) => (t.data.taxCategory ?? 'operation') === taxCategory);
  if (sameTax) {
    if (sameTax.data.licenseId === undefined || sameTax.data.licenseId === null) await host.patchData(em, user, 'tax-profiles', sameTax.id, { licenseId: record.id }, note, true);
  } else {
    await host.createRecord(
      em,
      user,
      'tax-profiles',
      {
        taxCategory,
        licenseId: record.id,
        taxpayerName: plain.companyName,
        taxpayerNo: plain.creditCode,
        taxType: 'pending',
        bankName: plain.publicAccountBank || undefined,
        bankAccountNo: plain.publicAccountNo || undefined,
      },
      note,
    );
  }

  // 电商执照建店铺公户 / 店铺个人银行卡，经营执照建公司公户 / 公司银行卡；已有同账号的不重复建，无归属的挂到本执照
  const ecommerce = plain.category === 'ecommerce';
  const accounts = [
    plain.publicAccountNo && {
      kind: ecommerce ? 'store_public' : 'company_public',
      accountName: plain.publicAccountName || plain.companyName,
      bank: plain.publicAccountBank || '待补充',
      accountNo: plain.publicAccountNo,
      reconcileCycle: plain.reconcileCycle,
      reconcileDay: plain.reconcileDay,
    },
    plain.legalCardNo && {
      kind: ecommerce ? 'store_personal_card' : 'company_card',
      accountName: plain.legalCardName || plain.legalPerson,
      bank: plain.legalCardBank || '待补充',
      accountNo: plain.legalCardNo,
      reservedPhoneNumber: plain.legalCardPhone,
      phoneId: cardPhoneId ?? undefined,
    },
  ].filter(Boolean) as Array<Record<string, unknown>>;
  for (const acc of accounts) {
    const hit = await host.findByUnique(em, user.companyId, 'bank-accounts', String(acc.accountNo));
    if (hit) {
      if (hit.data.licenseId === undefined || hit.data.licenseId === null) await host.patchData(em, user, 'bank-accounts', hit.id, { licenseId: record.id }, note, true);
      continue;
    }
    await host.createRecord(em, user, 'bank-accounts', { ...acc, licenseId: record.id }, note);
  }
}
