# 交给 Codex 的任务清单

给 Codex 的话：先读仓库根目录的 `AGENTS.md` 和 `CLAUDE.md`，再读 `docs/协作/任务板.md`。下面每个任务认领一个、做完一个，再领下一个。每个任务都在自己的分支上做（`bash scripts/collab/start-task.sh <简称>`），PR 目标是 `integration`。

旧系统源码只是功能参考，**不要复制代码，也不要加旧系统没有的页面**。旧系统不在本仓库里；需要对照时向用户要，或先按下面的说明和新系统已有的做法实现，并在 PR 里写明哪些点没法对照。

## 开发环境

- Node 20+，MySQL 8（时区必须是 `+08:00`，字符集 utf8mb4）。`.env.example` 里是变量名，密码自己设本地的，不要提交 `.env`。
- API 的数据库测试：先建两个库（开发库和 `kudesi_oa_test`），然后
  `RESOURCE_DB_TEST=1 TEST_DB_NAME=kudesi_oa_test npm test -w @kudesi/api`
- 其他检查：`npm run typecheck`、`npm test`、`npm run build`。共用代码在 `packages/shared`，改完要先 `npm run build:shared`，API 和前端是对着它的编译结果检查的。
- 资料（商品、供应商、费用档案等）是通用资料引擎：在 `packages/shared/src/resources.ts`、`finance-resources.ts` 加字段定义，规则写在 `apps/api/src/resources/finance-rules.ts`。不要给单个资料另写页面或接口。改字段不需要迁移，改表结构才要迁移。
- 财务测试里建商品要带：`purchaseSpec`、品牌（自制/采购/OEM 包装必填）、运费、装卸费，零值要按"运费：原因"的逐行格式写原因。照 `apps/api/src/resources/finance.db.spec.ts` 的写法抄。

## 任务（按建议顺序）

### 1. 期初预付登记
- 是什么：上线前已经付给供应商、但系统里还没有记录的预付款，要能补登记成"供应商预付余额"，之后采购可以抵扣。**登记时不能再扣一次银行余额**（钱早就付出去了）。
- 做法：在经营历程里打开一张"供应商预付款"手工单据（状态已开立、还没过账），单据详情里增加"登记已有预付款余额"：必填核对说明（≤500 字）和至少一个凭证附件，勾选确认后入账。入账后单据变成已过账，余额可在采购单里抵扣。
- 入账分录：预付款科目增加该金额，同时用一个"期初"科目冲平，**不动任何银行/现金账户**。
- 要求：权限单独检查；同一张单据只能登记一次；金额必须大于 0；已过账或非手工来源的单据拒绝；写审计记录；测试要覆盖"银行余额不变"和各种拒绝。
- 代码位置参考：`apps/api/src/resources/finance-documents.service.ts`（过账和分录）、`apps/web/src/pages/finance/DocDetail.tsx`。

### 2. 收款码、商品图片的手机扫码上传
- 是什么：电脑上打开供应商/客户档案（收款码字段）或商品档案（图片字段）时，点"手机上传"出现二维码，手机扫码打开一个临时页面，拍照或选图上传，图片自动出现在电脑上那条记录里。
- 做法：服务端发一个短期有效、一次一用途的上传令牌（绑定公司、资料类型、记录或字段、发起人，几分钟过期，限制次数和文件大小/类型）；手机页面是免登录的极简页面，只能用这个令牌上传到指定字段；电脑端轮询或定时刷新看到新图。上传的文件走现有文件服务（`FilesService`），记操作日志。
- 要求：令牌不可猜、过期失效、不能跨公司、不能用来读东西；加测试（过期、重复使用、类型不对、跨公司）。
- 前端入口在文件字段的组件里（`apps/web/src/resources/RecordForm.tsx` 里的 `FilesInput`），只对声明了允许手机上传的字段显示。

### 3. 商品档案的几个小功能
- 成本明细行：采购价、运费、装卸费能记多行，每行有生效日期，列表和成本取"当前生效"的；保留运费历史可查。
- 相似提示：新建时名称、规格和已有商品很像，弹出提示让人确认不是重复建档（可跳过）。
- "保存并继续新建"和"存为草稿"。
- 分类编码重复的提示、"无效商品"提示文案改成"改为停用"。
- 供应商/客户/费用档案的批量导入（xlsx）沿用现有 `ImportDialog`。

### 4. 聚水潭分类的几个收尾
- 商品分类目录的拖拽排序。
- 改了组合命名规则后，提供"按新规则批量重生成编码"（要预览、要确认原因，不能自动改）。
- 基础编码列表：真实编码有马甲时的显示规则（真实编码行隐藏或合并，马甲只在详情看）。
- 商品档案的"单位"可以按旧系统导入（现在是固定下拉）。

### 5. 小项
- 人力成本单价支持小数点后第三位（现在金额是整数分，需要评估是否改成"厘"单位，先在 PR 里写方案，别直接改全局金额规则）。
- 现金银行查询增加"账号"列（新库账户没有这个字段，需要加字段，注意敏感信息按现有加密规则处理）。
- 授权电脑增加备注字段。
- 经营财务各列表的日期筛选默认今天（旧系统行为）。

### 6. SKU 批量申请的补充
- 历史仓库配置复用（申请时可以从历史申请里带入包装、标签等配置）。
- "数量系列"：一次按数量序列生成多个规格。
- 飞书通知（走现有通知通道，先看 `apps/api/src/flow` 里的通知实现）。
- 规格独立流转目前没做（流程引擎是线性的），**先写设计方案放进 PR 描述再动手**，不要直接改引擎。

## 不要做（需要 Windows 真机或用户决定）

- 助手 .exe 安装包、更新包签名、远程协助的 Windows 真机验证、WebRTC 跨网络调通：这些必须在 Windows 电脑上验证，由用户安排。
- 外部系统（聚水潭等）的真实写入：一律只入出站队列，不要接真实接口。

## 提 PR 前自检

1. `npm run typecheck`、`npm test`、`npm run build` 全部通过，新功能要有测试（含权限拒绝、跨公司隔离、错误路径）。
2. 在 `docs/协作/任务板.md` 里把任务状态改成"待合并"，写清改了哪些共用热点文件、用了哪个迁移编号。
3. 在 PR 描述里写：做了什么、没做什么和原因、需要用户在真机或浏览器里确认的点。

---

## 任务：做成“Claude 也能用”的一键部署（优先）

背景：lc.kudesi.com 的服务器登录权限只在 Codex 这边，Claude 没有。要求把部署做成**推送代码即可触发**，这样任何窗口（含 Claude）不用拿服务器密码也能发布。

做法（建议，可换更合适的）：
1. 新增 `.github/workflows/deploy.yml`：推送到 `main`（或手动触发）时，在 CI 里执行 `npm ci`、`typecheck`、`test`、`build`，打包发布目录（同 `deploy/server/README.md` 的第 1 步），用 SSH 上传到服务器 `/srv/kudesi-lc/releases/<日期-序号>/`，再在服务器上执行发布脚本。
2. 新增 `deploy/server/release.sh`（放服务器端，由 CI 调用）：发布前备份 `current` 指向和数据库 → 构建镜像 → **只在发布包里带有新迁移且已备份时才执行迁移**（遵守 README“已有业务库禁止自动运行迁移”，本次这个版本没有新迁移）→ 切换 `current` → `up -d --wait api` → 检查网页/API 健康 → 失败自动回滚到上一个版本并让 CI 报红。不覆盖 shared 里任何配置，不执行 `down -v`。
3. 服务器 SSH 私钥、主机、用户只放 GitHub 仓库的 Secrets（`DEPLOY_HOST`、`DEPLOY_USER`、`DEPLOY_SSH_KEY`，建议用只能执行发布脚本的专用受限账号），**不进 Git，不要发给 Claude**。需要用户在 GitHub 设置里添加 Secrets，请在完成时告诉用户具体要加哪几个。
4. 把 `feat/server-deploy` 里已有的内容保留（已合进 integration）；在 `deploy/server/README.md` 补“如何触发发布、如何看结果、如何回滚”。
5. 完成后更新任务板，并在这里写明：触发方式、看结果的地方、回滚命令。

验收：在 integration 合并到 main 之后，不需要任何人登录服务器，lc.kudesi.com 自动更新到新版本，并能用 `https://lc.kudesi.com/api/health` 验证。

首次使用的新版本内容：登录页重做（不再沿用旧样式）、站名统一为“小白全流程系统”，无新数据库迁移。


### 一键部署实现记录（2026-10-26，Codex）

- 触发：工作流合入 main 后，push/main 自动发布；Actions 的 Deploy lc.kudesi.com 可在 main 手动 action=deploy。integration 不发布。
- 查看：GitHub Actions 的 Deploy lc.kudesi.com，以及 https://lc.kudesi.com/api/health 和 /release.json（发布编号、Git SHA）。
- 回滚：Actions 手动 action=rollback + release_id；管理员可用 `sudo /usr/local/sbin/kudesi-lc-command rollback <发布编号>`。恢复程序版本，不自动覆盖业务数据库；备份与日志保留。
- Secrets：DEPLOY_HOST、DEPLOY_USER、DEPLOY_SSH_KEY、DEPLOY_KNOWN_HOSTS 已加密配置在 GitHub，未在聊天、代码或文档展示私钥。服务器专用账号 lcdeploy 仅能调用固定发布控制器。
- 完整运维说明与验证边界见 deploy/server/README.md；本次不合并 main，不提前切换生产应用，等待用户合并 main 触发首次真实发布。
