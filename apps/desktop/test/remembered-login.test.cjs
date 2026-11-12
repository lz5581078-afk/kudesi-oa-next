'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createRememberedLogin } = require('../src/remembered-login.cjs');

test('保存加密字节，按站点隔离，取消记住后删除本机记录', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-login-test-'));
  try {
    const ciphertext = Buffer.from([84, 13, 75, 8]);
    let encryptedInput;
    const safeStorage = {
      isAsyncEncryptionAvailable: async () => true,
      encryptStringAsync: async (value) => { encryptedInput = value; return ciphertext; },
      decryptStringAsync: async (value) => {
        assert.deepEqual(value, ciphertext);
        return { result: encryptedInput };
      },
    };
    const origin = 'https://lc.kudesi.com';
    const local = 'http://127.0.0.1:5186';
    const credentials = { account: 'sample-user', password: 'test-only value' };
    const remember = createRememberedLogin(safeStorage, () => directory);
    await remember(origin, 'save', credentials);
    const files = await fs.readdir(directory);
    assert.equal(files.length, 1);
    assert.deepEqual(await fs.readFile(path.join(directory, files[0])), ciphertext);
    const reopened = createRememberedLogin(safeStorage, () => directory);
    assert.deepEqual(await reopened(origin, 'read'), { available: true, credentials });
    assert.deepEqual(await reopened(local, 'read'), { available: true, credentials: null });
    await Promise.all([reopened(origin, 'save', credentials), reopened(origin, 'forget')]);
    assert.deepEqual(await reopened(origin, 'read'), { available: true, credentials: null });
    assert.deepEqual(await fs.readdir(directory), []);
  } finally {
    await fs.rmdir(directory);
  }
});

test('系统加密不可用时不保存凭证', async () => {
  const remember = createRememberedLogin({ isAsyncEncryptionAvailable: async () => false }, () => os.tmpdir());
  const origin = 'https://lc.kudesi.com';
  assert.deepEqual(await remember(origin, 'read'), { available: false, credentials: null });
  await assert.rejects(remember(origin, 'save', { account: 'sample-user', password: 'test-only value' }), /系统密码保护暂不可用/);
});
