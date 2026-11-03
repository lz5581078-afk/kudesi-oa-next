# 复用旧运行组件打包兼容助手

此入口只生成独立的0.3.45测试安装包及原协议ZIP更新包，不改native 1.2.1助手，不下载依赖、不安装、不启动助手/商家浏览器、不修改生产配置。

所有原资产路径和构建工具必须显式提供：

```powershell
node apps/agent/scripts/pack-legacy.cjs --source-installer <原0.3.44安装包.exe> --source-manifest <原latest.json> --sevenzip <完整7z.exe> --makensis <NSIS3.12/makensis.exe>
```

原安装包必须匹配已核实的SHA-256 `a20e958a63fe967472270156f42729e16f249e24750ccc69530c626baaf52255`。脚本重新解包并验证全部core-manifest文件与组件摘要，再复用内置Node22.23.2、.NET原生采集、WebRTC DLL及既有Playwright/ws依赖。没有从本机已安装助手或用户数据目录收集任何文件。

当前受控源码位于`apps/agent/legacy-runtime`，37份文件先按snapshot-manifest校验。Windows PowerShell5.1对无BOM中文脚本的解析与PS7不同，因此仅在新包内给.ps1补UTF-8 BOM，正文逐字保留；冻结来源不动，编码变换前后摘要写入build-proof。

产物位于全新随机目录`apps/agent/release/legacy-0.3.45-<随机>`，包含EXE、ZIP、latest.json、SHA文件、build-proof.json，以及用于核验的解包目录。既有目录不覆盖、不删除。ZIP根结构保持`app/`、`windows/`、`core-manifest.json`，不能把新版.kapkg混作此更新包。

脚本执行ZIP CRC检查，重新提取新EXE和ZIP后逐文件核对SHA，运行内置Node的版本和纯配置函数，解析包内Windows脚本（PS5.1），均不执行安装脚本。原生EXE/DLL只验证复用摘要，不执行采集或远程操作。

完整7-Zip26.05和NSIS3.12需事先准备。工具不由本脚本下载；本轮使用的NSIS官方ZIP已核对SHA-256 `56581f90db321581c5381193d796fffcf2d24b2f8fed2160a6c6a3baa67f2c4f`。打包工具摘要同时记录到build-proof。

新EXE标为**未签名测试版**，不等于真实店铺登录、验证码、原生画面或生产联机验收通过；安装时仍需按原流程下载Chrome for Testing。交付测试应在新版兼容接口部署并准备好授权步骤之后进行。

窄测试：`npm test -w @kudesi/agent -- --run test/legacy-pack.test.ts`。
