/**
 * 固定资产状态流转：前后端共用的唯一来源（旧系统 assetTransitions 的对应物）。
 * 资产的状态、使用人只能通过这些动作改变，不能在编辑表单里直接改。
 */
export type AssetState = 'idle' | 'in_use' | 'repairing' | 'retired' | 'lost';
export type AssetAction = 'checkout' | 'transfer' | 'return' | 'repair' | 'repaired' | 'retire' | 'lost' | 'found';

export interface AssetActionRule {
  label: string;
  from: readonly AssetState[];
  /** 目标状态；null 表示由是否有使用人决定（修好：有人用回到使用中，否则闲置） */
  to: AssetState | null;
  needsUser?: boolean;
  needsReason?: boolean;
  clearsUser?: boolean;
  /** 前端提示 */
  hint: string;
  reasonLabel?: string;
  withLocation?: boolean;
  danger?: boolean;
  confirm?: boolean;
}

export const ASSET_ACTIONS: Record<AssetAction, AssetActionRule> = {
  checkout: { label: '领用', from: ['idle'], to: 'in_use', needsUser: true, withLocation: true, hint: '把资产交给使用人，状态变为使用中。' },
  transfer: { label: '转交', from: ['in_use'], to: 'in_use', needsUser: true, withLocation: true, hint: '换一个使用人，状态仍为使用中。' },
  return: { label: '归还', from: ['in_use'], to: 'idle', clearsUser: true, withLocation: true, hint: '使用人交回资产，状态变为闲置。' },
  repair: { label: '送修', from: ['idle', 'in_use'], to: 'repairing', needsReason: true, reasonLabel: '维修原因', hint: '状态变为维修中。' },
  repaired: { label: '维修完成', from: ['repairing'], to: null, hint: '有使用人时回到使用中，否则变为闲置。' },
  lost: { label: '标记丢失', from: ['idle', 'in_use', 'repairing'], to: 'lost', needsReason: true, reasonLabel: '丢失说明', danger: true, hint: '状态变为丢失，找回后可以恢复。' },
  found: { label: '找回', from: ['lost'], to: 'idle', clearsUser: true, withLocation: true, hint: '状态变为闲置。' },
  retire: { label: '报废', from: ['idle', 'in_use', 'repairing', 'lost'], to: 'retired', needsReason: true, clearsUser: true, reasonLabel: '报废原因', danger: true, confirm: true, hint: '报废后资产不能再领用。' },
};

/** 各状态下可办理的动作（界面按钮顺序）。报废是终态。 */
export const ASSET_ACTIONS_BY_STATE: Record<AssetState, readonly AssetAction[]> = {
  idle: ['checkout', 'repair', 'lost', 'retire'],
  in_use: ['transfer', 'return', 'repair', 'lost', 'retire'],
  repairing: ['repaired', 'retire'],
  lost: ['found', 'retire'],
  retired: [],
};

/** 资产流转记录里的动作（含盘点和建档）的中文名。 */
export const ASSET_LOG_LABELS: Record<string, string> = {
  checkout: '领用', transfer: '转交', return: '归还', repair: '送修', repaired: '维修完成', retire: '报废', lost: '标记丢失', found: '找回',
  inventory_checked: '盘点：在位', inventory_moved: '盘点：位置变动', inventory_missing: '盘点：未找到',
  department_transferred: '随部门转移',
};

/** 流转记录里能看到的动作键（写入资料操作日志的 action）。 */
export const ASSET_FLOW_ACTIONS = Object.keys(ASSET_LOG_LABELS);

export type InventoryResult = 'present' | 'moved' | 'missing';
