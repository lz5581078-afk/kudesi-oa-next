async function resolveBrowserProcessId(context) {
  const browser = context?.browser?.();
  if (!browser?.newBrowserCDPSession) throw new Error('无法读取助手管理的浏览器主进程');
  const session = await browser.newBrowserCDPSession();
  try {
    const result = await session.send('SystemInfo.getProcessInfo');
    const browserProcesses = (result?.processInfo || [])
      .filter((process) => process?.type === 'browser' && Number.isInteger(Number(process.id)) && Number(process.id) > 0);
    if (browserProcesses.length !== 1) {
      throw new Error(browserProcesses.length ? '无法确定唯一的浏览器主进程' : '浏览器主进程不存在');
    }
    return Number(browserProcesses[0].id);
  } finally {
    await session.detach().catch(() => undefined);
  }
}

module.exports = { resolveBrowserProcessId };
