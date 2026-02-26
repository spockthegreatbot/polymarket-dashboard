#!/bin/bash
set -e

echo "=== PolyIntel Setup ==="

# Install dependencies
echo "Installing dependencies..."
cd "$(dirname "$0")"
npm install --production

# Create systemd service
echo "Creating systemd service..."
sudo tee /etc/systemd/system/polyintel.service > /dev/null << EOF
[Unit]
Description=PolyIntel - Polymarket Intelligence Dashboard
After=network.target

[Service]
Type=simple
User=$(whoami)
WorkingDirectory=$(pwd)
ExecStart=$(which node) server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable polyintel
sudo systemctl start polyintel

echo ""
echo "✅ PolyIntel is running!"
echo "   Dashboard: http://$(hostname -I | awk '{print $1}'):8877"
echo "   Status:    sudo systemctl status polyintel"
echo "   Logs:      sudo journalctl -u polyintel -f"
