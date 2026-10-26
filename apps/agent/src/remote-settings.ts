import * as fs from 'fs/promises';
import * as path from 'path';
import { dataDir } from './config';

/**
 * 电脑主人在本机对远程协助的态度（OA 里管理员开启之后，这里还要主人点头）。默认关闭。
 *   off     不允许（收到申请直接拒绝）
 *   prompt  每次申请都在屏幕上弹窗问，30 秒内点“是”才同意（建议值）
 *   auto    自动同意（无人值守的电脑；仍受 OA 里的开关、时限、域名限制）
 * 用命令行设置：kudesi-agent remote off|prompt|auto；环境变量 KUDESI_AGENT_REMOTE 优先（测试、批量部署用）。
 */
export type RemotePolicy = 'off' | 'prompt' | 'auto';
export const REMOTE_POLICIES: readonly RemotePolicy[] = ['off', 'prompt', 'auto'];
export const remoteSettingsPath = () => path.join(dataDir(), 'remote.json');

export async function loadRemotePolicy(env: NodeJS.ProcessEnv = process.env): Promise<RemotePolicy> {
  const fromEnv = env.KUDESI_AGENT_REMOTE;
  if (fromEnv && (REMOTE_POLICIES as readonly string[]).includes(fromEnv)) return fromEnv as RemotePolicy;
  try {
    const v = (JSON.parse(await fs.readFile(remoteSettingsPath(), 'utf8')) as { policy?: string }).policy;
    return (REMOTE_POLICIES as readonly string[]).includes(v ?? '') ? (v as RemotePolicy) : 'off';
  } catch { return 'off'; }
}

export async function saveRemotePolicy(policy: RemotePolicy): Promise<void> {
  if (!REMOTE_POLICIES.includes(policy)) throw new Error('只能设置 off、prompt 或 auto');
  await fs.mkdir(dataDir(), { recursive: true, mode: 0o700 });
  await fs.writeFile(remoteSettingsPath(), JSON.stringify({ policy, at: new Date().toISOString() }), { encoding: 'utf8', mode: 0o600 });
}
