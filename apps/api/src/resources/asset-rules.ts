import { BadRequestException } from '@nestjs/common';
import { EntityManager, Not } from 'typeorm';
import { RESOURCE_DEFS } from '@kudesi/shared';
import { AuthUser } from '../common/auth.decorators';
import { ResourceChangeLog, ResourceLink, ResourceRecord } from '../entities';
import type { BeforeSaveContext, RuleHost } from './resource-rules';

/**
 * 固定资产、资产分类、位置、档案的专属规则（旧系统“资产与档案”那一块）。
 * 资产状态机本身在 packages/shared/src/asset-flow.ts，动作办理在 assets.service.ts。
 */

/** 编号自动生成：同公司同类型里 PREFIX-数字 的最大值 + 1，补足 6 位（旧系统是时间戳尾数，这里改成不会重复的顺序号）。 */
export async function nextSequentialCode(em: EntityManager, companyId: number, type: string, prefix: string): Promise<string> {
  const rows = await em
    .createQueryBuilder(ResourceRecord, 'r')
    .select('r.uniqueKey', 'k')
    .where('r.companyId = :companyId AND r.type = :type AND r.uniqueKey LIKE :p', { companyId, type, p: `${prefix.toLowerCase()}-%` })
    .getRawMany<{ k: string }>();
  const re = new RegExp(`^${prefix.toLowerCase()}-(\\d+)$`);
  let max = 0;
  for (const r of rows) {
    const m = re.exec(r.k ?? '');
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${prefix}-${String(max + 1).padStart(6, '0')}`;
}

/** 状态流转专用的事务标记：只有 assets.service 的“领用/归还/送修…”能改资产状态和使用人。 */
export const ASSET_ACTION_FLAG = 'assetAction';

async function beforeFixedAsset(ctx: BeforeSaveContext) {
  const { em, user, data, existing } = ctx;
  if (!data.assetNo) data.assetNo = await nextSequentialCode(em, user.companyId, 'fixed-assets', 'ASSET');
  if (em.queryRunner?.data.legacyImport) return;
  const viaAction = Boolean(em.queryRunner?.data[ASSET_ACTION_FLAG]);
  if (!existing) {
    // 新建：填了初始使用人就直接是使用中，否则闲置
    if (ctx.status !== 'idle' && ctx.status !== 'in_use') throw new BadRequestException('新建固定资产只能是闲置或使用中，报废、丢失、送修请建好后办理');
    ctx.status = data.userId ? 'in_use' : 'idle';
    return;
  }
  if (viaAction) return;
  if (ctx.status !== existing.status) throw new BadRequestException('固定资产的状态请用「领用、转交、归还、送修、报废」等操作办理');
  // 使用人只能通过领用/转交/归还变更
  if (data.userId !== existing.data.userId) {
    if (existing.data.userId === undefined) delete data.userId;
    else data.userId = existing.data.userId;
  }
}

async function beforeArchive(ctx: BeforeSaveContext) {
  if (!ctx.data.archiveNo) ctx.data.archiveNo = await nextSequentialCode(ctx.em, ctx.user.companyId, 'archives', 'ARCH');
  // 换了关联资料类型，别的类型的关联字段要清掉
  const type = ctx.data.relatedType as string | undefined;
  const fieldOf: Record<string, string> = {
    license: 'licenseId', store: 'storeId', bank_account: 'bankAccountId', fixed_asset: 'fixedAssetId',
    partner_profile: 'partnerId', trademark: 'trademarkId', qualification: 'qualificationId', tax_profile: 'taxProfileId',
  };
  for (const [t, f] of Object.entries(fieldOf)) if (t !== type) delete ctx.data[f];
}

async function beforeAssetCategory(ctx: BeforeSaveContext) {
  const { em, user, data, existing } = ctx;
  // 新增分类排序自动排在同级最后（间隔 10，便于以后插队）
  if (!existing && (data.sort === undefined || data.sort === null)) {
    const rows = await em.find(ResourceRecord, { where: { companyId: user.companyId, type: 'asset-categories' }, select: ['id', 'data'] });
    const parent = typeof data.parentId === 'number' ? data.parentId : null;
    const sibs = rows.filter((r) => (typeof r.data.parentId === 'number' ? r.data.parentId : null) === parent);
    data.sort = sibs.reduce((m, r) => Math.max(m, Number(r.data.sort) || 0), 0) + 10;
  }
}

/** 职责组：编码建好后不能改（旧系统同样不让改）。 */
async function beforeDutyGroup(ctx: BeforeSaveContext) {
  if (ctx.existing && String(ctx.data.groupKey ?? '') !== String(ctx.existing.data.groupKey ?? '')) {
    throw new BadRequestException('职责组编码建好后不能修改');
  }
}

/** 职责组成员：来源默认手动加入、加入日期默认今天；退出时补退出日期，并检查起止顺序。 */
async function beforeDutyMember(ctx: BeforeSaveContext) {
  const d = ctx.data;
  if (!d.source) d.source = 'manual';
  if (!d.startedAt) d.startedAt = new Date().toISOString().slice(0, 10);
  if (ctx.status === 'exited' && !d.endedAt) d.endedAt = new Date().toISOString().slice(0, 10);
  if (ctx.status !== 'exited') d.endedAt = null;
  if (d.endedAt && String(d.endedAt) < String(d.startedAt)) throw new BadRequestException('退出日期不能早于加入日期');
}

export const ASSET_BEFORE_SAVE: Record<string, (ctx: BeforeSaveContext) => Promise<void>> = {
  'duty-groups': beforeDutyGroup,
  'duty-group-members': beforeDutyMember,
  'fixed-assets': beforeFixedAsset,
  archives: beforeArchive,
  'asset-categories': beforeAssetCategory,
};

interface DeleteCtx { em: EntityManager; host: RuleHost; user: AuthUser; record: ResourceRecord }

/**
 * 删除位置：旧系统是“填原因，把子位置、档案、资产、U盾、证照各个位置槽位对它的引用全部置空，再删除”。
 * 这里按引用关系通用地做：谁指向这个位置，就把谁的那个字段清空，并给对方记一条日志。
 */
async function clearLocationRefs({ em, user, record }: DeleteCtx) {
  const links = await em.find(ResourceLink, { where: { companyId: user.companyId, targetType: 'locations', targetId: record.id } });
  for (const l of links.filter((x) => x.relation !== 'manual')) {
    const src = await em.findOne(ResourceRecord, { where: { id: l.sourceId, companyId: user.companyId, type: l.sourceType } });
    if (!src) continue;
    const def = RESOURCE_DEFS.find((d) => d.key === src.type);
    const label = def?.fields.find((f) => f.key === l.relation)?.label ?? l.relation;
    const before = { title: src.title, status: src.status, ...src.data };
    const data = { ...src.data } as Record<string, unknown>;
    const cur = data[l.relation];
    if (Array.isArray(cur)) data[l.relation] = cur.filter((x) => x !== record.id);
    else if (cur === record.id) delete data[l.relation];
    src.data = data;
    await em.save(ResourceRecord, src);
    await em.insert(ResourceChangeLog, {
      companyId: user.companyId, resourceType: src.type, resourceId: src.id, action: 'update', actorId: user.id,
      beforeJson: before as never, afterJson: { title: src.title, status: src.status, ...data } as never,
      note: `位置「${record.title}」已删除，${label}已清空`,
    });
  }
  await em.delete(ResourceLink, { companyId: user.companyId, targetType: 'locations', targetId: record.id, relation: Not('manual') });
}

export const ASSET_BEFORE_DELETE: Record<string, (ctx: DeleteCtx) => Promise<void>> = {
  locations: clearLocationRefs,
};
