/**
 * 创建（或重置密码的）平台管理员。账号密码只从环境变量读取，没有默认值：
 *   PLATFORM_ADMIN_ACCOUNT=... PLATFORM_ADMIN_PASSWORD=... [PLATFORM_ADMIN_NAME=...] npm run db:platform-admin
 * 账号已存在则报错（不覆盖，避免误改）；要换密码请先停用旧账号再建新的。
 */
import 'reflect-metadata';
import * as bcrypt from 'bcryptjs';
import dataSource from '../database/data-source';
import { PlatformAdmin, User } from '../entities';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`缺少环境变量 ${name}`);
  return value;
}

async function main() {
  const account = required('PLATFORM_ADMIN_ACCOUNT').trim();
  const password = required('PLATFORM_ADMIN_PASSWORD');
  const name = (process.env.PLATFORM_ADMIN_NAME ?? '平台管理员').trim();
  if (password.length < 10) throw new Error('PLATFORM_ADMIN_PASSWORD 至少 10 位');
  await dataSource.initialize();
  try {
    if ((await dataSource.getRepository(User).findOne({ where: { account } })) || (await dataSource.getRepository(PlatformAdmin).findOne({ where: { account } }))) {
      throw new Error(`账号 ${account} 已被使用（账号全系统唯一）`);
    }
    await dataSource.getRepository(PlatformAdmin).save({ account, name, passwordHash: await bcrypt.hash(password, 10), status: 'active' as const, lastLoginAt: null });
    console.log(`已创建平台管理员 ${account}`);
  } finally {
    await dataSource.destroy();
  }
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
