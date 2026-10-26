import * as fsp from 'fs/promises';
import * as path from 'path';
import type { AgentConfig } from './config';
import { log } from './config';
import { AgentApiError } from './api';
import { markHealthy, reportPendingResult, UpdateController, type UpdateInfo, type UpdaterDeps } from './updater';
import { AGENT_VERSION } from './version';

const REPORT_TIMEOUT_MS = 25_000;
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;

function installedDependencies(): Record<string, string> {
  try { return JSON.parse(require('fs').readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).dependencies ?? {}; } catch { return {}; }
}

/** 真实环境的依赖：HTTP 走设备令牌（只对 OA 的 /api/agent/* 说话），文件走本机 fs */
export function createUpdaterDeps(cfg: AgentConfig): UpdaterDeps {
  const url = (p: string) => new URL(p, cfg.serverUrl);
  return {
    root: process.env.KUDESI_AGENT_ROOT ? path.resolve(process.env.KUDESI_AGENT_ROOT) : null,
    currentVersion: AGENT_VERSION,
    dependencies: installedDependencies(),
    fs: fsp,
    now: Date.now,
    log: (l) => { void log(l); },
    async download(version) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), DOWNLOAD_TIMEOUT_MS);
      try {
        const res = await fetch(url(`/api/agent/release/download?version=${encodeURIComponent(version)}`), { headers: { 'x-device-token': cfg.deviceToken }, signal: ctl.signal });
        if (!res.ok || !res.body) { clearTimeout(timer); return { status: res.status, headers: res.headers, body: null }; }
        // 超时计时器要保持到读完，所以把它挂到流结束上
        const body = (async function* () { try { for await (const c of res.body as unknown as AsyncIterable<Uint8Array>) yield c; } finally { clearTimeout(timer); } })();
        return { status: res.status, headers: res.headers, body };
      } catch (e) { clearTimeout(timer); throw e; }
    },
    async report(version, status, extra) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), REPORT_TIMEOUT_MS);
      try {
        const res = await fetch(url('/api/agent/update/report'), { method: 'POST', headers: { 'x-device-token': cfg.deviceToken, 'content-type': 'application/json' }, body: JSON.stringify({ version, status, ...extra }), signal: ctl.signal });
        if (!res.ok) throw new AgentApiError(`回报升级状态失败（${res.status}）`, res.status);
      } finally { clearTimeout(timer); }
    },
  };
}

/** 主循环用的薄封装：启动时报告回退结果；首次连上 OA 后写健康标记；心跳里带升级目标时在后台升级（不阻塞心跳） */
export function createAutoUpdate(cfg: AgentConfig, deps: UpdaterDeps = createUpdaterDeps(cfg)) {
  const controller = new UpdateController(deps);
  let healthy = false;
  return {
    get active() { return controller.active; },
    async onStart() { await reportPendingResult(deps).catch((e) => deps.log(`报告回退结果失败：${(e as Error).message}`)); },
    async onConnected() {
      if (healthy) return;
      healthy = true;
      await markHealthy(deps).catch((e) => { healthy = false; deps.log(`写健康标记失败：${(e as Error).message}`); });
    },
    onUpdate(info: UpdateInfo, onRestart: () => void) {
      if (controller.active) return;
      void controller.handle(info).then((r) => { if (r === 'restart') onRestart(); });
    },
  };
}
