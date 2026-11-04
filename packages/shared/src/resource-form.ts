/** 通用资料整组保存：主档和配置允许的子表同一事务提交。 */
export interface ResourceFormCollection {
  type: string;
  /** 打开表单时读到的完整子表及版本，用于检测并发编辑和遗漏。 */
  expected: Array<{ id: number; version: string }>;
  /** 保存后的完整子表；不带id为新增，不在此列表的原行删除。 */
  rows: Array<{ id?: number; values: Record<string, unknown> }>;
}
export interface ResourceFormInput {
  requestKey: string;
  id?: number;
  version?: string;
  /** 只在最终新增事务中复制；不属于正式资料字段。 */
  copySource?: { id: number; version: string; files: Record<string, number[]> };
  values: Record<string, unknown>;
  status?: string;
  statusReason?: string;
  collections: ResourceFormCollection[];
}
