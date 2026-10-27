import { EntityManager, In } from 'typeorm';
import { WAREHOUSE_PRODUCT_FIELDS, createChecker } from '@kudesi/shared';
import { AuthUser } from '../common/auth.decorators';
import { Position, User } from '../entities';

/**
 * 仓库角色模式（旧 WarehouseProductArchives + product-archive-access.js）：
 * 岗位类型（positions.workspace_type，显式字段）是仓库、且没有商品档案“修改”权限的人，
 * 商品档案只给精简列、只读，看不到日志、关联和价格备注；仍可上传商品照片。
 * 成本/价格仍由字段权限（product.cost.view / product.price.view）在服务端脱敏。
 */
export { WAREHOUSE_PRODUCT_FIELDS };

export async function isWarehouseMode(em: EntityManager, user: AuthUser): Promise<boolean> {
  if (user.permissions.isCompanyAdmin) return false;
  const can = createChecker(user.permissions);
  if (can('resource.finance-products.edit') || can('resource.finance-products.create')) return false;
  const row = await em.findOne(User, { where: { id: user.id, companyId: user.companyId }, select: ['id', 'positionId', 'extraPositionIds'] });
  const ids = [row?.positionId, ...(row?.extraPositionIds ?? [])].filter((x): x is number => !!x);
  if (!ids.length) return false;
  const rows = await em.find(Position, { where: { companyId: user.companyId, id: In(ids), status: 'active' }, select: ['id', 'workspaceType'] });
  return rows.some((p) => p.workspaceType === 'warehouse');
}

/** 仓库角色模式下，允许上传商品档案的照片（有商品档案查看权限即可） */
export async function canWarehouseUploadPhotos(em: EntityManager, user: AuthUser, type: string, fieldKey: string): Promise<boolean> {
  if (type !== 'finance-products' || fieldKey !== 'photos') return false;
  if (!createChecker(user.permissions)('resource.finance-products.view')) return false;
  return isWarehouseMode(em, user);
}
