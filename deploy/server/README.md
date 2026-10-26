# lc.kudesi.com 部署

## 首次上线记录

2026-10-26 已部署 https://lc.kudesi.com ，发布目录 `/srv/kudesi-lc/releases/20261026-01`，镜像 `kudesi-lc-api:20261026-01`，代码版本见发布目录的 `release.json`。HTTPS 页面、HTTP 跳转、API 健康、公司和平台管理员登录已验证。

公司管理员账号 `admin`（首次登录需改密），平台管理员账号 `platformadmin`；初始密码仅存在服务器的 `/srv/kudesi-lc/shared/bootstrap.env`，需 sudo 权限查看。禁止复制到文档、日志或 Git。

初始数据库与站点备份位于 `/srv/kudesi-lc/backups/`（权限 700）。证书到期日 2027-01-24，Certbot 已配置自动续期；本站专用重载钩子为 `/etc/letsencrypt/renewal-hooks/deploy/kudesi-lc-nginx.sh`。

网站名称：小白全流程系统。该站点使用独立的 `kudesi-lc` Docker Compose 项目、MySQL 数据卷和 `127.0.0.1:4107` API 端口。Nginx 提供网页、API 代理与 HTTPS；现有其他网站不变。

## 首次部署与发布

1. 本地执行 `npm ci`、`npm run typecheck`、`npm test`、`npm run build`，打包根 package/lock、各 workspace package.json、`packages/shared/dist`、`apps/api/dist`、`apps/web/dist` 和本目录。
2. 上传到服务器 `/srv/kudesi-lc/releases/<release>/`，在发布目录执行 `docker build -f deploy/server/Dockerfile -t kudesi-lc-api:<release> .`。
3. 运行配置仅存服务器 `/srv/kudesi-lc/shared/`，权限 600，禁止下载、打印或提交到 Git：`mysql.env`（MySQL 初始化变量）、`api.env`（DB_HOST=mysql、API_PORT=4000、CORS_ORIGIN=https://lc.kudesi.com、随机应用密钥）、`bootstrap.env`（仅首次初始化账号用）。已有配置不得重新生成或覆盖。
4. 在 shared 中维护无密钥的 `release.env`，设置 `KUDESI_API_IMAGE=kudesi-lc-api:<release>`。以下 Compose 命令均在发布目录执行，并加 `--env-file /srv/kudesi-lc/shared/release.env -f deploy/server/compose.yml`。
5. 先 `docker compose ... up -d --wait mysql`；新库运行 `docker compose ... run --rm --no-deps api node node_modules/typeorm/cli.js migration:run -d apps/api/dist/database/data-source.js`。首次使用 bootstrap 环境执行编译后的 `apps/api/dist/scripts/seed.js` 和 `create-platform-admin.js`，创建首个公司及平台管理员；后续不再执行初始化。
6. 将 `current` 符号链接切换到新发布目录，`docker compose ... up -d --wait api`，检查网页、API 健康和登录。
7. Nginx 站点配置放在 `/www/server/panel/vhost/nginx/lc.kudesi.com.conf`，先 `nginx -t` 再 reload。首次使用 `certbot certonly --webroot -w /srv/kudesi-lc/acme -d lc.kudesi.com` 申请证书，然后启用 HTTPS 与 HTTP 跳转；续期后 reload Nginx。

## 更新与恢复

- 发布前备份 current 指向、站点配置及数据库。手工发布到已有业务库前须确认新增迁移及备份。下述获授权的自动发布控制器仅在备份校验完成、旧迁移未改动且确有待执行迁移时执行新增迁移。
- 恢复旧版本：将 `current` 和 `release.env` 改回已验证的发布版本，重新启动 API 并验证健康。代码回退不会自动撤销数据库迁移。
- 不执行 `docker compose down -v`，不要覆盖 shared 配置，不连接或迁移旧系统生产库。
- 查看状态：`docker ps --filter label=com.docker.compose.project=kudesi-lc`。API 日志用 `docker logs --tail 100 kudesi-lc-api-1`；日志不得包含密码或令牌。


## 推送触发自动发布

已实现 `.github/workflows/deploy.yml`。工作流文件进入 main 后：任何窗口向 main 合并或推送都会触发，推送 integration 不发布。GitHub Actions 的 **Deploy lc.kudesi.com** 页面可查看测试、打包、上传和发布结果；也可在 main 上点 **Run workflow → action=deploy** 重发。

流水线执行 npm ci、typecheck、常规测试、真实 MySQL API 测试（串行）、发布控制器测试、build，再打包编译产物和带 Git SHA 的 release.json。发布编号为 UTC 日期、run id、attempt 与短 SHA 的组合；同一站点部署串行且不主动中断正在执行的发布。

### Secrets 与专用账号

仓库 Settings → Secrets and variables → Actions 需要以下四个 Repository Secrets（本次已通过加密 API 配置）：

| Secret | 用途 |
|---|---|
| DEPLOY_HOST | 服务器地址 |
| DEPLOY_USER | 专用受限账号 lcdeploy |
| DEPLOY_SSH_KEY | 专用 ed25519 私钥，仅保存在 GitHub；不发到聊天或文档 |
| DEPLOY_KNOWN_HOSTS | 已核验服务器的公钥，用于严格校验主机身份，禁止部署时临时信任未知主机 |

私钥在内存中生成并加密上传，没有写入本机或服务器的私钥文件。Actions 运行时临时创建权限 600 的私钥文件，步骤退出即删除。普通协作窗口只需合并 main，不需要这些 Secrets 的值或服务器密码。

服务器的 lcdeploy 不属于 docker 或 wheel 组，没有交互式 shell、SFTP、端口转发或任意命令权限。authorized_keys 强制调用受限 SSH 网关，只接受 upload、deploy、rollback、rollback-if-current 和 status。sudo 仅允许固定的发布控制器；控制器清除调用者环境，固定部署根目录、Compose 与 Dockerfile，不执行上传包里的发布脚本。

### 服务端发布与回滚

首次由服务器管理员从已审阅的本目录运行 `sudo bash install-controller.sh <专用SSH公钥文件>`。它安装控制器到 `/usr/local/lib/kudesi-lc/`、网关到 `/usr/local/libexec/kudesi-lc-ssh`、固定入口 `/usr/local/sbin/kudesi-lc-command`。后续更新控制器或基础设施模板需要管理员再次审阅并安装；应用发布不会覆盖 shared、Nginx、数据库凭据或服务器控制脚本。

发布包通过 SSH 标准输入上传，校验 SHA-256、大小、路径和成员类型，拒绝软链接、硬链接、特殊文件及未允许的路径。切换前保存旧 current/Git SHA 与数据库压缩备份，完整解压验证备份后才构建镜像、核对迁移；已执行迁移不允许改动/删除，无新增迁移时不运行 migration:run。

每个发布目录自行保存无密钥的 image.env，自动发布不覆盖 shared/release.env。激活后检查容器、API 及 Nginx 实际返回的 release.json，CI 再验证公网 HTTPS；失败返回非零并恢复上一个程序版本，CI 显示失败。公网检查失败的回滚还会核对 current，避免撤销另一轮发布。

**回滚恢复程序和静态网页，不自动恢复数据库或撤销迁移**，避免覆盖发布后已经写入的业务数据。迁移应保持向后兼容；如果不兼容或 MySQL DDL 部分提交，需要管理员依据本次备份单独恢复，不能把程序回滚当成数据库回滚。

- 无需 SSH 的回滚：Actions → Deploy lc.kudesi.com → Run workflow，选择 main，action=rollback，release_id 填一个已有的成功发布编号。
- 管理员手动回滚命令：`sudo /usr/local/sbin/kudesi-lc-command rollback <已有发布编号>`。
- 查看当前版本：`sudo /usr/local/sbin/kudesi-lc-command status`；公网 `https://lc.kudesi.com/release.json` 包含当前 Git SHA 和发布编号。
- 私有日志：`/srv/kudesi-lc/logs/deploy.log`；发布前状态及数据库备份：`/srv/kudesi-lc/backups/<发布编号>/`；禁止将数据库备份作为 GitHub artifact 上传。
- 控制器有服务端互斥锁；不执行 down -v，也不自动删除历史发布或备份。

### 本次验证边界

控制器测试覆盖成功发布、无迁移、备份失败、构建失败、迁移失败、启动/健康/错误网页版本导致回滚、手工与条件回滚、归档路径穿越/链接/私密文件拒绝和并发互斥。服务器已实测专用 SSH 认证、合法上传、拒绝任意命令/SFTP/注入、拒绝恶意归档且 current 不变。当前生产镜像的迁移登记已只读核验，无待执行迁移。

本次仅配置发布入口和 Secrets，没有切换线上应用或合并 main。首次真实的 Actions 发布及新版登录页更新将在用户合并 main 后完成，届时以 Actions 绿色结果和公网 release.json 为准。
