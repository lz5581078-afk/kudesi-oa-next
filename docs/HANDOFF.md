# 交接说明（给接手搭建演示环境的人 / Codex）

> **目标：在用户自己的 Mac 上把项目跑起来，并且让它“常开”。** 之后 Claude 改代码，用户刷新浏览器就能看到，不需要每次重新架设。
> 先读 `CLAUDE.md`（开发约定）和 `README.md`，再按下面做。

## 0. 工作方式（最重要）
1. **一次性**：在 Mac 上选一个项目文件夹（建议 `~/Documents/kudesi-oa-next`），把代码放进去，跑 `bash scripts/local-test.sh`，之后让后端和网页一直开着。
2. **日常**：Claude 通过 Claude 桌面应用授权的“已连接文件夹”直接把改动写进这个文件夹；后端（ts-node-dev）和前端（vite）都会自动热更新，用户刷新浏览器即可看到。
3. **只有两种情况要动手**：
   - 改动里带了数据库迁移（`apps/api/src/database/migrations/` 有新文件）→ 在项目文件夹再跑一次 `bash scripts/local-test.sh`（幂等：只会补跑新迁移，数据保留，并重启两个服务）。
   - 改了 `packages/shared` → 脚本会重新构建 shared；手动的话运行 `npm run build:shared`，API 会自动重载。
4. **不要**因为更新就重装依赖、重建库、重新生成 `.env`。`.env`、`.local-test/`、数据库都是用户本机状态，覆盖代码时必须保留。
5. 若不用“已连接文件夹”：Claude 会发 zip，解压覆盖到同一文件夹即可（zip 不含 `.env`、`node_modules`、`dist`）。
6. 如果 Claude 要往用户 Mac 写文件，需要用户先在桌面应用里授权那个文件夹；Claude 会先发起授权请求，用户点同意。

## 1. 项目是什么
酷得斯 OA 的重写（旧代码只作功能参考，在 `docs/legacy-research/`）。React + TypeScript + NestJS + MySQL 8，npm workspaces：

| 目录 | 内容 |
|---|---|
| `packages/shared` | 导航/权限键（`navigation.ts` 唯一来源）、资料配置、财务单据规则、流程模板 |
| `apps/api` | NestJS 后端，端口 4000，路由前缀 `/api` |
| `apps/web` | React 前端（vite），端口 5173，`/api` 代理到 4000 |
| `apps/agent` | **店铺登录助手**（装在授权电脑上的 Node 程序，用本机 Chrome/Edge 登录店铺） |

已做：底座与权限、资料全部模块、财务板块（管家婆 A8 模式：基础资料/制单中心/单据中心/实时查询，13 种单据）、统一流程引擎（借用营业执照、费用申请）、任务中心、站内通知、店铺提现（登录管理 + 逐笔登记提现单 + 提现凭证）、Windows 助手。
未做：助手托盘、聚水潭同步（远程协助已做，见文末“远程协助”）、资料补齐（人员档案、职责组、费用模块、银行卡分类与资金概况）、成本历史页签、包装方案、快递价格 AI 导入、分区建议、API 密钥、主数据整体重置。详见 `docs/ROADMAP.md`。

## 2. 在 Mac 上搭演示环境（一次性）
前提：Node 20+（用户 Mac 是 Node 24，可以）。MySQL 二选一：**Docker Desktop**（最省事）或本机 MySQL 8。

```bash
cd <项目目录>
bash scripts/local-test.sh          # 一键：数据库 → .env → 迁移 → 种子 → 演示数据 → 启动后端+网页
bash scripts/local-test.sh status   # 看状态和登录信息
bash scripts/local-test.sh stop     # 停止（数据库保留）
# 之后每次需要“重启并补迁移”，也是再跑一次 bash scripts/local-test.sh
```
脚本行为：
- 没有 `.env` 时：有 Docker 就 `docker compose up -d mysql`（端口 3307，所有密码/密钥自动随机生成，写进 `.env`，权限 600）；没有 Docker 就转 `scripts/setup-local.sh`（要本机 MySQL 8 的 root 密码，**只在那一次运行里输入，不保存**）。
- 然后 `npm install`、构建 shared 和 agent、迁移、种子、启动 API(4000) 和 web(5173)，首次再灌两条演示数据（店铺“演示店铺”、银行账户“演示公户”）。
- 登录：公司代码 `demo`，账号 `admin`，初始密码在 `.env` 的 `SEED_ADMIN_PASSWORD`；首次登录要求改密码。

**验证状态（诚实说明）**：脚本的“已有 .env + 本机 MySQL”路径在 Linux 容器里用全新空库完整跑通过（迁移→种子→演示数据→API/Web 起来）。**Docker 路径、macOS、Apple Silicon 没有实测**——如果 `docker compose` 的健康检查或端口（3307）有问题，按 README“手动步骤”做即可。若 MySQL 是 Homebrew 装的，也可手动：建库 `kudesi_oa_next`、建用户，填 `.env`，然后 `npm run db:migrate && npm run db:seed && npm run dev:api` / `npm run dev:web`。

## 3. 演示时可以点的路径
1. 登录后菜单：工作台（待办/任务）、流程（发起申请/流程模板）、财务（基础资料、制单中心、单据中心、实时查询、经营财务→店铺提现）、资料各模块。
2. **店铺提现**（财务 → 经营财务 → 店铺提现）：
   - “授权电脑”→“生成绑定码”→ 在要登录店铺的电脑上运行助手：
     `npm run build -w @kudesi/agent && node apps/agent/dist/cli.js register --server http://127.0.0.1:4000 --code <绑定码> && node apps/agent/dist/cli.js run`
   - “店铺登录”→“添加店铺”选电脑 → “账号密码”填店铺账号密码 → “首次登录”：助手会打开 Chrome 窗口自动登录（遇到验证码人工完成）。
   - “登记提现”：填平台提现流水号、到账银行账户、金额；凭证可上传 / 粘贴截图 / “从店铺窗口截图”（助手截当前店铺页面）。**凭证存七牛**：演示要先在“系统 → 接口设置”填真实七牛配置，否则上传会报七牛错误（这是预期的）。
   - 真实平台（拼多多等）后台需要真账号；没有的话看下面的“假平台”。
3. 助手没有真实店铺账号时的自测：`KUDESI_CHROME=<chrome路径> npm run e2e -w @kudesi/agent`（起一个本机假商家后台，需要 API 在 4000 端口且 demo 管理员密码为 `Admin-Test-2026!`，只适用于开发库；正式演示不要用）。

## 4. 检查命令
```bash
npm run typecheck && npm run build
(cd packages/shared && npm test)
(cd apps/web && npx vitest run)
(cd apps/agent && npx vitest run)
(cd apps/api && RESOURCE_DB_TEST=1 TEST_DB_NAME=kudesi_oa_test npx jest)   # 需要一个专门的测试库
```
最近一次：shared 41、web 16、agent 8、api 97 个测试全部通过，构建通过。

## 5. 不能碰的约定（摘自 CLAUDE.md，接手必须遵守）
- 表结构只通过迁移改；`synchronize` 永远关闭；已执行的迁移不改。
- 导航/权限键只在 `packages/shared/src/navigation.ts` 定义；后端接口必须声明 `@Public/@AuthenticatedOnly/@RequirePermission`。
- 身份只信令牌；金额用整数分；成本/价格字段在服务端按权限裁剪。
- **不要使用、保存或输出任何真实的 MySQL root 密码**；`.env`、备份、密钥不进 Git；演示库只放演示数据。
- 外部系统（聚水潭等）默认只读；任何外部写入必须走出站队列 + 一键停止开关，并需用户明确授权。

## 6. 已知问题/风险
- 助手在 Windows 和真实平台后台上没有实测，只在 Linux Chromium + 假后台上测过；平台改版需改 `apps/agent/src/platforms.ts`。
- 助手“自动登录”的账号密码由服务器在领取请求时交付（密码加密存库，查看明文需 `finance.session.manage` 并写审计）。
- 单据过账有全公司锁；红冲后提现流水号仍占用，不可重复登记。
- 开发库（容器内）的七牛密钥是假的；MySQL 8.4 未验证。

## 7. 文件位置
- 代码：`kudesi-oa-next.zip`；Windows 助手安装包：`kudesi-assistant-windows.zip`（里面 `install.ps1`、`README.txt`）。
- 设计与蓝图：`docs/BLUEPRINT.md`、`docs/ROADMAP.md`；旧系统研究：`docs/legacy-research/01–04`。

## 8. 给接手者的待办清单
- [ ] 在 Mac 上放好项目文件夹，跑通 `bash scripts/local-test.sh`，确认 http://localhost:5173 能登录。
- [ ] 如果脚本在 Docker / macOS 上有问题，修脚本并在本文件第 2 节记录差异（这部分没有实测过）。
- [ ] 让服务“常开”：可选，用 `launchd` 或 pm2 在登录后自动运行 `npm run start:dev`（apps/api）和 `npm run dev`（apps/web）；不做也行，用户手动跑脚本即可。
- [ ] 告诉用户项目文件夹的绝对路径，以便 Claude 申请该文件夹的访问授权。
- [ ] 不要改业务代码；发现业务 bug 记到本文件末尾，交给 Claude 修。

## 本轮补充（资料对齐旧程序）
- 迁移新增：1730001100000 单据结算、1730001200000 数据工具、1730001300000 外发队列；拉取更新后必须运行 `bash scripts/local-test.sh`。
- 资料菜单照旧程序「资料」导航：组织与人员（职责组；组织架构、人员档案在「组织」一级菜单里）/ 经营资料 / 账号与资质 / 银行卡（资金概况 + 五个类型入口）/ 公司资产。银行卡五个入口是同一份银行账户资料按类型分页（`RESOURCE_VIEWS`），权限共用 `resource.bank-accounts.*`。
- 店铺经营数据、推广、评分、资金是每个店铺下的子记录，只在店铺详情里维护（nav.hidden），不单独占菜单。
- 费用模块 = 集中维护手机号子卡费用和宽带费用，写回手机号 / 宽带档案，不另存数据。
- 规则：印章联动；银行预留手机号自动关联手机号档案；银行账户按账号唯一、开户行必填；执照自动建档电商建店铺公户/个人卡、经营建公司公户/银行卡，同账号同名法人复用；手机号保管人二选一；档案编号唯一；部门可改上级/排序（防成环）；员工停用必须填原因。
- 审计日志页（system.audit）：系统操作 + 资料变更合并只读。
- 外发队列：默认开关关闭、发送器未配置，不会向聚水潭真实写入。
- 仍未做（来自旧程序对照）：导入前自动备份与恢复；执照位置引用「房间与档案位置」、使用记录、执照内关联工作台；合作人 / 自媒体 / 微信多对多关联；自媒体平台专属字段；手机号异常原因库；固定资产自定义编号 / 分类参数联动；档案关联店铺；公司店铺维护页（第二个会话工作区）；员工停用交接；部门停用与转移式删除；岗位停用与职责明细；资金概况口径是手工登记余额。

### 第三批（资料对齐旧程序）已完成
- 营业执照：正本/副本/印章/KT板位置改为"房间与档案位置"引用，保存时自动联动；新增"使用记录"子表；照片改为正本照片/副本照片。
- 导入：每次正式导入前自动备份（每公司每类型保留最近 5 份），可一键还原（迁移 1730001400000）。
- 仍未做：多值关联、自媒体平台字段、公司店铺维护页、员工停用交接、岗位档案等（见上一节清单）。

## 第四批（组织模块对齐旧程序）已完成
- 组织页面并入「资料 > 组织与人员」：部门与岗位 / 员工与权限 / 岗位档案 / 职责组；一级菜单改为 5 个，权限键 org.structure.* / org.staff.* 不变（目录里单独列出查看权限）。
- 部门：停用/启用（带原因）、删除时选接收部门整体转移。
- 岗位：层级、上级岗位、说明、停用；岗位档案页（5 类条目、在岗人员、权限摘要、变更记录）。
- 员工：直属上级、职称、底薪（需 org.staff.salary，分为单位）；停用时预览并交接待办/周期任务/流程步骤。
- 迁移：1730001500000-ManualLinks、1730001600000-OrgProfile。
- 员工多岗位：users.extra_position_ids（迁移 1730001700000），主岗位决定工作台，权限取并集；人数/删除/停用/流程指定岗位都算兼任。
- 固定资产列表按分类筛选（def.filterBy）；税务资料「待生成」弹窗按执照一键生成。
- 未做：无（已知的小项：银行资金概况余额仍为手工登记）。
- 测试：API 18 套 128 项、shared 44、web 16 全过，三端 tsc 通过。

## 财务板块 1:1 复刻（本轮）
- 页面内标签页：`PAGE_TABS`（navigation.ts）+ `TabHost`；财务菜单只留旧系统有的页面。
- 通用列表：多条件筛选（`filterBy` 数组，分类含下级）、批量改字段/状态（`batch`，POST /resources/:type/batch、batch-status）、复制新建；新字段类型 `refs`（多选引用）、`select.multi`。
- 基础资料：商品系统规格算重量/多供货来源/OEM 汇总/人工行；供应商、客户 3 级分类+多分类+自动编号（GYS-/KH-）；费用档案挂账节点多选、FY- 自动编号。
- 数据：成本表（分类树、维护售价、乐观锁、微百分比精度）、定价调试表重做、人力成本（版本/字典/分类树）、快递价格（公司→网点→版本→矩阵、预估运费一览、分区建议记录），成本表运费改用同一套快递引擎（express-engine.ts）。
- 聚水潭分类：基础编码/组合编码核对验证、命名中心、修订、删除/归档任务、马甲、资料维护上传（只入出站队列）、API 密钥新增 company_catalog_read 用途。
- 经营财务：主体/店铺/来源列、经营历程筛选与汇总、现金银行查询重写（重点账户）、授权电脑升级调度、流程自动记账改为模板声明（FlowTemplate.posting）。
- 未做：期初预付登记、远程协助、助手端自更新。新迁移：1730003000000、1730004000000。
- 提示：CLAUDE.md 第 7 条金额精度写的是“万分比”，成本表利润率现用百万分比，需改文字。

## SKU 批量申请流程（已做）
- 流程模板 `sku-batch-apply`（申请中心发起）：运营申请 → 仓库完善 → 财务审核 → 结束；办理人在“流程配置”里指定后发布。没有新增菜单页，规格明细显示在流程详情里，组合编码详情有只读字段“来自申请单”。
- 运营填销售场景、销售平台、规格清单（主商品+赠品，一张最多 100 个规格）；仓库逐规格补包装/标签说明书/其他材料/人工，四类每类要么选好要么写“不需要”的原因；财务勾选“已核对”后，同一事务里按规格×平台调用批量生成服务建组合编码并验证，任一步失败整体回滚。
- 财务办理人需有“商品组合编码”新增+修改权限；勾选“加入聚水潭同步队列”还需 `finance.jst-sync.view`，事务提交后只入出站队列（总开关与发送器不变，默认不会真的发送）。
- 仓库提交后若商品/成本/编码变了，财务不能直接通过，须退回仓库重新确认。编码只由主品、赠品、平台、场景决定，包装/标签/人工不同但编码相同的组合会被拦下（不能覆盖）。
- 未做：规格独立流转（现为整张申请一起流转）、历史仓库配置复用、数量系列批量生成、飞书通知（仍是站内通知）。无新迁移。

## 助手端自动更新（本轮）
- 迁移 1730007000000（agent_releases、session_devices.update_error）；新接口：`GET/POST /api/session/agent-releases`、`POST .../:id/withdraw`（需 finance.session.manage）、助手端 `GET /api/agent/release/download?version=`、`POST /api/agent/update/report`（设备令牌）。
- 打包：`npm run pack -w @kudesi/agent` 产出 `apps/agent/release/update/*.kapkg(.sha256, latest.json)` 和 `kudesi-assistant-windows(.zip)`；助手版本升到 1.1.0（`version.ts` 与 `package.json` 必须一致，pack 会检查）。
- 安装目录改为 `app\launcher.js + app\versions\<版本>`；install.ps1 已改。Windows 上未实测的部分见交付报告：计划任务、文件占用、杀进程、npm install。

## 远程协助（本轮）
- 新迁移 1730006000000-RemoteAssist（3 张表）；接口 `/api/session/remote/*`（网页）和 `/api/agent/remote/*`（助手）；新权限 `finance.session.remote`（权限目录里“店铺提现：发起远程协助”）。设计与规则见 `docs/BLUEPRINT.md` 最后一节。
- 默认关闭：管理员在“授权电脑”页逐台开启，电脑主人在本机 `cli.js remote prompt|auto`（默认 off）。服务器环境变量 `KUDESI_REMOTE_ASSIST_DISABLED=1` 或页面“紧急停止”可立即全部停止。
- 配置：同一内网不用配；跨网配 `WEBRTC_STUN_URLS` / `WEBRTC_TURN_URLS` / `WEBRTC_TURN_SHARED_SECRET`（见 `.env.example`）。
- **需要在真实 Windows 电脑上验证**：① `windowsConsentPrompt`（PowerShell 弹窗）；② 有界面的 Chrome（非无头）下的画面采集和点击/拖动/输入；③ 跨网（NAT/TURN）下的连通与画质；④ 拼多多真实后台的滑块在 CDP 输入下是否通过（平台可能识别自动化输入）；⑤ 助手“自动更新”和远程协助同时发生时的行为（远程协助进行中不会升级）。Linux 沙箱里已用真实 Chromium + 真实 WebRTC + 真实 OA 接口跑通（`apps/agent/scripts/e2e-remote.cjs`）。
