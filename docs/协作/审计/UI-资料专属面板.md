# UI 审计：资料专属页与面板（u2）

范围：资料类型专属面板、部门与岗位、员工与权限、岗位档案、资料总览、店铺/手机号/银行/证照/合作人/微信/自媒体/备忘/宽带等详情专属部分。
通用列表/详情/表单外壳归 u1，财务页与布局不动。标记：✓ 已有　✗ 缺失　≠ 不同（有意或待确认）。

## 1 卡号/账号/证件号复制（用户重点）
旧：MaskedNumber/SecretField 带复制钮。新：`CopyValue.tsx`，列表单元格、详情字段、详情顶部「关键信息」都带复制钮。

| 对象 | 旧 | 新 | 验证 |
| --- | --- | --- | --- |
| 银行卡号 | 复制 | ✓ 列表+详情+关键信息 | CopyAndFacts.test.tsx |
| 手机号 | 复制 | ✓ | CopyAndFacts.test.tsx |
| 账号（员工账号、自媒体/微信/备忘登录名） | 复制 | ✓（员工页 StaffPage 复制账号） | StaffPositions.test.tsx / CopyAndFacts |
| 证件号（sensitive 字段） | 复制 | ✓ 按权限明文后可复制 | CopyAndFacts |
| 密码类（secret） | 查看后复制 | ≠ 新系统密码永不返回，需专门权限查看并审计，不提供复制（红线） | — |
| 剪贴板不可用 | 回退 | ✓ 回退选中复制 | CopyAndFacts 第 3 条 |

## 2 部门与岗位（StructurePage / DepartmentDossier）
旧 OrgTreePage → 新 pages/org/StructurePage.tsx
- ① 布局：旧左树右卷宗；新左树右卷宗，手机端单栏切换。✓
- ② ✓ 树展开/收起并记住；✓ 搜索高亮；✓ 部门卷宗（人数、岗位、成员）；✓ 新增子部门/岗位带默认部门；≠ 拖拽调整改为上移/下移按钮（待用户确认）。
- ③ 已保留：展开状态记忆、人数徽标。测试：StructurePage.test.tsx。

## 3 员工与权限（StaffPage）
- ✓ 部门筛选（含下级）、岗位筛选、复制账号、数量页脚。测试 StaffPositions.test.tsx。
- 员工分组管理：未逐项对照，见矩阵。

## 4 岗位档案（PositionProfilesPage）
- ✓ 上级岗位列、无人在岗标记、职责条目删除（确认框）。测试 StaffPositions.test.tsx。

## 5 资料总览（OverviewPage）
- ✓ 按菜单分组计数、到期提醒按分组筛选并展开、最近变更（新增后端 `GET /resources/recent-changes`，按权限过滤）。测试 OverviewPage.test.tsx、resources.db.spec.ts。

## 6 店铺
- ✓ 筛选（领取状态/运营人/聚水潭/经营状态）、批量指派运营与领取状态、领退店记录子表、经营数据面板（StoreMetricsPanel）。
- ✓ 收回为公共店铺：带原因、清空运营人、写退店记录（StoreReleaseButton，CertPanels.test.tsx）。
- ✓ 指派运营：单店详情「指派/更换运营」（必填原因）+ 列表批量指派（必填原因，自动变已领取）；panels-config.db.spec.ts、CertPanels.test.tsx。
- ✓ 快捷页签（在运营/历史负责人未指派/公共待领取/异常/已注销）：quickTabs；panels-config.db.spec.ts。
- ✓ 领取规则：写在字段 help 里（形式不同但内容齐）。
- ✓ 领退店手工记录新增：子表通用新增。

## 第二轮完成项（A 部分）
| 项 | 状态 | 验证 |
| --- | --- | --- |
| 证照「关联已有店铺」对话框（搜索多选、转移他证需确认） | ✓ | LicenseActions.test.tsx |
| 部门树拖拽排序/改层级（前/内/后三区，防环；保留上移下移） | ✓ | deptMove.test.tsx、StructurePage.test.tsx「拖动部门」 |
| 软件订阅并入「账号与服务」页签（原已是同页页签，改名「软件订阅」） | ✓ | CompanionPage.test.tsx |
| 营业执照识别：拖图、Ctrl+V 粘贴、读取剪贴板图片 | ✓ | LicenseRecognize.test.tsx |
| 关联绑定弹窗：关系类型按旧系统 15 种 link 关系（packages/shared/src/relation-kinds.ts）随「当前资料+目标资料」给选项、默认第一个、反向看用反向名称；这对资料没定义时为「手工关联」；旧通用类型（使用/授权/保管/其他）仍可读；服务端校验这一对有这种关系；详情关系行显示旧系统关系名 | ✓ | relation-kinds.test.ts、RelationDialog.test.tsx、def-conditions.db.spec.ts「关系类型按资料类型」 |
| 总览「未建档手机号 → 建立手机号档案并绑定」（后端 POST /resources/:type/:id/create-phone，事务内建档+绑定，同号只绑定；校验修改+新增手机号权限；数据问题补微信/自媒体/合作人） | ✓ | resources.db.spec.ts「未建档手机号」、OverviewPage.test.tsx |
| 人事专属分区（人事记录/薪资变更/工资发放/奖励/处罚/任务/流程/交接）、员工导入导出、计薪方式/时薪/用工类型 | ✓ 已有（StaffRecordsDialog、StaffImportDialog、StaffPage） | 旧审计 C 文档该节已过时 |
| 员工页职责组筛选 | ✓ | StaffPositions.test.tsx |
| 资产专属分区（流转、盘点、储物空间、规格参数、归档） | ✓ 已有（AssetPanels、assets.db.spec.ts） | 同上 |
| 店铺「指派运营/更换运营」：在职人员、领取状态、推广限制解除日、必填原因，写领退店记录 | ✓ | CertPanels.test.tsx |

## 第二轮完成项（B 部分，用 u1 的列表壳入口 quickTabs/computedFilters/derivedColumns/batchActions）
| 项 | 状态 | 验证 |
| --- | --- | --- |
| 店铺五个快捷页签（在运营/历史负责人未指派/公共待领取/异常/已注销） | ✓ | panels-config.db.spec.ts |
| 店铺批量指派运营（必填原因，变已领取）/批量收回为公共店铺（清运营人） | ✓ | panels-config.db.spec.ts |
| 税务：店铺数、执照本月营业额列；执照情况筛选（未绑定/已停用或注销） | ✓ | panels-config.db.spec.ts |
| 微信号：手机号档案已关联/未关联筛选 | ✓ | panels-config.db.spec.ts |
| 职责组：没有成员页签、成员数、职责数列 | ✓ | panels-config.db.spec.ts |
| 备忘：域名页签（服务类型为域名） | ✓ | panels-config.db.spec.ts |
| 备忘：即将到期（30 天内）/已过期页签 | ✓ | panels-config.db.spec.ts（dateWithin/expired 条件） |
| 自媒体：运营部门筛选（含下级部门，选项按公司部门生成） | ✓ | panels-config.db.spec.ts（viaUserDept） |

## 6b 店铺快捷页签（原依赖 u1，现已完成，见上）
- 检查 origin/integration：通用列表壳只有 `tabsBy`（按字段值拆页签），没有“页签配置入口”（按筛选条件/计算条件定义的快捷页签）。
- 结论：「在运营 / 历史负责人未指派 / 公共待领取 / 异常 / 已注销」页签依赖 u1 的壳能力，我不改通用壳，记为依赖 u1。
- 单店「指派运营」「收回为公共店铺」已在店铺详情做（带原因）。仍依赖 u1 的只有「批量指派/收回带原因」（需壳的带原因批量动作入口）。

## 7 证照 / 税务 / 商标 / 合作人
- ✓ 适用店铺派生、借用归还登记、合作人主体面板、手机号一键建档（CertPanels）、证照识别（LicenseRecognize）。
- ✓ 关联已有店铺对话框（第二轮已做）。

### 税务资料（旧 tax-profiles.jsx → 新 tax-profiles 通用页 + TaxPendingDialog）
| 项 | 状态 | 说明 / 验证 |
| --- | --- | --- |
| 经营/电商页签 | ✓ | tabsBy taxCategory |
| 异常页签 | ✓ | 状态页签/筛选 |
| 「还没有税务资料的执照」提示条+建立 | ✓ | 顶部「待生成（N）」按钮+“N 张营业执照还没有税务资料”提示；TaxDutyUrl.test.tsx |
| 逐张生成 / 全部生成，类别跟随执照，纳税人名称识别号取自执照，税种待确认 | ✓ | TaxPendingDialog |
| 同执照同类别唯一校验 | ✓ | uniqueTogether |
| 纳税人识别号复制 | ✓ | 关键信息/列表复制 |
| 适用店铺（按执照派生） | ✓ | DerivedStoresPanel |
| 状态动作（异常/恢复/停用/启用带原因） | ✓ | StatusControl |
| 列：店铺数、执照本月营业额、执照情况筛选(未绑定/已停用) | ✓ | derivedColumns/computedFilters；panels-config.db.spec.ts |
| 银行账号明文显示 | ✓ | sensitive 字段 |

### 银行资金总览/资金概况（旧 BankOverviewPage → BankFundPage）
| 项 | 状态 | 说明 / 验证 |
| --- | --- | --- |
| 四个汇总卡：总余额/公司/店铺/异常 | ✓ | |
| 卡片说明（在用账户数、范围说明、异常提示，异常数标红） | ✓ 已补 | BankFundPage.test.tsx |
| 页面说明（余额不含停用和归档） | ✓ 已补 | 同上 |
| 按账户类型表，点类型进对应账户页 | ✓ | Link 跳转 |
| 最近登记账户，点击打开该账户 | ✓ | ?open= |
| 账号复制 | ✓ 已补 | 最近登记表账号旁复制钮 |
| 最近登记条数 | ✓ | 后端返回最近登记 |

### 微信号档案
| 项 | 状态 | 说明 |
| --- | --- | --- |
| 列表列：名称/微信号/使用人/用途/绑定手机号/状态 | ✓ | |
| 使用人筛选 | ✓ | filterBy userId |
| 异常页签 | ✓ | 状态页签/筛选 |
| 手机号档案 已关联/未关联 筛选 | ✓ | computedFilters；panels-config.db.spec.ts |
| 关键信息（微信号/使用人/用途/手机号）+ 复制 | ✓ | KeyFacts + 复制 |
| 密码仅按需查看，不复制 | ✓ | 按红线，不提供复制 |
| 异常原因（异常状态才显示） | ✓ | showWhen |
| 状态动作带原因 | ✓ | |
| 导入、复制新建时不带账号 | ✓ | 导入 ✓；复制新建由通用壳 copyOmit |

### 自媒体账号
| 项 | 状态 | 说明 |
| --- | --- | --- |
| 按平台分页签、平台专属字段按平台显示 | ✓ | tabsBy + showWhen |
| 运营人筛选 | ✓ | |
| 运营部门筛选 | ✓ | computedFilters optionsFrom departments；panels-config.db.spec.ts |
| 主页链接可点击 | ✓ 已补 | urlOf，TaxDutyUrl.test.tsx |
| 关联多个店铺 | ✓ | storeIds refs |
| 账号/手机号复制 | ✓ | |
| 平台+账号名称重复则更新（导入） | ✓ | importMatch |
| 密码按需查看 | ✓ | secret |

### 账号与服务备忘（含软件订阅）
| 项 | 状态 | 说明 |
| --- | --- | --- |
| 账号/服务页签 | ✓ | tabsBy kind |
| 软件订阅页签 | ✓ | software 是 memos 的伴随页签，标题改为「软件订阅」 |
| 即将到期/已过期页签 | ✓ | quickTabs dateWithin/expired |
| 登录地址/官网可点击 | ✓ 已补 | url 字段 |
| 服务挂在账号下（所属账号） | ✓ | parentId |
| 登录名/账号编号复制 | ✓ | |
| 续费周期/金额/到期 | ✓ | |
| 域名页签 | ✓ | quickTabs；panels-config.db.spec.ts |

### 职责组（员工分组管理）
| 项 | 状态 | 说明 |
| --- | --- | --- |
| 成员、职责明细子表 | ✓ | children |
| 详情显示成员 N 人/职责明细 N 条，无成员提示 | ✓ 已补 | DutyGroupSummary，TaxDutyUrl.test.tsx |
| 列表“没有成员”页签 | ✓ | quickTabs rel none |
| 列表成员数/职责数列 | ✓ | derivedColumns |
| 范围 公司级/部门级、负责人 | ✓ | |
| 编码建后不可改 | ✓ | 字段说明 |
| 停用/启用带原因 | ✓ | |

## 验证矩阵

| 页面 | 功能区布局是否与旧一致 | 功能是否齐 |
| --- | --- | --- |
| 部门与岗位 | 是 | 是（拖拽 + 上移下移） |
| 员工与权限 | 是 | 是 |
| 岗位档案 | 是 | 是 |
| 资料总览 | 是 | 是 |
| 店铺 | 是 | 是 |
| 证照 | 是 | 是 |
| 税务资料 | 是（待生成入口在顶部按钮） | 是 |
| 商标/合作人 | 是 | 是 |
| 手机号/费用/宽带 | 是 | 是 |
| 银行账户 | 是 | 是 |
| 资金概况 | 是 | 是 |
| 微信号 | 是 | 是 |
| 自媒体 | 是 | 是 |
| 账号与服务备忘 | 是（软件订阅同页页签） | 是 |
| 职责组 | 是 | 是 |
| 固定资产 | 是 | 是 |

## 旧系统死代码
resource-pages/*、assets-pages/*（已被 resource-center 取代）。
