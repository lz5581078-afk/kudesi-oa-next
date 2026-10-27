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
