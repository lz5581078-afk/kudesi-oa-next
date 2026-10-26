import { BadRequestException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { addDays, normalizePhone } from '@kudesi/shared';
import { AuthUser } from '../common/auth.decorators';
import { ResourceRecord } from '../entities';
import { FINANCE_AFTER_DELETE, FINANCE_AFTER_SAVE, FINANCE_BEFORE_SAVE } from './finance-rules';

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
  patchData(em: EntityManager, user: AuthUser, type: string, id: number, patch: Record<string, unknown>, note?: string): Promise<void>;
}

export interface BeforeSaveContext {
  em: EntityManager;
  host: RuleHost;
  user: AuthUser;
  /** 将要保存的字段值（可修改） */
  data: Record<string, unknown>;
  existing: ResourceRecord | null;
  status: string;
}

export interface AfterCreateContext {
  em: EntityManager;
  host: RuleHost;
  user: AuthUser;
  record: ResourceRecord;
  /** 校验后的完整提交值（含敏感字段明文，仅在内存中使用） */
  plain: Record<string, unknown>;
}

/** 按手机号档案匹配：strict=找不到就报错（店铺），否则只是不关联。 */
async function matchPhone(ctx: BeforeSaveContext, strict: boolean) {
  const raw = ctx.data.phoneNumber;
  if (raw === undefined || raw === null || raw === '') {
    ctx.data.phoneId = null;
    return;
  }
  const number = normalizePhone(String(raw));
  ctx.data.phoneNumber = number;
  const phone = await ctx.host.findByUnique(ctx.em, ctx.user.companyId, 'phones', number);
  if (!phone) {
    if (strict) throw new BadRequestException(`手机号 ${number} 还没有建档，请先到“手机号”里新增`);
    ctx.data.phoneId = null;
    return;
  }
  ctx.data.phoneId = phone.id;
}

function checkReconcileDay(data: Record<string, unknown>) {
  const cycle = data.reconcileCycle as string | undefined;
  const day = data.reconcileDay as string | undefined;
  if (!day) return;
  if (cycle === 'monthly') {
    const n = Number(day);
    if (!Number.isInteger(n) || n < 1 || n > 31) throw new BadRequestException('按月对账的提醒日应填 1 到 31');
  } else if (cycle === 'quarterly' || cycle === 'yearly') {
    if (!/^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(day)) throw new BadRequestException('按季/按年对账的提醒日应填 MM-DD');
  }
}

async function storeTitle(ctx: BeforeSaveContext): Promise<string> {
  const id = ctx.data.storeId;
  if (typeof id !== 'number') return '';
  return (await ctx.host.titleOf(ctx.em, ctx.user.companyId, 'stores', id)) ?? '';
}

/**
 * 印章联动：缺失就清空种类和位置；普通章在位只能是自刻章，自刻章必然是普通章在位；
 * 防伪章不可能是“普通章在位”，退回“在位”。
 */
function applySealRules(data: Record<string, unknown>) {
  for (const prefix of ['official', 'finance', 'legal', 'invoice']) {
    const state = `${prefix}State`;
    const kind = `${prefix}Kind`;
    const loc = `${prefix}LocationId`;
    if (data[state] === 'missing') {
      data[kind] = null;
      data[loc] = null;
      continue;
    }
    if (data[state] === 'ordinary_kept') data[kind] = 'self_carved';
    else if (data[kind] === 'self_carved' && data[state]) data[state] = 'ordinary_kept';
    else if (data[kind] === 'anti_fake' && data[state] === 'ordinary_kept') data[state] = 'kept';
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
  switch (type) {
    case 'stores':
      await matchPhone(ctx, true);
      // 领取状态：没填时有运营人就是已领取，没有就是公共店铺；公共店铺没有运营人和推广限制日期
      if (!ctx.data.claimStatus) ctx.data.claimStatus = ctx.data.operatorUserId ? 'claimed' : 'public';
      if (ctx.data.claimStatus === 'public') { delete ctx.data.operatorUserId; delete ctx.data.promotionReleaseAt; }
      return;
    case 'wechat':
    case 'self-media':
      await matchPhone(ctx, false);
      return;
    case 'phones': {
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
      applySealRules(ctx.data);
      syncLocations(ctx.data, ctx.existing);
      return;
    case 'bank-accounts': {
      checkReconcileDay(ctx.data);
      // 银行预留手机号能在手机号档案里找到，就自动关联；找不到不阻断，保留手选的档案
      const reserved = ctx.data.reservedPhoneNumber;
      if (reserved) {
        const number = normalizePhone(String(reserved));
        const phone = await ctx.host.findByUnique(ctx.em, ctx.user.companyId, 'phones', number);
        if (phone) ctx.data.phoneId = phone.id;
      }
      return;
    }
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
    case 'license-borrows': {
      const { borrowedAt, expectedReturnAt, returnedAt } = ctx.data as Record<string, string | undefined>;
      if (expectedReturnAt && borrowedAt && expectedReturnAt < borrowedAt) throw new BadRequestException('预计归还日期不能早于借用日期');
      if (returnedAt && borrowedAt && returnedAt < borrowedAt) throw new BadRequestException('归还日期不能早于借用日期');
      return;
    }
    default:
      return;
  }
}

export interface AfterSaveContext {
  em: EntityManager;
  host: RuleHost;
  user: AuthUser;
  record: ResourceRecord;
  /** 保存前的记录（新建为 null） */
  existing: ResourceRecord | null;
}

/** 删除记录之后（记录已不存在，record 是删除前的内容）。 */
export async function afterDeleteRule(type: string, ctx: { em: EntityManager; host: RuleHost; user: AuthUser; record: ResourceRecord }): Promise<void> {
  const rule = FINANCE_AFTER_DELETE[type];
  if (rule) await rule(ctx);
}

/** 每次保存（新建、修改、改状态）之后：用于同步别的记录，如组合行变化后刷新组合编码。 */
export async function afterSaveRule(type: string, ctx: AfterSaveContext): Promise<void> {
  const rule = FINANCE_AFTER_SAVE[type];
  if (rule) await rule(ctx);
}

/** 营业执照建好后，自动补齐法人手机号、合作人、税务资料、对公账户和法人卡档案。 */
export async function afterCreateRule(type: string, ctx: AfterCreateContext): Promise<void> {
  if (type !== 'licenses') return;
  const { em, host, user, record, plain } = ctx;
  const note = `由营业执照「${record.title}」自动生成`;
  const legalPhone = plain.legalPhone ? normalizePhone(String(plain.legalPhone)) : '';

  let phoneId: number | null = null;
  if (legalPhone) {
    const existing = await host.findByUnique(em, user.companyId, 'phones', legalPhone);
    phoneId = existing
      ? existing.id
      : (
          await host.createRecord(
            em,
            user,
            'phones',
            { number: legalPhone, usageType: 'external_used', externalUser: String(plain.legalPerson ?? '') },
            note,
          )
        ).id;
  }

  if (plain.legalPerson) {
    // 同名法人已经建过合作人档案就复用，只补上执照关联，不再重复建
    const exists = await em
      .createQueryBuilder(ResourceRecord, 'r')
      .where('r.company_id = :c AND r.type = :t AND r.title = :n', { c: user.companyId, t: 'partners', n: String(plain.legalPerson) })
      .andWhere("JSON_UNQUOTE(JSON_EXTRACT(r.data, '$.partnerType')) = 'legal'")
      .getOne();
    if (!exists) {
      await host.createRecord(
        em,
        user,
        'partners',
        { partnerType: 'legal', name: plain.legalPerson, phone: legalPhone || undefined, licenseId: record.id, contactNote: '法人' },
        note,
      );
    }
  }

  await host.createRecord(
    em,
    user,
    'tax-profiles',
    {
      taxCategory: plain.category,
      licenseId: record.id,
      taxpayerName: plain.companyName,
      taxpayerNo: plain.creditCode,
      taxType: 'pending',
    },
    note,
  );

  // 电商执照建店铺公户 / 店铺个人银行卡，经营执照建公司公户 / 公司银行卡；已有同账号的不重复建
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
      phoneId: phoneId ?? undefined,
    },
  ].filter(Boolean) as Array<Record<string, unknown>>;
  for (const acc of accounts) {
    const hit = await host.findByUnique(em, user.companyId, 'bank-accounts', String(acc.accountNo));
    if (hit) continue;
    await host.createRecord(em, user, 'bank-accounts', { ...acc, licenseId: record.id }, note);
  }
}
