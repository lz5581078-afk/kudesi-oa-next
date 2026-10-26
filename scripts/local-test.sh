#!/usr/bin/env bash
# 一键在本机架起测试环境（macOS / Linux）：数据库 → .env → 迁移 → 种子 → 演示数据 → 启动后端和网页。
#   bash scripts/local-test.sh          启动（第一次会自动准备，之后秒开）
#   bash scripts/local-test.sh stop     停止后端和网页（数据库保留）
#   bash scripts/local-test.sh status   看运行状态和登录信息
# 数据库：优先用 Docker（不需要任何密码，全部自动生成）；没有 Docker 就转到 scripts/setup-local.sh（需要本机 MySQL 8 的 root 密码，只用一次不保存）。
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"; RUN=.local-test; mkdir -p "$RUN"
API_PORT="${API_PORT:-4000}"; WEB_PORT="${WEB_PORT:-5173}"
cmd="${1:-start}"

pid_alive() { [ -f "$1" ] && kill -0 "$(cat "$1")" 2>/dev/null; }
stop_all() {
  for n in api web; do
    if pid_alive "$RUN/$n.pid"; then kill "$(cat "$RUN/$n.pid")" 2>/dev/null || true; pkill -P "$(cat "$RUN/$n.pid")" 2>/dev/null || true; fi
    rm -f "$RUN/$n.pid"
  done
}
show_login() {
  local pw; pw="$(grep '^SEED_ADMIN_PASSWORD=' .env | cut -d= -f2-)"
  echo
  echo "================ 测试环境已就绪 ================"
  echo "网页：   http://localhost:$WEB_PORT"
  echo "企业账号：admin     密码：$pw"
  echo "平台后台账号：platform     密码：$pw （同一个登录页，进入后是平台管理后台）"
  echo "（首次登录会要求改密码；改过之后以新密码为准）"
  echo "店铺登录助手：见 apps/agent/windows/README.txt（Mac 也能直接用：node apps/agent/dist/cli.js register --server http://127.0.0.1:$API_PORT --code <绑定码>）"
  echo "日志：$RUN/api.log  $RUN/web.log     停止：bash scripts/local-test.sh stop"
}

case "$cmd" in
  stop) stop_all; echo "已停止后端和网页。"; exit 0 ;;
  status)
    for n in api web; do if pid_alive "$RUN/$n.pid"; then echo "$n 运行中（pid $(cat "$RUN/$n.pid")）"; else echo "$n 未运行"; fi; done
    [ -f .env ] && show_login; exit 0 ;;
  start) ;;
  *) echo "用法：bash scripts/local-test.sh [start|stop|status]"; exit 1 ;;
esac

command -v node >/dev/null || { echo "需要先安装 Node 20+（https://nodejs.org）"; exit 1; }
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ] || { echo "Node 版本太低，需要 20 以上"; exit 1; }

# ---------- 1. .env 和数据库 ----------
if [ ! -f .env ]; then
  if command -v docker >/dev/null && docker info >/dev/null 2>&1; then
    echo "→ 用 Docker 准备数据库（密钥全部自动生成）"
    g() { node -e "console.log(require('crypto').randomBytes($1).toString('$2'))"; }
    DB_PW="$(g 18 base64url)"; ROOT_PW="$(g 18 base64url)"; ADMIN_PW="$(g 12 base64url)#1"; JWT="$(g 48 base64)"; KEY="k1:$(g 32 base64)"
    sed -e "s|^DB_PASSWORD=.*|DB_PASSWORD=$DB_PW|" -e "s|^DB_ROOT_PASSWORD=.*|DB_ROOT_PASSWORD=$ROOT_PW|" \
        -e "s|^JWT_SECRET=.*|JWT_SECRET=$JWT|" -e "s|^DATA_ENCRYPTION_KEYS=.*|DATA_ENCRYPTION_KEYS=$KEY|" \
        -e "s|^SEED_ADMIN_PASSWORD=.*|SEED_ADMIN_PASSWORD=$ADMIN_PW|" .env.example > .env
    chmod 600 .env
    docker compose up -d mysql
    echo -n "→ 等数据库就绪"
    for _ in $(seq 1 60); do
      [ "$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q mysql)" 2>/dev/null)" = "healthy" ] && break
      echo -n "."; sleep 2
    done; echo
  else
    echo "没有检测到可用的 Docker，改用本机 MySQL：需要 MySQL 8 已启动，并输入一次 root 密码（不会保存）。"
    DB_PORT="${DB_PORT:-3306}" bash scripts/setup-local.sh </dev/tty
  fi
fi
set -a; . ./.env; set +a

# ---------- 2. 依赖、迁移、种子 ----------
npm install --no-audit --no-fund --loglevel=error  # 依赖有更新时自动补装，没变化很快
npm run build:shared >/dev/null
npm run build -w @kudesi/agent >/dev/null 2>&1 || true
npm run db:migrate >"$RUN/migrate.log" 2>&1 || { echo "迁移失败，详见 $RUN/migrate.log"; exit 1; }
npm run db:seed >"$RUN/seed.log" 2>&1 || true   # 已有公司时种子会提示已存在，不算错误
PLATFORM_ADMIN_ACCOUNT=platform PLATFORM_ADMIN_PASSWORD="$(grep '^SEED_ADMIN_PASSWORD=' .env | cut -d= -f2-)" npm run db:platform-admin >"$RUN/platform-admin.log" 2>&1 || true   # 已存在时报错，不算错误

# ---------- 3. 启动 ----------
stop_all
(cd apps/api; API_PORT="$API_PORT" nohup npm run start:dev >"$ROOT/$RUN/api.log" 2>&1 & echo $! >"$ROOT/$RUN/api.pid")
(cd apps/web; nohup npm run dev -- --port "$WEB_PORT" >"$ROOT/$RUN/web.log" 2>&1 & echo $! >"$ROOT/$RUN/web.pid")
echo -n "→ 等后端启动"
for _ in $(seq 1 60); do curl -fs "http://127.0.0.1:$API_PORT/api/health" >/dev/null 2>&1 && break; echo -n "."; sleep 2; done; echo
curl -fs "http://127.0.0.1:$API_PORT/api/health" >/dev/null || { echo "后端没有起来，详见 $RUN/api.log"; exit 1; }
for _ in $(seq 1 30); do curl -fs "http://127.0.0.1:$WEB_PORT/" >/dev/null 2>&1 && break; sleep 1; done

# ---------- 4. 演示数据（只在第一次：一家店铺、一个银行账户，方便试提现） ----------
if [ ! -f "$RUN/demo-done" ]; then
  ADMIN_PW="$(grep '^SEED_ADMIN_PASSWORD=' .env | cut -d= -f2-)"
  API_URL="http://127.0.0.1:$API_PORT/api" ADMIN_PW="$ADMIN_PW" node -e '
    const A=process.env.API_URL, J={"content-type":"application/json"};
    (async()=>{
      const r=await fetch(A+"/auth/login",{method:"POST",headers:J,body:JSON.stringify({account:"admin",password:process.env.ADMIN_PW})});
      const lg=await r.json(); if(!lg.accessToken){console.log("（跳过演示数据：需要先登录改密码）");return;}
      const H={...J,authorization:"Bearer "+lg.accessToken};
      const post=(p,v)=>fetch(A+p,{method:"POST",headers:H,body:JSON.stringify({values:v})}).then(x=>x.ok?"ok":"skip");
      console.log("演示店铺:",await post("/resources/stores",{platform:"pdd",name:"演示店铺"}));
      console.log("演示银行账户:",await post("/resources/bank-accounts",{kind:"company_public",accountName:"演示公户",accountNo:"6222000011112222",balance:0}));
    })().catch(e=>console.log("（跳过演示数据）",e.message));
  ' && touch "$RUN/demo-done"
fi
show_login
