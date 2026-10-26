import { spawn } from 'child_process';

export interface ConsentInfo { requestedByName: string; storeName: string; mode: 'view' | 'control'; reason: string; minutes: number }
/** 弹窗征求电脑主人同意；超时或关闭都算不同意 */
export type ConsentPrompt = (info: ConsentInfo) => Promise<boolean>;
export const CONSENT_TIMEOUT_SECONDS = 30;

/** 弹窗文字（纯函数，便于测试）。文字不拼进命令，通过环境变量传给 PowerShell，避免注入。 */
export function consentText(i: ConsentInfo): string {
  const what = i.mode === 'control' ? '查看并操作' : '查看';
  return `${i.requestedByName} 申请远程协助：${what}这台电脑上的店铺「${i.storeName}」窗口。\n事由：${i.reason}\n最长 ${i.minutes} 分钟，对方只能看到并操作这家店铺的浏览器窗口，你随时可以关闭窗口结束。\n\n是否同意？（${CONSENT_TIMEOUT_SECONDS} 秒内不点则视为不同意）`;
}

/**
 * Windows 弹窗：WScript.Shell.Popup，是/否按钮，带倒计时。返回 6 才是“是”。
 * 这段在真实 Windows 机器上才能验证（Linux 沙箱里没有 PowerShell 和桌面），测试里用假的 spawn。
 */
export function windowsConsentPrompt(run: typeof spawn = spawn, platform: NodeJS.Platform = process.platform): ConsentPrompt {
  return (info) => new Promise<boolean>((resolve) => {
    if (platform !== 'win32') return resolve(false);
    try {
      const script = `$r=(New-Object -ComObject WScript.Shell).Popup($env:KUDESI_CONSENT_TEXT,${CONSENT_TIMEOUT_SECONDS},'酷得斯店铺助手：远程协助申请',4+32+4096); Write-Output $r`;
      const child = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { env: { ...process.env, KUDESI_CONSENT_TEXT: consentText(info) }, windowsHide: false, stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      child.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
      child.on('error', () => resolve(false));
      child.on('close', () => resolve(out.trim() === '6'));
      setTimeout(() => { try { child.kill(); } catch { /* 已经结束 */ } resolve(false); }, (CONSENT_TIMEOUT_SECONDS + 5) * 1000).unref?.();
    } catch { resolve(false); }
  });
}
