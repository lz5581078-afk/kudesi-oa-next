#!/usr/bin/env bash
# 在本机（macOS/Linux）一键准备开发环境：建库建用户 → 生成 .env → 装依赖 → 迁移 → 种子。
# 用法：  bash scripts/setup-local.sh
# 需要：Node 20+，本机已启动 MySQL 8.x，并知道 root 密码。root 密码只在本次运行里用，不会写进任何文件。
set -euo pipefail
cd "$(dirname "$0")/.."

DB_HOST="${DB_HOST:-127.0.0.1}"
DB_PORT="${DB_PORT:-3306}"
DB_NAME="${DB_NAME:-kudesi_oa_next}"
DB_USER="${DB_USER:-kudesi}"

MYSQL_BIN="$(command -v mysql || true)"
for candidate in /usr/local/mysql/bin/mysql /opt/homebrew/bin/mysql /usr/local/bin/mysql; do
  [ -z "$MYSQL_BIN" ] && [ -x "$candidate" ] && MYSQL_BIN="$candidate"
done
[ -n "$MYSQL_BIN" ] || { echo "找不到 mysql 命令行。请把 MySQL 的 bin 目录加入 PATH（Docker Desktop 版可用：docker exec -it <容器> mysql -uroot -p）"; exit 1; }
command -v node >/dev/null || { echo "需要先安装 Node 20+"; exit 1; }

if [ -f .env ]; then
  echo "已存在 .env，直接使用（不会覆盖）。想重来请先删除 .env。"
  set -a; . ./.env; set +a
else
  read -r -s -p "MySQL root 密码（输入时不显示）: " ROOT_PW; echo
  APP_PW="$(node -e "console.log(require('crypto').randomBytes(18).toString('base64url'))")"
  ADMIN_PW="$(node -e "console.log(require('crypto').randomBytes(12).toString('base64url')+'#1')")"
  JWT="$(node -e "console.log(require('crypto').randomBytes(48).toString('base64'))")"
  KEY="k1:$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")"

  MYSQL_PWD="$ROOT_PW" "$MYSQL_BIN" -h"$DB_HOST" -P"$DB_PORT" -uroot <<SQL
CREATE DATABASE IF NOT EXISTS \`$DB_NAME\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '$DB_USER'@'127.0.0.1' IDENTIFIED BY '$APP_PW';
CREATE USER IF NOT EXISTS '$DB_USER'@'localhost' IDENTIFIED BY '$APP_PW';
ALTER USER '$DB_USER'@'127.0.0.1' IDENTIFIED BY '$APP_PW';
ALTER USER '$DB_USER'@'localhost' IDENTIFIED BY '$APP_PW';
GRANT ALL ON \`$DB_NAME\`.* TO '$DB_USER'@'127.0.0.1';
GRANT ALL ON \`$DB_NAME\`.* TO '$DB_USER'@'localhost';
SQL
  unset ROOT_PW

  sed -e "s|^DB_HOST=.*|DB_HOST=$DB_HOST|" -e "s|^DB_PORT=.*|DB_PORT=$DB_PORT|" -e "s|^DB_NAME=.*|DB_NAME=$DB_NAME|" \
      -e "s|^DB_USER=.*|DB_USER=$DB_USER|" -e "s|^DB_PASSWORD=.*|DB_PASSWORD=$APP_PW|" -e "s|^DB_ROOT_PASSWORD=.*|DB_ROOT_PASSWORD=unused|" \
      -e "s|^JWT_SECRET=.*|JWT_SECRET=$JWT|" -e "s|^DATA_ENCRYPTION_KEYS=.*|DATA_ENCRYPTION_KEYS=$KEY|" \
      -e "s|^SEED_ADMIN_PASSWORD=.*|SEED_ADMIN_PASSWORD=$ADMIN_PW|" .env.example > .env
  chmod 600 .env
  echo "已生成 .env（权限 600）。管理员初始密码在 .env 的 SEED_ADMIN_PASSWORD 里，首次登录会要求修改。"
fi

npm install
npm run build:shared
npm run db:migrate
npm run db:seed
echo
echo "完成。分别在两个终端运行：  npm run dev:api    和    npm run dev:web"
echo "然后打开 http://localhost:5173 ，公司代码 demo，账号 admin，密码见 .env 的 SEED_ADMIN_PASSWORD。"
