/**
 * 初始化第一个公司：默认部门、示例岗位（含权限）、公司管理员。
 * 可重复执行：公司已存在则什么都不做，不会覆盖任何数据。
 * 管理员密码必须通过环境变量提供，不存在默认密码；首次登录会被要求修改。
 */
import 'reflect-metadata';
import * as bcrypt from 'bcryptjs';
import dataSource from '../database/data-source';
import { Company, PlatformAdmin, User } from '../entities';
import { provisionCompany } from '../org/company-provisioning';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`缺少环境变量 ${name}`);
  return value;
}

async function main() {
  const code = (process.env.SEED_COMPANY_CODE ?? 'demo').trim().toLowerCase();
  const companyName = process.env.SEED_COMPANY_NAME ?? '示例公司';
  const adminAccount = process.env.SEED_ADMIN_ACCOUNT ?? 'admin';
  const adminName = process.env.SEED_ADMIN_NAME ?? '系统管理员';
  const adminPassword = required('SEED_ADMIN_PASSWORD');
  if (adminPassword.length < 10) throw new Error('SEED_ADMIN_PASSWORD 至少 10 位');

  await dataSource.initialize();
  try {
    await dataSource.transaction(async (manager) => {
      if (await manager.findOne(Company, { where: { code } })) {
        console.log(`公司 ${code} 已存在，跳过`);
        return;
      }
      if ((await manager.findOne(User, { where: { account: adminAccount } })) || (await manager.findOne(PlatformAdmin, { where: { account: adminAccount } }))) {
        throw new Error(`账号 ${adminAccount} 已被使用（账号全系统唯一），请换一个 SEED_ADMIN_ACCOUNT`);
      }
      await provisionCompany(manager, {
        code,
        name: companyName,
        adminAccount,
        adminName,
        adminPasswordHash: await bcrypt.hash(adminPassword, 10),
        mustChangePassword: true,
      });
      console.log(`已创建公司 ${code}（${companyName}），管理员账号 ${adminAccount}，首次登录需修改密码`);
    });
  } finally {
    await dataSource.destroy();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
