#!/usr/bin/env bash
# TChat -> VPS deploy (run this from YOUR machine, from the project root).
# Copies the web-server part of TChat to the server, installs it as a systemd
# service and puts nginx in front on port 80.
#
# Usage:
#   TCHAT_DEPLOY_PASS='ВашПароль' bash deploy/deploy.sh
# or with ssh keys already set up:
#   bash deploy/deploy.sh
#
# Requires on your machine: ssh, rsync. Optional: sshpass (for password auth).
set -euo pipefail

SERVER_HOST="${SERVER_HOST:-195.62.49.244}"
SERVER_USER="${SERVER_USER:-root}"
REMOTE_DIR="${REMOTE_DIR:-/opt/tchat}"
PORT="${PORT:-3000}"

SSH="ssh -o StrictHostKeyChecking=accept-new"
RSYNC_RSH="ssh -o StrictHostKeyChecking=accept-new"
if [ -n "${TCHAT_DEPLOY_PASS:-}" ]; then
  if ! command -v sshpass >/dev/null 2>&1; then
    echo "TCHAT_DEPLOY_PASS задан, но sshpass не установлен."
    echo "  Ubuntu/Debian: sudo apt install sshpass    macOS: brew install hudochenkov/sshpass/sshpass"
    exit 1
  fi
  SSH="sshpass -p ${TCHAT_DEPLOY_PASS} ssh -o StrictHostKeyChecking=accept-new"
  RSYNC_RSH="sshpass -p ${TCHAT_DEPLOY_PASS} ssh -o StrictHostKeyChecking=accept-new"
fi

echo ">> Копирую проект на ${SERVER_USER}@${SERVER_HOST}:${REMOTE_DIR}"
$SSH "${SERVER_USER}@${SERVER_HOST}" "mkdir -p ${REMOTE_DIR}"
rsync -az --delete -e "$RSYNC_RSH" \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude 'dist' \
  --exclude 'android' \
  --exclude 'build' \
  --exclude 'youtube-bypass' \
  --exclude 'assets/tts' \
  ./ "${SERVER_USER}@${SERVER_HOST}:${REMOTE_DIR}/"

echo ">> Настраиваю сервер (Node.js, зависимости, systemd, nginx)"
$SSH "${SERVER_USER}@${SERVER_HOST}" "REMOTE_DIR='${REMOTE_DIR}' PORT='${PORT}' bash -s" < deploy/remote-setup.sh

echo ""
echo "Готово. Проверьте:"
echo "  http://${SERVER_HOST}/            (лендинг + пульт)"
echo "  http://${SERVER_HOST}/health      (статус)"
echo "  http://${SERVER_HOST}/widgets/stream.html   (оверлей для Prizm)"
