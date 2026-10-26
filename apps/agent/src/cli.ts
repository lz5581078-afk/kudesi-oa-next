#!/usr/bin/env node
import * as os from 'os';
import { registerWithCode } from './api';
import { configPath, dataDir, loadConfig, saveConfig, statusPath } from './config';
import { runFromDisk } from './main';
import { AGENT_VERSION } from './version';
import { loadRemotePolicy, REMOTE_POLICIES, saveRemotePolicy, type RemotePolicy } from './remote-settings';
import * as fs from 'fs/promises';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

export function normalizeServer(raw: string): string {
  const s = raw.trim().replace(/\/+$/, '');
  if (!/^https:\/\//i.test(s) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(s)) throw new Error('OA 地址必须是 https:// 开头（本机测试可以用 http://127.0.0.1:端口）');
  return s;
}

async function main() {
  const cmd = process.argv[2];
  if (cmd === 'register') {
    const server = normalizeServer(arg('server') ?? process.env.KUDESI_OA_URL ?? '');
    const code = (arg('code') ?? '').trim().toUpperCase();
    if (!/^[A-Z2-9]{8}$/.test(code)) throw new Error('绑定码是 8 位字母数字，在 OA“店铺提现 → 授权电脑 → 生成绑定码”里获取');
    const name = arg('name') ?? os.hostname();
    const old = await loadConfig();
    const r = await registerWithCode(server, { code, name, os: `${os.platform()} ${os.release()}`.slice(0, 60), agentVersion: AGENT_VERSION });
    await saveConfig({ serverUrl: server, deviceId: r.deviceId, deviceNo: r.deviceNo, deviceToken: r.token, name, profiles: old?.profiles ?? {} });
    console.log(`绑定成功：${name}（设备号 ${r.deviceNo}）。接下来运行 start 或让它开机自启。`);
  } else if (cmd === 'run' || cmd === undefined) {
    await runFromDisk();
  } else if (cmd === 'status') {
    const c = await loadConfig();
    console.log(`版本 ${AGENT_VERSION}；数据目录 ${dataDir()}`);
    console.log(c?.deviceToken ? `已绑定：${c.name} → ${c.serverUrl}` : c?.revokedAt ? '授权已撤销，需要重新绑定' : '还没有绑定');
    console.log(await fs.readFile(statusPath(), 'utf8').catch(() => '(还没有运行记录)'));
  } else if (cmd === 'remote') {
    // 远程协助的本机开关：off 不允许 / prompt 每次弹窗问（默认） / auto 自动同意。OA 里管理员开启后这里还要主人点头
    const v = process.argv[3];
    if (v === undefined) console.log(`远程协助本机设置：${await loadRemotePolicy()}（off 不允许 / prompt 每次弹窗确认 / auto 自动同意）`);
    else if ((REMOTE_POLICIES as readonly string[]).includes(v)) { await saveRemotePolicy(v as RemotePolicy); console.log(`已设置远程协助：${v}。无需重启，下一次申请生效。`); }
    else throw new Error('只能设置 off、prompt 或 auto');
  } else if (cmd === 'unbind') {
    const c = await loadConfig();
    if (c) await saveConfig({ ...c, deviceToken: '', revokedAt: new Date().toISOString() });
    console.log(`已清除本机授权（配置文件 ${configPath()}）。店铺登录状态仍保留在本机，OA 里的电脑也请同步“撤销”。`);
  } else {
    console.log('用法：kudesi-agent register --server <OA地址> --code <绑定码> [--name 电脑名称] | run | status | remote [off|prompt|auto] | unbind');
  }
}

if (require.main === module) {
  main().catch((e) => { console.error(`[助手] ${(e as Error).message}`); process.exitCode = 1; });
}
