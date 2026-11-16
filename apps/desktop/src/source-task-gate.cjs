'use strict';

// Remark tasks use a new BrowserWindow. A shared query, mounted view, or focused
// manual window does not own that window. Session clearing and external writes do.
function assertDedicatedTaskAvailable(command,{clearingSource,writeRunning,sharedWindowBusy}) {
 if(clearingSource)throw new Error('正在清理聚水潭登录，请完成后重试');
 if(writeRunning)throw new Error('聚水潭正在保存备注或回收单号，请等待当前任务完成');
 const remark=command==='readOrderRemark'||command==='saveOrderRemark';
 if(!remark&&sharedWindowBusy)throw new Error('聚水潭窗口正在使用，请稍后重试');
}

module.exports={assertDedicatedTaskAvailable};
