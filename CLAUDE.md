# 开发约定（给 Claude 和开发者）

这是旧版酷得斯 OA 的重写。旧系统的功能和业务规则见 `docs/legacy-research/`，只作功能参考，不复用旧代码。
动手前先读 `docs/ROADMAP.md`。

## 必须遵守

1. **MySQL 8 是唯一业务数据库**。表结构只通过迁移修改，`synchronize` 永远关闭；已执行的迁移不要改，新增迁移。
   迁移只改结构，种子数据放 `apps/api/src/scripts/seed.ts`，不混进迁移，也不在启动时隐式建表。
2. **导航、路由、权限键只在 `packages/shared/src/navigation.ts` 定义一次**。前端菜单、路由守卫、后端权限键都从它派生。
   新页面做完才把 `ready` 改成 `true`，不要把占位页留在菜单里。
3. **后端接口默认拒绝**：每个路由必须声明 `@Public()`、`@AuthenticatedOnly()` 或 `@RequirePermission(...)`，漏写返回 403。
4. **身份只信令牌**：`companyId`、操作人只取自登录令牌（`@CurrentUser()`），绝不读请求体、查询参数。DTO 用白名单，多余字段拒绝。
   所有业务表带 `company_id`，所有查询带公司条件；跨表引用要校验属于同一家公司。
5. **敏感信息**：证件号、银行卡、店铺密钥等用 `CryptoService`（AES-256-GCM，密钥来自环境）加密存储，对有查看权限的人明文显示（资料页不做脱敏，靠权限控制），
   密码类字段永不返回，查看明文需专门权限并写审计。没有默认密钥、没有默认密码。
6. **成本和价格服务端脱敏**：没有 `product.cost.view` / `product.price.view` 的人，接口就不返回这些字段，不是前端隐藏。
7. **金额用整数分，利润率用整数百万分比（1% = 1,000,000，保留 6 位小数精度）**，公式放 `packages/shared/src/pricing.ts`，改公式必须同步改测试。
8. **岗位类型是显式字段**（`positions.workspace_type`），不要用名称正则判断运营、财务、仓库。
9. **一个功能只留一个版本**：不要出现 V2、V3、V5 并存。单个页面文件过大就拆组件。
10. 业务流程全部走统一流程引擎，不在业务模块里写死审批人和流转顺序。

## 资料模块

- 新增一种资料：只在 `packages/shared/src/resources.ts` 加配置（会自动出现在菜单、权限、导入导出里），需要特殊规则再写进 `resource-rules.ts`。不要为单个资料另写页面或接口。
- 资料接口只走 `/api/resources/:type`，权限用 `@RequireResourceAction(...)`，不要自己拼权限键。
- 改资料配置里的字段不需要迁移（字段值在 JSON 里）；改表结构才需要新增迁移。

## 数据与外部系统

- 本地只连隔离的开发库，不连旧系统的生产库；聚水潭等外部系统默认只读，任何真实写入必须有明确授权。
- 外部写入统一走出站队列（outbox）+ 单一 worker，并提供“一键停止所有外部写入”的开关（旧系统缺这个）。
- `.env`、备份、附件、密钥不进 Git，也不要输出明文。

## 店铺登录助手（apps/agent）

- 登录状态（Cookie/Profile）只留在授权电脑本机，服务器只存加密的店铺账号密码；助手回报的文字必须抹掉密码。
- 助手只允许在平台自己的域名里操作（`platforms.ts` 白名单）；新增平台只改这一个文件，并补测试。
- 助手与服务器只走 `/api/agent/*`（设备令牌），不读取员工登录信息；`KUDESI_AGENT_TEST_URL` 只给自动化测试用。
- 端到端：`KUDESI_CHROME=<chrome路径> npm run e2e -w @kudesi/agent`（需要 API 在 4000 端口）。

## 常用命令

`npm run typecheck` · `npm test` · `npm run build` · `npm run db:migrate` · `npm run db:seed`
