import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

/** 助手在本机保存的东西：连接信息、设备令牌、每家店铺的浏览器 Profile（登录状态只在这里）。 */
export interface AgentConfig {
  serverUrl: string;
  deviceId: number;
  deviceNo: string;
  deviceToken: string;
  name: string;
  /** storeId → 本机 Profile 目录名（随机，不含店铺信息） */
  profiles: Record<string, string>;
  revokedAt?: string;
}

export function dataDir(): string {
  if (process.env.KUDESI_AGENT_DATA_DIR) return path.resolve(process.env.KUDESI_AGENT_DATA_DIR);
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) return path.join(process.env.LOCALAPPDATA, 'KudesiAssistant');
  return path.join(os.homedir(), '.kudesi-assistant');
}

export const configPath = () => path.join(dataDir(), 'agent.json');
export const statusPath = () => path.join(dataDir(), 'status.json');
export const logPath = () => path.join(dataDir(), 'agent.log');

export async function loadConfig(): Promise<AgentConfig | null> {
  try {
    const c = JSON.parse(await fs.readFile(configPath(), 'utf8')) as AgentConfig;
    return { ...c, profiles: c.profiles ?? {} };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

/** 先写临时文件再改名，断电不会写坏；文件只有当前用户能读写。 */
export async function saveConfig(c: AgentConfig): Promise<void> {
  await fs.mkdir(dataDir(), { recursive: true, mode: 0o700 });
  const target = configPath();
  const tmp = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(c, null, 2), { encoding: 'utf8', mode: 0o600 });
  let last: unknown;
  for (let i = 0; i < 6; i++) {
    try { await fs.rename(tmp, target); return; } catch (e) {
      last = e;
      if (!['EPERM', 'EACCES', 'EBUSY'].includes((e as NodeJS.ErrnoException).code ?? '')) break;
      await new Promise((r) => setTimeout(r, 40 * (i + 1)));
    }
  }
  await fs.rm(tmp, { force: true }).catch(() => undefined);
  throw last;
}

/** 被服务器撤销后：删掉令牌，保留 Profile（重新绑定后还能用）。 */
export async function clearAuthorization(c: AgentConfig): Promise<void> {
  await saveConfig({ ...c, deviceToken: '', revokedAt: new Date().toISOString() });
}

export async function profileDirFor(c: AgentConfig, storeId: number): Promise<string> {
  const key = String(storeId);
  if (!c.profiles[key]) {
    c.profiles[key] = crypto.randomUUID();
    await saveConfig(c);
  }
  return path.join(dataDir(), 'profiles', c.profiles[key]);
}

export async function writeStatus(s: { state: string; message?: string; store?: string }): Promise<void> {
  await fs.mkdir(dataDir(), { recursive: true, mode: 0o700 });
  await fs.writeFile(statusPath(), JSON.stringify({ ...s, at: new Date().toISOString() }), 'utf8').catch(() => undefined);
}

export async function log(line: string): Promise<void> {
  const text = `[${new Date().toISOString()}] ${line}\n`;
  process.stdout.write(text);
  try {
    await fs.mkdir(dataDir(), { recursive: true, mode: 0o700 });
    const p = logPath();
    const st = await fs.stat(p).catch(() => null);
    if (st && st.size > 2 * 1024 * 1024) await fs.rename(p, `${p}.1`).catch(() => undefined);
    await fs.appendFile(p, text, 'utf8');
  } catch { /* 日志写不了不影响主流程 */ }
}
