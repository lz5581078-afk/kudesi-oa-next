import { api, AgentApiError } from './api';
import { closeActive } from './browser';
import { clearAuthorization, loadConfig, log, writeStatus, type AgentConfig } from './config';
import { runJob, type JobOptions } from './jobs';
import { AGENT_VERSION } from './version';
import { RESTART_EXIT_CODE } from './launcher';
import { createAutoUpdate } from './updater-http';
import { createRemoteRunner } from './remote';

const HEARTBEAT_MS = 5_000;
const POLL_MS = 2_000;
const TICK_MS = 1_000;

export interface RunOptions extends JobOptions { stopSignal?: AbortSignal; heartbeatMs?: number; pollMs?: number }

/** 助手主循环：定时心跳（让 OA 看到“在线”）；空闲时领取请求并执行；一次只做一件事。 */
export async function runAgent(cfg: AgentConfig, o: RunOptions = {}): Promise<void> {
  if (!cfg.deviceToken) throw new Error('助手还没有绑定，请先运行：kudesi-agent register --server <OA地址> --code <绑定码>');
  let busy = false;
  let lastBeat = 0;
  let lastPoll = 0;
  let stop = false;
  o.stopSignal?.addEventListener('abort', () => { stop = true; });
  const onSignal = () => { stop = true; };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  await log(`助手 ${AGENT_VERSION} 已启动，连接 ${cfg.serverUrl}`);
  await writeStatus({ state: 'idle', message: '已连接' });
  const upd = createAutoUpdate(cfg); // 自动更新（apps/agent/src/updater.ts）
  let restartForUpdate = false;
  const remote = createRemoteRunner(cfg); // 远程协助（默认关闭，见 remote.ts）
  await upd.onStart();
  try {
    while (!stop) {
      const now = Date.now();
      try {
        if (now - lastBeat >= (o.heartbeatMs ?? HEARTBEAT_MS)) {
          const hb = await api.heartbeat(cfg, AGENT_VERSION);
          lastBeat = now;
          void upd.onConnected();
          if (hb.update && !busy && !remote.active) upd.onUpdate(hb.update, () => { restartForUpdate = true; stop = true; });
          if (!busy) await writeStatus({ state: 'idle', message: '已连接' });
        }
        if (!upd.active) void remote.tick().catch((e) => { if (!(e instanceof AgentApiError)) void log(`远程协助出错：${(e as Error).message}`); });
        if (!busy && !upd.active && now - lastPoll >= (o.pollMs ?? POLL_MS)) {
          lastPoll = now;
          const { request } = await api.claim(cfg);
          if (request) {
            busy = true;
            await log(`领取请求 ${request.id}（${request.kind}）：${request.store.name}`);
            void runJob(cfg, request, o)
              .catch((e) => log(`请求 ${request.id} 异常：${(e as Error).message}`))
              .finally(() => { busy = false; void writeStatus({ state: 'idle', message: '已连接' }); });
          }
        }
      } catch (e) {
        if (e instanceof AgentApiError && [401, 403].includes(e.status)) {
          await clearAuthorization(cfg);
          await writeStatus({ state: 'revoked', message: '这台电脑的授权已被撤销，请重新绑定' });
          await log('授权已被撤销，助手退出。请到 OA 重新生成绑定码后再绑定。');
          return;
        }
        await writeStatus({ state: 'offline', message: '暂时连不上 OA，自动重试中' });
        await log(`连接 OA 失败：${(e as Error).message}`);
        await new Promise((r) => setTimeout(r, 4000));
      }
      await new Promise((r) => setTimeout(r, TICK_MS));
    }
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    await remote.stop();
    await closeActive();
    await writeStatus({ state: 'stopped', message: restartForUpdate ? '助手正在重启以完成升级' : '助手已停止' });
    if (restartForUpdate) process.exitCode = RESTART_EXIT_CODE; // 通知启动器：立刻拉起新版本
  }
}

export async function runFromDisk(): Promise<void> {
  const cfg = await loadConfig();
  if (!cfg) throw new Error('助手还没有绑定，请先运行 register');
  await runAgent(cfg);
}
