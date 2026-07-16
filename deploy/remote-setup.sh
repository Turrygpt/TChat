#!/usr/bin/env bash
# Runs ON the server (invoked by deploy.sh / deploy.ps1). Idempotent.
# Дедицирует сервер под TChat: освобождает порт 80 от любых процессов.
set -euo pipefail
REMOTE_DIR="${REMOTE_DIR:-/opt/tchat}"
PORT="${PORT:-3000}"
BASE_PATH="${BASE_PATH:-/tchat}"

echo "-- Node.js"
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
node -v

echo "-- npm install (только прод-зависимости)"
cd "${REMOTE_DIR}"
npm install --omit=dev --no-audit --no-fund

echo "-- systemd unit tchat"
cat > /etc/systemd/system/tchat.service <<UNIT
[Unit]
Description=TChat web server
After=network.target

[Service]
Type=simple
WorkingDirectory=${REMOTE_DIR}
Environment=PORT=${PORT}
Environment=HOST=127.0.0.1
ExecStart=$(command -v node) ${REMOTE_DIR}/scripts/serve.js
Restart=always
RestartSec=3
User=root

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable tchat
systemctl restart tchat

echo "-- Освобождаю порт 80 (сервер выделяется под TChat)"

# a) Известные веб-серверы.
for svc in apache2 httpd lighttpd caddy; do
  if systemctl list-unit-files 2>/dev/null | grep -q "^${svc}"; then
    echo "   стоп/выкл ${svc}"
    systemctl stop "$svc" 2>/dev/null || true
    systemctl disable "$svc" 2>/dev/null || true
  fi
done

# b) pm2 (частый способ держать node-приложение).
if command -v pm2 >/dev/null 2>&1; then
  echo "   стоп pm2"
  pm2 delete all 2>/dev/null || true
  pm2 kill 2>/dev/null || true
  pm2 unstartup systemd 2>/dev/null || true
fi

# c) Всё, что ещё слушает :80 — определяем PID, гасим его systemd-юнит и сам процесс.
port80_pids() { ss -ltnpH 2>/dev/null | awk '$4 ~ /:80$/' | grep -oP 'pid=\K[0-9]+' | sort -u; }
for pid in $(port80_pids); do
  [ -z "$pid" ] && continue
  cmd="$(ps -p "$pid" -o comm= 2>/dev/null || true)"
  unit="$(grep -aoP 'system\.slice/\K[^/]+\.service' /proc/$pid/cgroup 2>/dev/null | head -1 || true)"
  echo "   порт 80 держит PID $pid ($cmd) unit=${unit:-none}"
  if [ -n "$unit" ] && [ "$unit" != "nginx.service" ] && [ "$unit" != "tchat.service" ]; then
    systemctl stop "$unit" 2>/dev/null || true
    systemctl disable "$unit" 2>/dev/null || true
  fi
done
# добиваем оставшиеся процессы на :80
if command -v fuser >/dev/null 2>&1; then
  fuser -k 80/tcp 2>/dev/null || true
else
  for pid in $(port80_pids); do kill "$pid" 2>/dev/null || true; done
fi
sleep 2

echo "-- nginx (${BASE_PATH}/ -> 127.0.0.1:${PORT}, / -> ${BASE_PATH}/)"
if ! command -v nginx >/dev/null 2>&1; then
  apt-get update && apt-get install -y nginx
fi
mkdir -p /etc/nginx/conf.d
rm -f /etc/nginx/sites-enabled/default /etc/nginx/conf.d/default.conf 2>/dev/null || true
cat > /etc/nginx/conf.d/tchat.conf <<NGINX
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;

    location = / { return 301 ${BASE_PATH}/; }
    location = ${BASE_PATH} { return 301 ${BASE_PATH}/; }

    location ${BASE_PATH}/ {
        proxy_pass http://127.0.0.1:${PORT}/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_read_timeout 86400;
    }

    location /socket.io/ {
        proxy_pass http://127.0.0.1:${PORT};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
    }
    location /assets/  { proxy_pass http://127.0.0.1:${PORT}; proxy_set_header Host \$host; }
    location /widgets/ { proxy_pass http://127.0.0.1:${PORT}; proxy_set_header Host \$host; }
    location /tts/     { proxy_pass http://127.0.0.1:${PORT}; proxy_set_header Host \$host; }
    location /alerts/  { proxy_pass http://127.0.0.1:${PORT}; proxy_set_header Host \$host; }
    location /goal/    { proxy_pass http://127.0.0.1:${PORT}; proxy_set_header Host \$host; }
    location /music/   { proxy_pass http://127.0.0.1:${PORT}; proxy_set_header Host \$host; }
    location /demo/    { proxy_pass http://127.0.0.1:${PORT}; proxy_set_header Host \$host; }
    location /remote/  { proxy_pass http://127.0.0.1:${PORT}; proxy_set_header Host \$host; }
    location /health   { proxy_pass http://127.0.0.1:${PORT}; proxy_set_header Host \$host; }
}
NGINX

grep -rlZ "default_server" /etc/nginx 2>/dev/null | while IFS= read -r -d '' f; do
  [ "$f" = "/etc/nginx/conf.d/tchat.conf" ] && continue
  sed -i 's/\(listen[^;]*\) default_server/\1/g' "$f" 2>/dev/null || true
done

systemctl enable nginx >/dev/null 2>&1 || true
if ! nginx -t; then echo "!! nginx конфиг невалиден:"; nginx -t; exit 1; fi
if ! systemctl restart nginx; then
  echo "!! nginx НЕ стартовал. Диагностика:"
  systemctl status nginx --no-pager -l 2>&1 | tail -20 || true
  journalctl -u nginx --no-pager 2>&1 | tail -25 || true
  (ss -ltnp 2>/dev/null || netstat -ltnp 2>/dev/null) | grep ':80 ' || echo "   порт 80 свободен"
  exit 1
fi

echo "-- проверка"
sleep 1
echo "   локально /tchat/health:"; curl -s http://127.0.0.1/${BASE_PATH#/}/health || true; echo
systemctl --no-pager status nginx | head -4 || true
echo ""
echo "OK: http://<server-ip>${BASE_PATH}/   (корень / редиректит сюда)"
