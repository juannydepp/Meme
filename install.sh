#!/usr/bin/env bash
# One-shot installer for Ubuntu/Debian (your droplet). Safe to re-run.
set -euo pipefail
cd "$(dirname "$0")"
DIR="$(pwd)"; USER_NAME="$(whoami)"

echo "▶ Node.js"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
node -v

echo "▶ dependencies"
npm ci --no-audit --no-fund 2>/dev/null || npm install --no-audit --no-fund

echo "▶ settings"
if [ ! -f .env ]; then
  cp .env.example .env
  read -rp "  Helius API key (free at helius.dev, Enter to skip): " HK || true
  [ -n "${HK:-}" ] && sed -i "s|^HELIUS_API_KEY=.*|HELIUS_API_KEY=$HK|" .env
  read -rp "  Telegram bot token for the morning recap (Enter to skip): " TT || true
  if [ -n "${TT:-}" ]; then
    sed -i "s|^TELEGRAM_BOT_TOKEN=.*|TELEGRAM_BOT_TOKEN=$TT|" .env
    read -rp "  Telegram chat id: " TC || true
    sed -i "s|^TELEGRAM_CHAT_ID=.*|TELEGRAM_CHAT_ID=${TC:-}|" .env
  fi
fi
chmod 600 .env
mkdir -p data logs recaps
[ -f data/blacklist.txt ] || echo "# known rugger wallets, one per line:  <wallet>  # reason" > data/blacklist.txt

echo "▶ service"
sudo tee /etc/systemd/system/memedesk.service >/dev/null <<UNIT
[Unit]
Description=memedesk Solana memecoin desk
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$USER_NAME
WorkingDirectory=$DIR
ExecStart=$(command -v npx) tsx src/main.ts
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable memedesk >/dev/null

echo "▶ pre-flight"
npx tsx src/doctor.ts || echo "  (fix the ✘ items, then: ./desk start)"
echo
echo "Installed. Next: ./desk start   then   ./desk terminal"
