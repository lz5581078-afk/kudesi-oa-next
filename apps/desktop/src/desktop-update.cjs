'use strict';

function createUpdateCheck({updater, openProgress, showMessage, onExit, reportError = console.error}) {
  let running;
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.allowDowngrade = false;
  updater.allowPrerelease = false;
  updater.disableWebInstaller = true;
  updater.disableDifferentialDownload = true;

  // electron-updater emits errors as well as rejecting check and download promises.
  updater.on('error', error => reportError('OA 客户端更新失败', error.code || error.message));

  async function run(parent) {
    const progress = await openProgress(parent);
    let requiredVersion;
    let installing = false;
    let installError;
    const downloadProgress = ({percent}) => progress.update('正在下载客户端 ' + requiredVersion, percent);
    const captureInstallError = error => { installError = error; };
    updater.on('download-progress', downloadProgress);
    updater.on('error', captureInstallError);
    try {
      for (;;) {
        progress.update('正在检查客户端版本');
        let phase = 'check';
        try {
          const result = await updater.checkForUpdates();
          if (!result) throw new Error('自动更新不可用');
          if (!result.isUpdateAvailable) {
            if (requiredVersion) throw new Error('发布源暂时无法提供已检测到的版本');
            if (parent) {
              await showMessage(progress.window, {
                type: 'info', message: '当前已是最新版本', buttons: ['确定'],
              });
            }
            return true;
          }
          requiredVersion = result.updateInfo.version;
          phase = 'download';
          progress.update('正在下载客户端 ' + requiredVersion, 0);
          await updater.downloadUpdate(result.cancellationToken);
          phase = 'install';
          progress.update('正在安装，完成后将自动重启');
          installError = undefined;
          updater.quitAndInstall(true, true);
          if (installError) throw installError;
          installing = true;
          return false;
        } catch (error) {
          reportError('OA 客户端更新步骤失败', phase, error.code || error.message);
          const canClose = Boolean(parent && !requiredVersion);
          const {response} = await showMessage(progress.window, {
            type: 'error',
            message: phase === 'check' ? '无法检查客户端更新' : '客户端更新失败',
            detail: phase === 'check' ? '请检查网络后重试。' : '请重试。更新完成后客户端会自动重启。',
            buttons: ['重试', canClose ? '关闭' : '退出客户端'],
            defaultId: 0, cancelId: 1,
          });
          if (response === 0) continue;
          if (!canClose) onExit();
          return false;
        }
      }
    } finally {
      updater.removeListener('download-progress', downloadProgress);
      updater.removeListener('error', captureInstallError);
      if (!installing) progress.close();
    }
  }

  return parent => {
    if (!running) running = run(parent).finally(() => { running = undefined; });
    return running;
  };
}

function createExitConfirmation({isQuitting, showMessage, onExit, onError}) {
  let confirmation;
  return parent => {
    if (isQuitting() || confirmation) return;
    const options = {
      type: 'question',
      message: '确定退出小白OA系统？',
      detail: '退出后本机采集将停止，未保存的内容可能丢失。',
      buttons: ['取消', '确认退出'],
      defaultId: 0,
      cancelId: 0,
    };
    confirmation = showMessage(parent, options).then(({response}) => {
      if (response === 1) onExit();
    }).catch(onError).finally(() => { confirmation = undefined; });
    return confirmation;
  };
}

module.exports = {createUpdateCheck, createExitConfirmation};
