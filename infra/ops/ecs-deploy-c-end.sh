#!/bin/sh
# ECS 一键部署脚本 —— infra/ops/ecs-deploy-c-end.sh
# 用法（tmux 内跑，SSH 断开不中断）：
#   scp infra/ops/ecs-deploy-c-end.sh ecs:/tmp/ && ssh ecs 'tmux new -d -s deploy "sh /tmp/ecs-deploy-c-end.sh > /tmp/deploy.log 2>&1"'
#   ssh ecs 'tmux capture-pane -t deploy -p | tail -40'
set -e
cd /opt/market-sense

echo "[1/6] reset to origin HEAD"
sudo git fetch --depth=1 origin main
sudo git reset --hard origin/main
sudo git rev-parse HEAD

echo "[2/6] apply serving schema (c-end views)"
sudo docker exec -i market-sense-e2e-postgres-1 psql -U market -d market < warehouse/serving/schema.sql
sudo docker exec -i market-sense-e2e-postgres-1 psql -U market -d market < warehouse/serving/c-end-metrics.sql

echo "[3/6] verify v_cend views"
sudo docker exec market-sense-e2e-postgres-1 psql -U market -d market -tAc "SELECT viewname FROM pg_views WHERE schemaname='serving' AND viewname LIKE 'v_cend%' ORDER BY viewname;"

echo "[4/6] rebuild web image (L178 antd-mobile pages)"
sudo docker compose -f tests/e2e/docker-compose.yml build web

echo "[5/6] recreate web + api"
sudo docker compose -f tests/e2e/docker-compose.yml up -d --force-recreate --no-deps web api

echo "[6/6] smoke"
curl -s http://127.0.0.1:3000/dev/ai-card -o /dev/null -w "web /dev/ai-card: %{http_code}\n"
curl -s http://127.0.0.1:8081/healthz -o /dev/null -w "api /healthz: %{http_code}\n"
echo "--- c-end/overview (expect 401 UNAUTHENTICATED, fail-closed) ---"
curl -s http://127.0.0.1:8081/v1/c-end/overview | head -c 200
echo
echo "DEPLOY DONE $(date -Iseconds)"
