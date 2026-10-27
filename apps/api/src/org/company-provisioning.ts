/**
 * 开通一家新公司：默认部门、示例岗位（含权限）、默认销售平台/场景、公司管理员。
 * 种子脚本（第一家公司）和平台后台“通过申请”共用这一份，保证两条路径开出来的公司一样。
 */
import { FINANCE_RESOURCE_DEFS } from '@kudesi/shared';
import { EntityManager } from 'typeorm';
import { Company, Department, Position, PositionPermission, ResourceRecord, User, WorkspaceType } from '../entities';

export const DEFAULT_DEPARTMENTS = ['管理层', '综合', '财务', '运营', '仓库', '采购', '客服'];

/** 财务资料（不含子表）：财务岗位整体管理，运营/仓库只给需要的 */
const FINANCE_KEYS = FINANCE_RESOURCE_DEFS.filter((d) => !d.parent).map((d) => d.key);
const rw = (...keys: string[]) => keys.flatMap((k) => [`resource.${k}.view`, `resource.${k}.create`, `resource.${k}.edit`]);
const ro = (...keys: string[]) => keys.map((k) => `resource.${k}.view`);

export const DEFAULT_POSITIONS: Array<{ name: string; workspaceType: WorkspaceType; permissions: string[] }> = [
  { name: '老板', workspaceType: 'boss', permissions: ['*'] },
  {
    name: '运营专员',
    workspaceType: 'operations',
    // 运营不含 product.cost.view / product.price.view：看不到成本和价格（服务端按字段隐藏）
    permissions: [
      'workbench.todos.view',
      'workbench.home.view',
      'workbench.desk.view',
      'workbench.personal.view',
      'flow.apply.view',
      'workbench.tasks.view',
      'workbench.started.view',
      'workbench.cc.view',
      // 资料：能看店铺和手机号，能改店铺；看不到密码，也不能停用/删除
      'resource.stores.view',
      'resource.stores.edit',
      'resource.phones.view',
      // 财务：建商品档案和编码、组合；能做网店销售单草稿
      ...rw('finance-products', 'finance-base-codes', 'finance-bundles'),
      ...ro('finance-categories', 'finance-brands', 'finance-platforms', 'finance-scenarios', 'finance-customers', 'finance-warehouses'),
      'finance.doc-online-sale.view',
      'finance.docs.create',
    ],
  },
  {
    name: '财务',
    workspaceType: 'finance',
    permissions: [
      'workbench.todos.view',
      'workbench.home.view',
      'workbench.desk.view',
      'workbench.personal.view',
      'flow.apply.view',
      'workbench.tasks.view',
      'workbench.started.view',
      'workbench.cc.view',
      'product.cost.view',
      'product.cost.edit',
      'product.price.view',
      // 财务板块全部页面、全部单据操作、全部财务资料
      'finance.*',
      ...FINANCE_KEYS.map((k) => `resource.${k}.*`),
      // 资料：财务管理银行账户、税务；只读营业执照
      'resource.bank-accounts.*',
      'resource.tax-profiles.*',
      'resource.licenses.view',
    ],
  },
  {
    name: '仓库专员',
    workspaceType: 'warehouse',
    permissions: [
      'workbench.todos.view',
      'workbench.home.view',
      'workbench.desk.view',
      'workbench.personal.view',
      'flow.apply.view',
      'workbench.tasks.view',
      'workbench.cc.view',
      ...ro('finance-products', 'finance-warehouses', 'finance-suppliers'),
      'finance.inventory.view',
      'finance.doc-purchase-in.view',
      'finance.docs.create',
    ],
  },
];

export const DEFAULT_PLATFORMS = [['TB', '淘宝'], ['DY', '抖音'], ['KS', '快手'], ['PDD', '拼多多'], ['GENERAL', '通用']];
export const DEFAULT_SCENARIOS = [['standard', '标准', ''], ['supply_chain', '供应链', 'GYL']];

export interface ProvisionInput {
  code: string;
  name: string;
  adminAccount: string;
  adminName: string;
  adminPasswordHash: string;
  /** 种子用的管理员首次登录要改密码；申请人自己设的密码不用 */
  mustChangePassword: boolean;
}

export async function provisionCompany(manager: EntityManager, input: ProvisionInput): Promise<Company> {
  const company = await manager.save(manager.create(Company, { code: input.code, name: input.name, status: 'active' }));
  for (const [index, name] of DEFAULT_DEPARTMENTS.entries()) {
    await manager.save(manager.create(Department, { companyId: company.id, parentId: null, name, sortOrder: index }));
  }
  for (const [index, item] of DEFAULT_POSITIONS.entries()) {
    const position = await manager.save(
      manager.create(Position, { companyId: company.id, departmentId: null, name: item.name, workspaceType: item.workspaceType, sortOrder: index }),
    );
    for (const permission of item.permissions) {
      await manager.save(manager.create(PositionPermission, { positionId: position.id, permission }));
    }
  }
  await manager.save(
    manager.create(User, {
      companyId: company.id,
      account: input.adminAccount,
      passwordHash: input.adminPasswordHash,
      name: input.adminName,
      departmentId: null,
      positionId: null,
      isCompanyAdmin: true,
      status: 'active',
      mustChangePassword: input.mustChangePassword,
    }),
  );
  // 财务资料的默认销售平台、销售场景（之后可在“资料维护”里增删）
  const rec = (type: string, title: string, code: string, data: Record<string, unknown>) =>
    manager.save(manager.create(ResourceRecord, { companyId: company.id, type, title, uniqueKey: code.toLowerCase(), status: 'active', statusReason: null, searchText: `${title} ${code}`.toLowerCase(), data }));
  for (const [pcode, name] of DEFAULT_PLATFORMS) await rec('finance-platforms', name, pcode, { code: pcode, name });
  for (const [scode, name, segment] of DEFAULT_SCENARIOS) await rec('finance-scenarios', name, scode, { code: scode, name, segment });
  return company;
}
