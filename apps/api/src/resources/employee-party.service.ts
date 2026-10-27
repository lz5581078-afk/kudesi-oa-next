import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { createChecker } from '@kudesi/shared';
import { AuthUser } from '../common/auth.decorators';
import { ResourceRecord, User } from '../entities';
import { ResourcesService } from './resources.service';

/** 员工作为往来对象：给公司里每个在职员工建一条“员工往来”资料（单据里的往来对象 id 都是资料 id，账也按它记）。已有的不重复建，离职的置为停用。 */
@Injectable()
export class EmployeePartyService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource, private readonly resources: ResourcesService) {}

  async sync(user: AuthUser) {
    if (!createChecker(user.permissions)('finance.docs.create')) throw new ForbiddenException('没有制单权限');
    return this.dataSource.transaction(async (em) => {
      const users = await em.find(User, { where: { companyId: user.companyId }, select: ['id', 'name', 'status'] });
      const parties = await em.find(ResourceRecord, { where: { companyId: user.companyId, type: 'finance-employee-parties' }, select: ['id', 'status', 'data'] });
      const byUser = new Map(parties.map((p) => [Number(p.data.userId), p]));
      let created = 0;
      for (const u of users) {
        const have = byUser.get(u.id);
        if (!have && u.status === 'active') {
          await this.resources.createRecord(em, user, 'finance-employee-parties', { name: u.name, userId: u.id }, '开单时同步员工');
          created++;
        } else if (have && u.status === 'active' && have.status === 'inactive') {
          await this.resources.setStatusChecked(em, user, 'finance-employee-parties', have.id, 'active', '员工恢复在职');
        }
      }
      return { created };
    });
  }
}
