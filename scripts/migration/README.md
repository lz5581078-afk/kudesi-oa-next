# 只读迁移评估

此目录用于按新系统字段检查旧资料来源，不提供生产导入命令。实际公司、数量、账号、附件和异常 ID 报告只保存在私有工作目录，不提交 Git。旧生产库只读。

## 输出含义

- `mapping-rules.json` 为候选映射规则。找到同名列或 JSON 路径，仅说明结构上存在来源，不证明业务语义、枚举、金额单位或记录可导入。
- `@derive` / `@transform` / `@parent` / `@effective` 表示待实现转换；`@review` 表示口径尚未明确。这些标记不是可执行表达式。
- `inspect-legacy.cjs` 在旧服务器内加载原应用已有环境配置，执行只读事务后回滚；按公司或已核实的父记录链筛选。没有可靠公司归属的表不读取记录。仅导出结构、汇总、异常 ID、文件存在与摘要结果，不导出业务字段值或账号凭据。
- 字段长度检查不代表完整值校验。JSON 路径的 observations 只是出现次数，未出现的属性不会计入 empty。无数组路径且结构未截断时计 0；容器 SQL 行数不冒充资料条数。截断或无可靠计数的项目必须复核。
- 附件检查仅覆盖 `resource_media` 的已知本地目录，不能代替商品图片、内嵌附件、收款码的全面盘点。
- `compatibleLegacyRecords` 只统计旧哈希/盐长度符合预期的记录；未实际验证密码，也没有实现兼容登录。禁止将此指标理解为已能登录。

`product-mapping.cjs` 是商品档案相关的纯转换（旧单位表→“单位与规格”列表、档案单位名称→编码、多行商品关联→多构成基础编码），由适配器调用，测试见 `apps/api/src/migration/*product*.spec.ts`。

## 使用

服务器内使用旧应用已安装的 dotenv/mysql2；输出目录应预先设置为仅操作者可访问。不要传输环境文件，不将连接凭据放入命令、脚本或报告。

```sh
node inspect-legacy.cjs <旧应用目录> <已确认公司ID> mapping-rules.json <私有输出.json>
```

在新代码构建 shared 后，导出字段配置作为目标目录快照（输出也放 Git 外）：

```sh
node -e 'const {RESOURCE_DEFS}=require("./packages/shared/dist/resources.js");const {execFileSync}=require("node:child_process");process.stdout.write(JSON.stringify({revision:execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).trim(),resources:RESOURCE_DEFS}));' > <私有目标字段.json>
python3 scripts/migration/build-assessment.py \
  --source <私有源汇总.json> --target <私有目标字段.json> \
  --rules scripts/migration/mapping-rules.json --output <私有报告目录>
python3 -m unittest discover -s scripts/migration/tests
```

五份 CSV 分别列出新字段候选、资料数量口径、全部旧表取舍、待处理问题、尚未明确取用的旧字段。最后一份是待核对清单，不能视为已经决定丢弃。问题条目可能涉及同一记录，不可相加成拒绝行数；保留来源 ID 对照以便下一阶段逐行核查。

## 试迁前必须补齐

1. 目标公司与现有数据复用/冲突策略；所有旧新 ID 对照和同公司引用校验。组织岗位类型和权限按新规则核定；无账号人员不创建虚假账号。
2. 旧密码验证兼容及首次登录升级；新旧密钥只在服务器内解密/重加密，不记录明文。
3. 枚举、单位、有效版本/成本、编码保留及精度转换。缺少必填值不造零值、日期或理由；计算字段由新规则生成。
4. 实际文件迁移、摘要校验与引用替换；新资源创建可能触发自动关联/派生记录，导入模式须防止重复生成并停用通知、外部写入。
5. 隔离 MySQL 测试库试迁，验证可重跑、可回滚，输出新增/复用/冲突/未迁与金额差异逐行清单。历史单据、审批、过账及运行日志本轮不迁；余额与资料附属历史单独核定。
6. 正式导入另行授权，先备份新库及附件，完成演练及最终增量核对。评估工具不代替导入器或授权。

## 全公司替换的覆盖检查

`legacy-adapter.cjs` 的 `preserveLegacyStates` 模式在同一只读快照内调用 `source-coverage.cjs`，记录全部基础表的字段和精确行数；未选入且非空的表逐一进入未验收说明。全表数量是全库统计，不能据此把没有可靠归属的全局行分给当前公司。大日志只做COUNT，不在适配器内整表加载正文。清单以加密来源行 `legacy_schema_inventory/current` 保留，CLI缺少清单就拒绝全量模式。部署迁移适配器时须同时提供该辅助文件。

该清单只证明表已盘点和哪些公司范围的行已读取；不是字段全部对应或历史页面已可用的证明。周期模板、超时规则/事件/升级、删除规格、业务命令/关注人以及未验收的其他当前模板，另由 `workflow-coverage.ts` 明确记录并阻止正式提交。不得通过删说明、跳过全量参数或仅保留SQL备份来放行。

## 固定同一份来源供空跑和提交核对

`apps/api/dist/scripts/seal-legacy.js` 只读取来源、在新建私有目录封存并独立回读，不连接目标业务库、不启动worker、不放行切换。先在权限700的专用批次根目录下创建 `company-<旧公司ID>` 包（不能覆盖现有目录）：

```sh
node apps/api/dist/scripts/seal-legacy.js \
  --source-company <旧公司ID> \
  --adapter <原始适配器绝对路径> \
  --directory <私有批次根目录>/company-<旧公司ID>
```

记录逐行AES-GCM加密并串联摘要，含结束帧；附件按内容摘要保存为私有文件并逐个校验，不转换内容。独立回读验证全部记录规范摘要及所有附件，完成后才写 `company-<旧公司ID>.receipt.json`；未完成凭据不能使用。包、目录及附件不进Git，不传输环境或密钥。内联附件可能较大，逐行处理并释放原对象后再回读，不序列化两份完整来源到内存。

后续迁移CLI使用 `sealed-adapter.cjs`，进程环境 `LEGACY_SEALED_ROOT` 指向该私有批次根目录，仍须原有三项全量参数、公司/操作人/目标库确认及专用expected-report。适配器只读取经过完整性核对的包，不再连接旧库；原始适配器和全部辅助代码必须保留在同一目录，读取时再次核对原程序指纹。来源公司、程序、包摘要、密文链或任一附件不符均拒绝。封存成功不等于字段覆盖验收通过，也不替代正式冻结、最新备份恢复、全部公司统一事务及切换核对；不得用固定包掩盖读取错误或跳过排除项。

## 同号登记保持独立

完整重迁保留每个来源银行卡/手机号的独立资料身份和引用；不按号码合并，也不按首条选择保管人/资费。特殊唯一键仅经受控事务、加密原行和同公司来源账本核对后取得。既有原号可继续编辑，新建重复和改成已占用号码仍拒绝；自动按号码匹配出现多条时必须明确选择。普通局部导入的旧合并行为不作为全量替换的执行路径，不能省略完整模式参数。

## 店铺提现专项补迁

使用独立内部CLI `apps/api/src/scripts/backfill-withdrawal.ts`，默认整批空跑回滚。先在服务器校验冻结源备份并恢复到 `withdrawal_restore_*` 隔离库，来源适配器可组合 `withdrawal-source.cjs` 的 `createWithdrawalReader({connect,decryptPassword,backupDigest})`；连接和原解密器只在服务器内存提供，不把配置或明文写到适配器。

补迁仅处理 `finance_withdrawal`，按原迁移账本映射公司店铺；不迁入旧设备认证、Cookie、登录或远程任务。先核对预览及源/目标备份摘要，执行时明确核对库名/新旧公司并绑定该预览的程序指纹；原店铺缺映射、目标已有未归账资料等情况整批拒绝。电脑资料及原负责关系恢复后，需新助手所有者重新绑定，不会自动恢复在线。细节和本批核对见 `docs/协作/审计/提现资料补迁与上线-20261102.md`。
