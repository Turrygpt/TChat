#!/usr/bin/env bash
# Runs ON the server. Restores pm2 apps (gemini-app, tgbot) after TChat deploy.
set +e

echo "== resurrecting pm2 apps from saved dump =="
pm2 resurrect
sleep 2
pm2 save
pm2 startup systemd -u root --hp /root >/dev/null 2>&1

echo ""
echo "== pm2 list =="
pm2 list

echo ""
echo "== port 80 holder (must be nginx = TChat) =="
ss -ltnp 2>/dev/null | grep ":80 " || echo "  nobody listening on :80"

echo ""
echo "== gemini-app details (port/status) =="
pm2 describe gemini-app 2>/dev/null | grep -Ei "status|script path|exec cwd|error log|node args|instances" || echo "  gemini-app not found in pm2"

echo ""
echo "== TChat health (should be JSON) =="
curl -s http://127.0.0.1/tchat/health || echo "  TChat NOT responding"

echo ""
echo "RESTORE-DONE"
