'use strict';

const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

function credentialsOf(value) {
  if (typeof value?.account !== 'string' || typeof value?.password !== 'string') return null;
  const account = value.account.trim();
  const { password } = value;
  if (!account || [...account].length > 64 || !password || [...password].length > 128) return null;
  return { account, password };
}

function createRememberedLogin(safeStorage, userData) {
  let pending = Promise.resolve();

  return (origin, command, input) => {
    const scope = createHash('sha256').update(origin).digest('hex').slice(0, 16);
    const file = path.join(userData(), `oa-login-${scope}.bin`);
    const operation = pending.then(async () => {
      if (command === 'forget') {
        await fs.rm(file, { force: true });
        return;
      }
      if (!await safeStorage.isAsyncEncryptionAvailable()) {
        if (command === 'read') return { available: false, credentials: null };
        throw new Error('系统密码保护暂不可用');
      }
      if (command === 'read') {
        try {
          const { result } = await safeStorage.decryptStringAsync(await fs.readFile(file));
          return { available: true, credentials: credentialsOf(JSON.parse(result)) };
        } catch {
          return { available: true, credentials: null };
        }
      }
      const credentials = command === 'save' && credentialsOf(input);
      if (!credentials) throw new Error('登录信息格式无效');
      const encrypted = await safeStorage.encryptStringAsync(JSON.stringify(credentials));
      const staging = `${file}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(staging, encrypted, { flag: 'wx', mode: 0o600 });
        await fs.rename(staging, file);
      } finally {
        await fs.rm(staging, { force: true });
      }
    });
    pending = operation.catch(() => undefined);
    return operation;
  };
}

module.exports = { createRememberedLogin };
