#!/bin/bash
# Install Caddy (stock) on Oracle Linux for NIO API reverse proxy.
# Upstream: https://127.0.0.1:8787 (self-signed) — tls_insecure_skip_verify on local hop only.
set -euo pipefail

HOSTNAME_FILE=/etc/nio-caddy.hostname
TOKEN_ENV=/etc/nio-duckdns.env

if ! sudo test -f "$HOSTNAME_FILE"; then
  echo "Missing $HOSTNAME_FILE (single line: nio-api-xxx.duckdns.org)" >&2
  exit 1
fi
HOST=$(sudo cat "$HOSTNAME_FILE" | tr -d '[:space:]')
if [[ ! "$HOST" =~ \.duckdns\.org$ ]]; then
  echo "Hostname must be a *.duckdns.org name: got $HOST" >&2
  exit 1
fi

echo "Installing Caddy for $HOST ..."

# Official Caddy yum repo (Fedora COPR / Cloudsmith style for RHEL)
if ! command -v caddy >/dev/null 2>&1; then
  sudo dnf install -y 'dnf-command(copr)' || true
  # Prefer static binary — micro VM may struggle with build tools
  ARCH=$(uname -m)
  case "$ARCH" in
    x86_64) CADDY_ARCH=amd64 ;;
    aarch64) CADDY_ARCH=arm64 ;;
    *) echo "unsupported arch $ARCH"; exit 1 ;;
  esac
  VER=2.9.1
  TMP=$(mktemp -d)
  cd "$TMP"
  curl -fsSL -o caddy.tar.gz "https://github.com/caddyserver/caddy/releases/download/v${VER}/caddy_${VER}_linux_${CADDY_ARCH}.tar.gz"
  tar -xzf caddy.tar.gz caddy
  sudo install -m 755 caddy /usr/local/bin/caddy
  cd /
  rm -rf "$TMP"
fi

CADDY_BIN=/usr/local/bin/caddy
"$CADDY_BIN" version

sudo mkdir -p /etc/caddy /var/lib/caddy /var/log/caddy
sudo tee /etc/caddy/Caddyfile >/dev/null <<EOF
# NIO API — public trusted HTTPS → local self-signed Node API
# Public clients must verify this cert. Local hop to Node skips verify (self-signed).
${HOST} {
	encode gzip
	reverse_proxy https://127.0.0.1:8787 {
		transport http {
			tls_insecure_skip_verify
		}
		header_up Host {host}
		header_up X-Forwarded-Proto {scheme}
		header_up X-Real-IP {remote_host}
	}
	header {
		Strict-Transport-Security "max-age=31536000; includeSubDomains"
		-Server
	}
	log {
		output file /var/log/caddy/nio-api.log
		format console
	}
}
EOF

# systemd unit
sudo tee /etc/systemd/system/caddy.service >/dev/null <<'EOF'
[Unit]
Description=Caddy reverse proxy for NIO API
Documentation=https://caddyserver.com/docs/
After=network-online.target nio-gate-i.service
Wants=network-online.target
Requires=nio-gate-i.service

[Service]
Type=notify
User=root
Group=root
ExecStart=/usr/local/bin/caddy run --environ --config /etc/caddy/Caddyfile
ExecReload=/usr/local/bin/caddy reload --config /etc/caddy/Caddyfile --force
TimeoutStopSec=5s
LimitNOFILE=1048576
LimitNPROC=512
PrivateTmp=true
ProtectSystem=full
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# Host firewall: open 80/443 for ACME + HTTPS; keep 8787 during cutover
sudo firewall-cmd --permanent --add-port=80/tcp || true
sudo firewall-cmd --permanent --add-port=443/tcp || true
sudo firewall-cmd --reload || true

sudo systemctl daemon-reload
sudo "$CADDY_BIN" validate --config /etc/caddy/Caddyfile
sudo systemctl enable caddy
sudo systemctl restart caddy
sleep 3
systemctl is-active caddy || true
sudo journalctl -u caddy -n 50 --no-pager || true
ss -tlnp | grep -E ':80 |:443 ' || true

echo "Caddy installed for $HOST. OCI security list must allow TCP 80+443 for Let's Encrypt + public HTTPS."
