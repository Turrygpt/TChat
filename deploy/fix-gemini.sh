#!/usr/bin/env bash
# Runs ON the server. Уводит gemini-app с порта 3000 на 8090 (он читает PORT).
set +e
CWD="/var/www/html/tg"
PORT_NEW="${GEMINI_PORT:-8090}"

echo "== перезапуск gemini-app: npm run dev, PORT=$PORT_NEW =="
pm2 delete gemini-app >/dev/null 2>&1
cd "$CWD" || { echo "нет каталога $CWD"; exit 1; }
PORT="$PORT_NEW" pm2 start npm --name gemini-app -- run dev
pm2 save >/dev/null 2>&1

# firewall
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -qi active; then
  ufw allow "${PORT_NEW}/tcp" >/dev/null 2>&1 && echo "ufw: порт $PORT_NEW открыт"
fi

echo "== ждём 6с и проверяем стабильность =="
sleep 6
pm2 list

echo ""
echo "== gemini слушает $PORT_NEW локально? =="
code=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:${PORT_NEW}/" 2>/dev/null)
echo "  HTTP $code на 127.0.0.1:${PORT_NEW}"

echo ""
echo "== последние строки error-лога (должно быть без EADDRINUSE) =="
tail -8 /root/.pm2/logs/gemini-app-error.log 2>/dev/null || echo "  лог пуст"

echo ""
echo "== TChat health =="
curl -s http://127.0.0.1/tchat/health >/dev/null && echo "  TChat OK" || echo "  TChat НЕ отвечает"
echo "FIX-GEMINI-V2-DONE"
