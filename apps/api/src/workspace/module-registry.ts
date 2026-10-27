import { Injectable } from '@nestjs/common';
import type { BossException, SummaryCard, WorkspaceModuleKey } from '@kudesi/shared';
import type { AuthUser } from '../common/auth.decorators';

/**
 * 工作台汇总的“接口位”：售后、兜底监督、直播这些模块由别的小组新建。
 * 对方模块在自己的构造函数里注入 WorkspaceModuleRegistry 并 register 一个提供者，总控台和岗位工作台就自动接入；
 * 没有注册时，页面显示“暂无该模块”，不会出错。
 */
export interface WorkspaceModuleProvider {
  key: WorkspaceModuleKey;
  /** 老板总控台：开放异常列表（监督模块）和每个人名下的异常数 */
  exceptions?(user: AuthUser): Promise<{ total: number; rows: BossException[]; byUser?: Record<number, number> }>;
  /** 老板总控台“需要你处理”里该模块的卡片（如售后待处理、直播异常） */
  bossCards?(user: AuthUser): Promise<SummaryCard[]>;
  /** 岗位工作台：该模块给某类岗位的汇总卡片 */
  deskCards?(user: AuthUser, workspaceType: string): Promise<SummaryCard[]>;
}

@Injectable()
export class WorkspaceModuleRegistry {
  private readonly providers = new Map<string, WorkspaceModuleProvider>();
  register(provider: WorkspaceModuleProvider) { this.providers.set(provider.key, provider); }
  get(key: WorkspaceModuleKey) { return this.providers.get(key); }
  has(key: WorkspaceModuleKey) { return this.providers.has(key); }
}
