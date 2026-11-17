'use strict';

// These tasks open their own window in the existing Electron session.
// Shared-window activity and login/session changes have different ownership.
function assertDedicatedTaskAvailable({clearingSource,writeRunning}) {
 if(clearingSource)throw new Error('正在清理聚水潭登录，请完成后重试');
 if(writeRunning)throw new Error('聚水潭正在保存备注或回收单号，请等待当前任务完成');
}

module.exports={assertDedicatedTaskAvailable};
