'use strict';

const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {test} = require('node:test');
const {createUpdateCheck, createExitConfirmation} = require('../src/desktop-update.cjs');

function setup({checks, downloads = [], responses = [], installError} = {}) {
  const updater = new EventEmitter();
  const calls = {checks: 0, downloads: 0, installs: [], dialogs: [], progress: [], closed: 0, exits: 0};
  updater.checkForUpdates = async () => {
    const result = checks[calls.checks++];
    if (result instanceof Error) throw result;
    return result;
  };
  updater.downloadUpdate = async () => {
    const error = downloads[calls.downloads++];
    if (error) throw error;
    updater.emit('download-progress', {percent: 65});
  };
  updater.quitAndInstall = (...args) => {
    calls.installs.push(args);
    if (installError) updater.emit('error', installError);
  };
  const check = createUpdateCheck({
    updater,
    async openProgress() {
      return {window: {}, update: (...args) => calls.progress.push(args), close: () => calls.closed++};
    },
    async showMessage(_parent, options) {
      calls.dialogs.push(options);
      return {response: responses.shift() ?? 1};
    },
    onExit: () => calls.exits++,
    reportError() {},
  });
  return {updater, calls, check};
}

const latest = {isUpdateAvailable: false};
const newer = {isUpdateAvailable: true, updateInfo: {version: '0.2.11'}};

test('startup allows OA when current, and the manual check reports the result', async () => {
  const {check, calls} = setup({checks: [latest, latest]});
  assert.equal(await check(), true);
  assert.equal(calls.dialogs.length, 0);
  assert.equal(await check({}), true);
  assert.equal(calls.dialogs[0].message, '当前已是最新版本');
  assert.equal(calls.closed, 2);
});

test('a newer release blocks OA, shares concurrent requests and silently restarts after download', async () => {
  const {check, calls, updater} = setup({checks: [newer]});
  const startup = check();
  assert.equal(check({}), startup);
  assert.equal(await startup, false);
  assert.equal(updater.allowDowngrade, false);
  assert.equal(updater.allowPrerelease, false);
  assert.equal(updater.autoInstallOnAppQuit, false);
  assert.deepEqual(calls.installs, [[true, true]]);
  assert.deepEqual(calls.progress[2], ['正在下载客户端 0.2.11', 65]);
  assert.equal(calls.closed, 0);
});

test('a failed required download retries and keeps the startup gate if the feed drops the release', async () => {
  const {check, calls} = setup({checks: [newer, latest], downloads: [new Error('download')], responses: [0, 1]});
  assert.equal(await check({}), false);
  assert.equal(calls.checks, 2);
  assert.equal(calls.exits, 1);
  assert.equal(calls.installs.length, 0);
  assert.deepEqual(calls.dialogs.map(dialog => dialog.buttons), [
    ['重试', '退出客户端'], ['重试', '退出客户端'],
  ]);
});

test('initial check failure and installer errors present retry or exit', async () => {
  const {check, calls} = setup({checks: [new Error('network'), newer], responses: [0, 1], installError: new Error('install')});
  assert.equal(await check(), false);
  assert.equal(calls.exits, 1);
  assert.equal(calls.closed, 1);
  assert.deepEqual(calls.dialogs.map(dialog => dialog.message), ['无法检查客户端更新', '客户端更新失败']);
});

test('manual check can close a network error while OA remains open', async () => {
  const {check, calls} = setup({checks: [new Error('network')]});
  assert.equal(await check({}), false);
  assert.deepEqual(calls.dialogs[0].buttons, ['重试', '关闭']);
  assert.equal(calls.exits, 0);
});

test('close asks only once, defaults to cancel and exits only on confirmation', async () => {
  let respond;
  let messages = 0;
  let exits = 0;
  let quitting = false;
  const confirmExit = createExitConfirmation({
    isQuitting: () => quitting,
    showMessage(_parent, options) {
      assert.equal(options.defaultId, options.cancelId);
      assert.equal(options.buttons[options.cancelId], '取消');
      messages++;
      return new Promise(resolve => { respond = resolve; });
    },
    onExit: () => { exits++; quitting = true; },
    onError: error => { throw error; },
  });
  const cancelled = confirmExit({});
  confirmExit({});
  respond({response: 0});
  await cancelled;
  assert.equal(messages, 1);
  assert.equal(exits, 0);
  const accepted = confirmExit({});
  respond({response: 1});
  await accepted;
  assert.equal(exits, 1);
  confirmExit({});
  assert.equal(messages, 2);
});
