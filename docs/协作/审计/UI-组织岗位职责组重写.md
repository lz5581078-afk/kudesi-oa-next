# UI 审计：组织架构 / 岗位档案 / 职责组 重写

范围：资料导航“组织与人员”下的三页——组织架构（菜单原名“部门与岗位”，现改名“组织架构”）、岗位档案、职责组。
参照：10-24 旧版源码 `src/organization/OrganizationPages.jsx`（1667 行：OrganizationStructurePage / PositionProfilesPage / ResponsibilityGroupsPage）。
原则：视觉用新壳的紧凑语言（`res-page`，顶栏已有页名，页面内不再放大标题），信息结构、功能分区、交互按旧版。

## 1 旧页面功能与布局清单

### 1.1 组织架构（OrganizationStructurePage，旧名“组织架构”）
- 布局：左侧 `org-lite-sidebar`（标题、搜索框、全部展开/收起、部门树，行内“人数/岗位数”），右侧 `org-lite-main` 部门卷宗。没有页面大标题。
- 左树：按公司分组（旧系统多公司；新系统一个租户一家公司，不做公司层）→ 部门多级树；展开状态；搜索部门或人员，命中自动展开；顶部“管理架构”“＋新增部门”。
- 右侧卷宗：
  - 头部：部门名 + 上级路径 + 在职/岗位摘要；操作：新增下级、新增岗位、编辑部门、上移/下移、停用/启用、删除（带转移去向）。
  - 统计卡 `org-lite-summary`：部门人数、在职人员、岗位数量、部门主管。
  - “本部门岗位”岗位条 `org-lite-position-list`（岗位名、层级、在岗人数、职责数），可点开岗位、＋新增岗位。
  - 成员表：搜索（姓名/岗位/上级）、显示已停用、＋新增成员、列：姓名/岗位/账号/直属上级/职责组/状态；成员点进员工档案。
  - 右栏：下级部门（人数）、职责组（本部门绑定的）、兜底规则说明。
- “管理架构”弹窗 `org-structure-manager`：按层级分列（一级/二级/…），每行拖拽手柄、上架/下架、编辑、删除；每列＋新增；拖到别的部门里面=改父级，拖到前后=改排序。
- 对话框：新增/编辑部门（名称、上级、主管、排序）、新增/编辑岗位（key、名称、层级、默认角色、上级岗位、说明）、删除部门（列出岗位/人员/固定资产，选转移去向）、停用部门/岗位要填原因。
- 权限：编辑/删除按钮按权限显示；无权限只读。

### 1.2 岗位档案（PositionProfilesPage）
- 列表页：顶部标题“岗位档案”，工具条（搜索、部门、层级、状态、无人在岗、＋新增岗位）；按部门分组 `position-org-group`（可折叠，组头显示岗位数）；每组一张表：岗位名称/岗位层级/上级岗位/默认角色/在岗人数/职责数量/状态/操作（查看档案、停用、删除）。空时提示“暂无岗位”。
- 详情页（整页，`position-detail-layout`）：头部（返回列表、编辑、停用）；左主区 `position-detail-main`：基础信息（可编辑表单：部门、岗位 key、名称、层级、默认角色、上级岗位、说明）、五类条目分区（岗位职责、培训要求、绩效考核、监督规则、流程节点说明，每区可新增/编辑/停用，条目带频率/关联模块/来源等元信息）、操作记录；右栏 `position-detail-side`：在岗人员、岗位权限（旧为空时提示去系统设置配置）、快速摘要。
- 删除岗位：确认框，有在岗人员/被引用时拒绝。

### 1.3 职责组（ResponsibilityGroupsPage）
- 布局：上排两栏“新增自定义职责组”（key/名称/说明）+“职责组说明”；中间“职责组列表”（职责组/Key/范围/状态/说明）；下排两栏“职责明细”与“人员职责组绑定”。
- 旧版没有部门归属，也没有按部门分类（旧库 `responsibility_groups` 无部门列；导出的旧库里职责组行数为 0）。

## 2 新旧对照与差距（重写前）

| 项 | 旧版 | 重写前的新页面 | 差距 |
|---|---|---|---|
| 组织架构布局 | 左树 + 右部门卷宗，无大标题 | 已是左树右卷宗，但统计卡/岗位条/成员表区块较散；“管理架构”弹窗缺层级分列和拖拽手柄；无职责组区；入口名叫“部门与岗位” | 区块不对齐 |
| 新增成员入口 | 卷宗内“＋新增成员”，预填部门 | 只能去员工与权限页再选部门 | 缺入口 |
| 岗位档案列表 | 按部门分组可折叠，每组一表 | 一张平表 | 缺分组、折叠 |
| 岗位列 | 默认角色 | 无 | 新系统用显式 `workspace_type`，列名“默认工作台” |
| 岗位详情 | 整页：基础信息可编辑 + 五类条目 + 记录 + 右栏人员/权限/摘要 | 抽屉式 | 改整页 |
| 职责组 | 平铺列表，无部门 | 通用资料平铺列表，无部门 | 用户新要求：按部门分类 |
| 职责组详情 | 无 | 成员数、职责明细数 | 缺部门、成员名单、被哪些流程引用 |

## 3 重写后（新旧对照表）

| 旧版 | 新页面 | 说明 |
|---|---|---|
| 组织架构 左树 + 搜索 + 管理架构 + 新增部门 | `StructurePage` + `DepartmentTree`，页内无大标题，顶栏 ⓘ 提示 | 树行“N 人 · M 岗”；展开状态记住；搜索命中自动展开 |
| 卷宗头部与操作 | `DepartmentDossier` 头部：新增下级/新增岗位/编辑/上移/下移/停用/删除 | 停用要填原因；删除可选转移去向（岗位、人员、固定资产、职责组一并转移并记日志） |
| 统计卡 | `dl.key-facts.org-stats`（部门概况）：部门人数/在职人员/岗位数量/部门主管 | 沿用 |
| 本部门岗位条 | 岗位卡片条（层级·工作台·在岗·N 条职责） | 点卡片进岗位档案 |
| 成员表 | 搜索、显示已停用、＋新增成员（链接 `员工与权限?dept=ID&new=1`，预填部门并直接弹新增框） | `StaffPage` 只加了读取参数，没有删功能 |
| 右栏 | 下级部门、职责组（本部门，含成员数，可点进详情）、兜底规则 | 职责组替代旧的岗位列表 |
| 管理架构弹窗 | `StructureManager`：按层级分列，拖拽手柄 ⋮⋮、上架/下架、编辑、删除、每列＋新增 | 拖拽复用 `planMove` |
| 岗位档案列表 | `PositionProfilesPage`：搜索/部门（含下级）/层级/状态/无人在岗；按部门分组可折叠 | 列：岗位名称/岗位层级/上级岗位/默认工作台/在岗人数/职责数量/状态/操作 |
| 默认角色 | 默认工作台，来自显式字段 `positions.workspace_type`（blank 显示“无”） | 不按名称判断 |
| 岗位详情 | `PositionDetail` 整页：头部、基础信息就地编辑（含岗位类型）、五类条目、操作记录、右栏在岗人员/岗位权限/快速摘要 | 权限名从权限目录取中文名；“编辑与授权”进入授权 |
| 职责组 | 通用资料页 + 新字段 `所属部门`（`departmentId`，引用部门）；列表默认按部门分组（可折叠，“按部门分组”开关，记住），组头带条数和＋新增（预填该部门）；部门筛选（含下级）；快捷页签“没有成员”“未分类” | 没有部门的归“未分类” |
| 职责组详情 | `DutyGroupSummary`：成员数、职责明细、所属部门（或“未分类”）、成员名单、被哪些流程引用（`GET /flow/duty-group-usage/:id`，需流程配置查看权限，无权限则不显示） | 流程引擎“按职责组”办理人来源不变 |
| 公司分组 | 不做 | 新系统一个租户一家公司 |

## 4 数据与权限影响
- 部门归属存进资料 JSON（`resource_records.data.departmentId`），按“改资料配置不需要迁移”的规则，**没有新增迁移**。
- 旧库迁移适配（`scripts/migration/mapping-rules.json`）：duty-groups 的 `departmentId` 标 `@review`，说明旧系统没有归属；迁入后进入“未分类”，由管理员归类。
- 部门筛选走新条件 `deptField`（`def-conditions.ts`）：字段必须是引用部门的字段，id 必须是整数，包含下级用按 `company_id` 限定的递归查询；外公司、非法值被拒绝。
- 创建/修改职责组的部门走通用校验（引用必须属于本公司）。
- 删除部门时，部门下的职责组一并转移到目标部门并写 `department_transferred` 日志。
- 新接口 `GET /flow/duty-group-usage/:id`：`@RequirePermission('flow.templates.view')`，公司只取自令牌。
- 权限键、导航只在 `navigation.ts`：仅把 `org-tree` 的菜单名改为“组织架构”（键不变）。

## 5 测试
- Web：`StructureLayout.test.tsx`（无大标题、统计卡、岗位条、新增成员链接、职责组区、管理架构弹窗）、`PositionProfilesPage.test.tsx`（分组、默认工作台、折叠、筛选、进入整页）、`ResourcePage.groupby.test.tsx`（分组、未分类页签、折叠记忆、分组内新增预填）、`groupRows.test.tsx`、`DutyGroupSummary.test.tsx`；原有 StructurePage/StaffPositions 断言一条没删。
- API：`org/duty-group-dept.db.spec.ts`（部门归属创建与校验、含下级筛选、非法/外公司部门被拒、公司隔离、部门卷宗与岗位职责数、删除部门转移职责组、流程引用查询）。

## 6 截图（本机，未入库）
目录：`/tmp/claude-0/-home-claude/5f0340df-d2db-5d53-aea9-3dc621c50d0f/scratchpad/orgredo/shots/`
- 重写前：`before-org-1440.png`、`before-org-dept-1440.png`、`before-org-m390.png`、`before-org-dept-m390.png`、`before-positions-1440.png`、`before-positions-m390.png`、`before-position-detail-1440.png`、`before-groups-1440.png`、`before-groups-m390.png`、`before-group-detail-1440.png`、`before-group-detail-m390.png`
- 重写后：`after-org-1440.png`、`after-org-dept-1440.png`、`after-org-manage-1440.png`、`after-positions-1440.png`、`after-position-detail-1440.png`、`after-groups-1440.png`、`after-group-detail-1440.png`，以及对应的 `-m390.png`（org、org-dept、org-manage、positions、position-detail、groups、group-detail）。

## 7 上线后管理员要做的事
1. 打开“职责组”，把“未分类”里的职责组逐个补上所属部门（编辑或表格编辑）。
2. 检查各岗位的“默认工作台”（岗位类型）是否正确——这是显式字段，不会按名称猜。
