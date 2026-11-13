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
$STD apt install -y git caddy coturn
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
mkdir -p /etc/whist
echo "WHIST_TURN_SECRET=$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')" >/etc/whist/env
chown root:whist /etc/whist/env
chmod 640 /etc/whist/env
cat <<EOF >/etc/systemd/system/whist.service
[Unit]
Description=Es-makker whist
After=network.target

[Service]
WorkingDirectory=/opt/whist
ExecStart=/usr/bin/node server/index.js
Environment=PORT=3000
EnvironmentFile=/etc/whist/env
Restart=always
User=whist

[Install]
WantedBy=multi-user.target
EOF
systemctl enable -q --now whist
msg_ok "Created Service"

msg_info "Configuring Caddy and TURN"
cat <<EOF >/etc/caddy/Caddyfile
# Ingen domæne endnu: ren HTTP på port 80. Kør 'whist-domain <domæne>' for automatisk HTTPS.
:80 {
	reverse_proxy localhost:3000
}
EOF

# Skriver /etc/turnserver.conf ud fra domænet og hemmeligheden. Køres også før hver start af coturn,
# så external-ip følger domænets aktuelle IP (nyttigt med dynamisk IP + DDNS).
cat <<'EOF' >/usr/local/bin/whist-turn-conf
#!/usr/bin/env bash
set -euo pipefail
domain="$(cat /etc/whist/domain 2>/dev/null || true)"
[ -n "$domain" ] || exit 0
secret="$(sed -n 's/^WHIST_TURN_SECRET=//p' /etc/whist/env)"
private_ip="$(hostname -I | awk '{print $1}')"
public_ip="$(getent ahostsv4 "$domain" | awk 'NR==1{print $1}')"
{
  echo "listening-port=3478"
  echo "fingerprint"
  echo "use-auth-secret"
  echo "static-auth-secret=$secret"
  echo "realm=$domain"
  echo "min-port=49152"
  echo "max-port=49252"
  echo "no-cli"
  echo "no-multicast-peers"
  echo "denied-peer-ip=0.0.0.0-0.255.255.255"
  echo "denied-peer-ip=127.0.0.0-127.255.255.255"
  [ -n "$public_ip" ] && echo "external-ip=$public_ip/$private_ip"
} >/etc/turnserver.conf
chown root:turnserver /etc/turnserver.conf
chmod 640 /etc/turnserver.conf
EOF

cat <<'EOF' >/usr/local/bin/whist-domain
#!/usr/bin/env bash
# Brug: whist-domain whist.ditdomæne.dk
# Domænet skal pege på din offentlige IP (Cloudflare: DNS only, ikke proxy). Videresend til containeren:
#   TCP 80, 443 (Caddy/HTTPS)  ·  UDP+TCP 3478 og UDP 49152-49252 (TURN til kamera/lyd for spillere på internettet)
set -euo pipefail
[ $# -eq 1 ] || { echo "Brug: whist-domain <domæne>" >&2; exit 1; }
echo "$1" >/etc/whist/domain
sed -i '/^WHIST_TURN_HOST=/d' /etc/whist/env
echo "WHIST_TURN_HOST=$1" >>/etc/whist/env
cat >/etc/caddy/Caddyfile <<CADDY
$1 {
	reverse_proxy localhost:3000
}
CADDY
/usr/local/bin/whist-turn-conf
systemctl reload caddy
systemctl restart coturn whist
echo "Caddy henter nu certifikat til $1. Følg med: journalctl -u caddy -f"
echo "TURN: $1:3478. Tjek: journalctl -u coturn -n 20"
EOF
chmod +x /usr/local/bin/whist-turn-conf /usr/local/bin/whist-domain

mkdir -p /etc/systemd/system/coturn.service.d
cat <<EOF >/etc/systemd/system/coturn.service.d/whist.conf
[Service]
ExecStartPre=+/usr/local/bin/whist-turn-conf
EOF
systemctl daemon-reload
systemctl enable -q caddy coturn
systemctl restart caddy
systemctl stop coturn
msg_ok "Configured Caddy and TURN"

motd_ssh
customize
cleanup_lxc
