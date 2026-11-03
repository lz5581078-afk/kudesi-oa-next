# 兼容旧会话核心的 Windows 助手 0.3.45

此目录可作为安装包 `app/` 的源码树。来源是旧 OA 提交 `0fb7fdad2f3805e3579bd4f870199c880668aaa1` 的 0.3.44 助手：21 个根 JS、5 个平台 JS、10 个 Windows 文件和版本 JSON，共 37 个原始文件。`snapshot-manifest.json` 记录每份来源摘要、当前摘要和是否适配。没有复制用户配置、Cookie、私钥或原生二进制。

仅 8 份文件有改动：`config.js`、`api.js`、`register-device.js`、`open-shop.js`、`sessions.js`、`browser-close-recovery.js`、`version.json`、`windows/tray.ps1`。浏览器、平台适配、输入、远程采集、WebRTC、更新和其余 Windows 文件均逐字保留；关闭恢复文件只替换 Profile 查找键，未改关闭与进程判断流程。

新绑定的 OA 地址默认预填 `https://lc.kudesi.com/`，命令行显式地址或 `SESSION_MANAGER_SERVER_URL` 仍优先。此默认值只用于绑定入口，不改写已经保存的服务器地址、用途或 Profile。

服务器必须在注册及每次成功心跳返回 `profileNamespace`，格式为 `v1:<公司编号>:finance_withdrawal` 或 `v1:<公司编号>:company_store_maintenance`。新键是 `new URL(config.serverUrl).origin + '|' + profileNamespace + '|' + 原店铺数字编号`。Profile 内 `storeId` 仍是原数字字符串，保持服务器协议。不同 origin、公司、用途不复用环境，同一作用域继续使用同一 Profile。

旧的纯数字 `shops` 条目及 Profile 目录会保留，但不自动导入或作为新作用域的回退。首次升级后的心跳，须先成功落盘 namespace，才更新内存并允许领取任务；未返回用途、用途无效、写入失败或已绑定进程收到不同用途时返回 403，由原主循环停止并保留 Profile。重新绑定使用原托盘停止进程后执行，注册仅在服务器返回有效用途时更新配置。

打包还需要 `playwright-core`、`ws`、Node 运行环境，以及原 0.3.44 安装资产中已验证的 `runtime/remote-capture` 原生运行文件和匹配依赖。它们不在这份源码快照中；复用已核实资产时须校验文件清单和摘要。本目录不重新编译 C#/C++，不改现有 `apps/agent/src`、1.2.1 版本或其 Windows 模板，也不自动安装、升级任何用户电脑。

本地窄测入口：在 `apps/agent` 运行 `vitest run test/legacy-profile.test.ts`。测试只用临时目录和模拟 HTTP；未打开真实商家页、安装助手或调用原生远程组件。
