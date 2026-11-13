#!/usr/bin/env bash
# Køres inde i containeren af ct/whist.sh (starter ikke af sig selv).
# License: MIT
# Source: https://github.com/HellGreen/whist

source /dev/stdin <<<"$FUNCTIONS_FILE_PATH"
color
verb_ip6
catch_errors
setting_up_container
network_check
update_os

msg_info "Installing Dependencies"
$STD apt install -y git caddy
msg_ok "Installed Dependencies"

NODE_VERSION="22" setup_nodejs

msg_info "Installing Whist"
useradd --system --home /opt/whist --shell /usr/sbin/nologin whist
git clone -q https://github.com/HellGreen/whist.git /opt/whist
chown -R whist: /opt/whist
cd /opt/whist
$STD runuser -u whist -- env HOME=/opt/whist npm ci --omit=dev --no-audit --no-fund
msg_ok "Installed Whist"

msg_info "Creating Service"
cat <<EOF >/etc/systemd/system/whist.service
[Unit]
Description=Es-makker whist
After=network.target

[Service]
WorkingDirectory=/opt/whist
ExecStart=/usr/bin/node server/index.js
Environment=PORT=3000
Restart=always
User=whist

[Install]
WantedBy=multi-user.target
EOF
systemctl enable -q --now whist
msg_ok "Created Service"

msg_info "Configuring Caddy"
cat <<EOF >/etc/caddy/Caddyfile
# Ingen domæne endnu: ren HTTP på port 80. Kør 'whist-domain <domæne>' for automatisk HTTPS.
:80 {
	reverse_proxy localhost:3000
}
EOF
cat <<'EOF' >/usr/local/bin/whist-domain
#!/usr/bin/env bash
# Brug: whist-domain whist.ditdomæne.dk   (domænet skal pege på din offentlige IP, port 80+443 videresendt hertil)
set -euo pipefail
[ $# -eq 1 ] || { echo "Brug: whist-domain <domæne>" >&2; exit 1; }
cat >/etc/caddy/Caddyfile <<CADDY
$1 {
	reverse_proxy localhost:3000
}
CADDY
systemctl reload caddy
echo "Caddy henter nu certifikat til $1. Følg med: journalctl -u caddy -f"
EOF
chmod +x /usr/local/bin/whist-domain
systemctl enable -q caddy
systemctl restart caddy
msg_ok "Configured Caddy"

motd_ssh
customize
cleanup_lxc
