import { BadRequestException } from '@nestjs/common';
import { parentLinkProblem } from '@kudesi/shared';
import { ResourceRecord } from '../entities';
import type { BeforeSaveContext } from './resource-rules';

/** 旧系统迁入事务：历史数据可能不满足新规则，先原样迁入，由费用模块提示后人工整理 */
export const isLegacyImport = (ctx: BeforeSaveContext) => ctx.em.queryRunner?.data.legacyImport === true;

/**
 * 手机号主子卡：只允许两级，主卡不能是自己、不能是子卡、不能已停用；已经有子卡的号码不能再挂到别的主卡下。
 * 只在“主卡”字段发生变化时检查，不拦截历史数据上无关字段的修改。
 * cardKind（主卡/子卡）不存库，读时由主卡字段推出，所以与主卡字段天然一致。
 */
export async function phoneParentRule(ctx: BeforeSaveContext): Promise<void> {
  const next = ctx.data.parentPhoneId;
  if (next === undefined || next === null || next === '') return;
  if (next === ctx.existing?.data.parentPhoneId) return;
  if (isLegacyImport(ctx)) return;
  const parentId = Number(next);
  const parent = await ctx.em.findOne(ResourceRecord, { where: { id: parentId, companyId: ctx.user.companyId, type: 'phones' } });
  if (!parent || parent.archivedAt) throw new BadRequestException('主卡不存在或已归档');
  const selfId = ctx.existing?.id ?? null;
  const selfChildCount = selfId ? await ctx.host.countWhere(ctx.em, ctx.user.companyId, 'phones', 'parentPhoneId', selfId) : 0;
  const problem = parentLinkProblem({ selfId, parent: { id: parent.id, parentPhoneId: parent.data.parentPhoneId, stopped: parent.status === 'inactive' }, selfChildCount });
  if (problem) throw new BadRequestException(problem);
}

/**
 * 宽带必须和手机号绑定：新建时必须选手机号档案（宽带费用要能追到是哪个号在用）。
 * 历史数据没绑定的不拦编辑，由费用模块标红提示补绑。
 */
export function broadbandPhoneRule(ctx: BeforeSaveContext): void {
  if (ctx.existing || isLegacyImport(ctx)) return;
  if (!ctx.data.phoneId) throw new BadRequestException('宽带必须绑定手机号：请选择“绑定手机号”');
}
