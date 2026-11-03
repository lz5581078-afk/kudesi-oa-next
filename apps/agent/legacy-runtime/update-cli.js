const { loadConfig } = require('./config');
const { checkLatestRelease, requestOwnUpdate } = require('./online-update');

async function main() {
  const config = await loadConfig();
  if (!config?.deviceToken) throw new Error('助手尚未绑定。');
  if (process.argv.includes('--request')) {
    await requestOwnUpdate(config);
  }
  await checkLatestRelease(config);
}

main().catch((error) => {
  console.error(error.message || '更新检查失败');
  process.exitCode = 1;
});
