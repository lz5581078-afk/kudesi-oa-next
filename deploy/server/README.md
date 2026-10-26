# lc.kudesi.com 部署

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

- 发布前备份 current 指向、站点配置及数据库。已有业务库禁止自动运行迁移；先确认新增迁移和备份，再由用户授权执行。
- 恢复旧版本：将 `current` 和 `release.env` 改回已验证的发布版本，重新启动 API 并验证健康。代码回退不会自动撤销数据库迁移。
- 不执行 `docker compose down -v`，不要覆盖 shared 配置，不连接或迁移旧系统生产库。
- 查看状态：`docker ps --filter label=com.docker.compose.project=kudesi-lc`。API 日志用 `docker logs --tail 100 kudesi-lc-api-1`；日志不得包含密码或令牌。
