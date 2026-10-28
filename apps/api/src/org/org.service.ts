import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditLog, Department, User } from '../entities';
import { AuthUser } from '../common/auth.decorators';

export interface DepartmentNode {
  id: number;
  name: string;
  sortOrder: number;
  status: 'active' | 'inactive';
  /** 部门主管（员工 id） */
  managerId: number | null;
  children: DepartmentNode[];
}

/** 把平铺的部门列表组装成树；父节点不在列表里的当作根（防御脏数据）。 */
export function buildDepartmentTree(rows: (Pick<Department, 'id' | 'parentId' | 'name' | 'sortOrder'> & { status?: 'active' | 'inactive'; managerId?: number | null })[]): DepartmentNode[] {
  const nodes = new Map<number, DepartmentNode>();
  for (const row of rows) {
    nodes.set(row.id, { id: row.id, name: row.name, sortOrder: row.sortOrder, status: row.status ?? 'active', managerId: row.managerId ?? null, children: [] });
  }
  const roots: DepartmentNode[] = [];
  for (const row of rows) {
    const node = nodes.get(row.id)!;
    const parent = row.parentId ? nodes.get(row.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const sort = (list: DepartmentNode[]) => {
    list.sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
    list.forEach((item) => sort(item.children));
  };
  sort(roots);
  return roots;
}

@Injectable()
export class OrgService {
  constructor(
    @InjectRepository(Department) private readonly departments: Repository<Department>,
    @InjectRepository(AuditLog) private readonly audits: Repository<AuditLog>,
    @InjectRepository(User) private readonly users: Repository<User>,
  ) {}

  async directory(user: AuthUser): Promise<Array<{ id: number; name: string; active: boolean }>> {
    const rows = await this.users.find({ where: { companyId: user.companyId }, select: ['id', 'name', 'status'], order: { name: 'ASC' } });
    return rows.map((u) => ({ id: u.id, name: u.name, active: u.status === 'active' }));
  }

  /** 部门通讯录（只含 id/名称），资料页的“选择部门”要用 */
  async departmentDirectory(user: AuthUser): Promise<Array<{ id: number; name: string; parentId: number | null }>> {
    const rows = await this.departments.find({ where: { companyId: user.companyId, isSystem: false }, select: ['id', 'name', 'parentId'], order: { sortOrder: 'ASC', id: 'ASC' } });
    return rows.map((d) => ({ id: d.id, name: d.name, parentId: d.parentId }));
  }

  /** 所有查询都带 companyId，且 companyId 只取自登录人，不取自请求参数。 */
  async departmentTree(actor: AuthUser): Promise<DepartmentNode[]> {
    const rows = await this.departments.find({ where: { companyId: actor.companyId, isSystem: false } });
    return buildDepartmentTree(rows);
  }

  async createDepartment(actor: AuthUser, input: { name: string; parentId: number | null }): Promise<Department> {
    if (input.parentId !== null) {
      // 父部门必须属于同一家公司，防止跨公司挂靠
      const parent = await this.departments.findOne({ where: { id: input.parentId, companyId: actor.companyId } });
      if (!parent) throw new BadRequestException('上级部门不存在');
    }
    const saved = await this.departments.save(
      this.departments.create({
        companyId: actor.companyId,
        parentId: input.parentId,
        name: input.name.trim(),
        sortOrder: 0,
      }),
    );
    await this.audits.save(
      this.audits.create({
        companyId: actor.companyId,
        actorId: actor.id,
        action: 'department.create',
        resourceType: 'department',
        resourceId: String(saved.id),
        detail: { name: saved.name, parentId: saved.parentId },
      }),
    );
    return saved;
  }
}
