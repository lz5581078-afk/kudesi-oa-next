import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { createChecker, getResourceDef, todayShanghai, validateWorkforceTerms } from '@kudesi/shared';
import { EntityManager } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { ResourceRecord, User } from '../entities';
import { ResourcesService } from '../resources/resources.service';

export interface StaffWorkforceTerms {
  employmentType?: 'regular' | 'part_time' | 'temp';
  contractStartDate?: string | null;
  contractEndDate?: string | null;
  workforceData?: Record<string, unknown>;
}

export async function staffWorkforceRecord(em: EntityManager, companyId: number, userId: number) {
  const records = await em.createQueryBuilder(ResourceRecord, 'r')
    .where("r.company_id = :companyId AND r.type = 'workforce'", { companyId })
    .andWhere("JSON_UNQUOTE(JSON_EXTRACT(r.data, '$.userId')) = :userId", { userId: String(userId) })
    .getMany();
  if (records.length > 1) throw new ConflictException('该员工存在多份用工档案，请先核对历史资料');
  return records[0] ?? null;
}

/** 只在明确编辑用工类型/合作期时联动；与员工更新使用同一事务，档案仍走通用资料引擎。 */
export async function syncStaffWorkforce(em: EntityManager, actor: AuthUser, person: User, input: StaffWorkforceTerms, resources?: ResourcesService) {
  if (input.employmentType === undefined && input.contractStartDate === undefined && input.contractEndDate === undefined && input.workforceData === undefined) return;
  const existing = await staffWorkforceRecord(em, actor.companyId, person.id);
  const can = createChecker(actor.permissions);
  const requireResources = () => {
    if (!resources) throw new BadRequestException('未配置用工档案服务');
    return resources;
  };
  if (person.employmentType === 'regular') {
    if (input.contractStartDate || input.contractEndDate || input.workforceData !== undefined) throw new BadRequestException('正式员工不设置兼职合作期限');
    if (existing && !existing.archivedAt) {
      if (!can('resource.workforce.edit')) throw new ForbiddenException('没有修改兼职与临时工档案的权限');
      await requireResources().setWorkforceHistory(em, actor, existing.id, true);
    }
    return;
  }
  if (!['part_time', 'temp'].includes(person.employmentType)) throw new BadRequestException('请选择有效用工类型');
  if (person.isCompanyAdmin) throw new BadRequestException('公司管理员不能列为兼职或临时工');
  const contractStartDate = input.contractStartDate !== undefined ? input.contractStartDate : existing?.data.contractStartDate ?? todayShanghai();
  const contractEndDate = input.contractEndDate !== undefined ? input.contractEndDate : existing?.data.contractEndDate ?? null;
  const details = Object.fromEntries(getResourceDef('workforce')!.fields
    .filter(field => !field.readonly && field.key !== 'userId' && (!field.permission || can(field.permission)) &&
      Object.prototype.hasOwnProperty.call(input.workforceData ?? {}, field.key))
    .map(field => [field.key, input.workforceData![field.key]]));
  const values = { ...details, employmentType: person.employmentType, contractStartDate, contractEndDate };
  const problem = validateWorkforceTerms(values);
  if (problem) throw new BadRequestException(problem);
  if (String(contractStartDate) < '1000-01-01') throw new BadRequestException('合作开始日期不合法');
  const changed = !existing || !!existing.archivedAt || existing.title !== person.name || (existing.data.account ?? '') !== (person.account ?? '') || Object.entries(values).some(([key, value]) => JSON.stringify(existing.data[key] ?? null) !== JSON.stringify(value ?? null));
  if (!changed) return;
  if (!can(existing ? 'resource.workforce.edit' : 'resource.workforce.create')) throw new ForbiddenException(existing ? '没有修改兼职与临时工档案的权限' : '没有创建兼职与临时工档案的权限');
  const service = requireResources();
  if (existing) {
    if (existing.archivedAt) await service.setWorkforceHistory(em, actor, existing.id, false);
    await service.updateRecord(em, actor, 'workforce', existing.id, values, '员工编辑：同步用工类型与合作期限');
  } else {
    await service.createRecord(em, actor, 'workforce', { userId: person.id, ...values, ...( /^1\d{10}$/.test(person.account ?? '') ? { phone: person.account } : {}) }, '员工编辑：自动补齐用工档案');
  }
}
