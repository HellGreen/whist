#!/usr/bin/env bash
# Køres på Proxmox-hosten (som root). Opretter en LXC med Whist + Caddy.
#
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/HellGreen/whist/main/ct/whist.sh)"
#
# Frameworket (build.func) er community-scripts' "core"; ct/ og install/ hentes fra dette repo.
export COMMUNITY_SCRIPTS_URL="${COMMUNITY_SCRIPTS_URL:-https://raw.githubusercontent.com/HellGreen/whist/main}"
_cs_boot="${COMMUNITY_SCRIPTS_CORE_DIR:-$(dirname "${BASH_SOURCE[0]}")/../../core}/core/build.func"
source "$_cs_boot" 2>/dev/null || source <(curl -fsSL "${COMMUNITY_SCRIPTS_CORE_URL:-https://raw.githubusercontent.com/community-scripts/core/main}/core/build.func")
# License: MIT
# Source: https://github.com/HellGreen/whist

APP="Whist"
var_tags="${var_tags:-game}"
var_cpu="${var_cpu:-1}"
var_ram="${var_ram:-512}"
var_disk="${var_disk:-4}"
var_os="${var_os:-debian}"
var_version="${var_version:-13}"
var_arm64="${var_arm64:-yes}"
var_unprivileged="${var_unprivileged:-1}"

header_info "$APP"
variables
color
catch_errors

function update_script() {
  header_info
  check_container_storage
  check_container_resources

  if [[ ! -d /opt/whist/.git ]]; then
    msg_error "No ${APP} Installation Found!"
    exit
  fi

  NODE_VERSION="22" setup_nodejs

  msg_info "Stopping Service"
  systemctl stop whist
  msg_ok "Stopped Service"

  msg_info "Updating ${APP}"
  cd /opt/whist
  branch="${WHIST_BRANCH:-main}"
  before="$(runuser -u whist -- env HOME=/opt/whist git log -1 --format='%h %s')"
  runuser -u whist -- env HOME=/opt/whist git fetch --quiet origin "$branch"
  runuser -u whist -- env HOME=/opt/whist git checkout --quiet --force -B "$branch" "origin/$branch"
  $STD runuser -u whist -- env HOME=/opt/whist npm ci --omit=dev --no-audit --no-fund
  msg_ok "Updated ${APP}: ${before} -> $(runuser -u whist -- env HOME=/opt/whist git log -1 --format='%h %s')"

  msg_info "Starting Service"
  systemctl start whist
  msg_ok "Started Service"
  msg_ok "Updated successfully!"
  exit
}

start
build_container
description

msg_ok "Completed successfully!\n"
echo -e "${CREATING}${GN}${APP} setup has been successfully initialized!${CL}"
echo -e "${INFO}${YW}Access it using the following URL:${CL}"
echo -e "${GATEWAY}${BGN}http://${IP}${CL}"
echo -e "${INFO}${YW}HTTPS + TURN (webcam/mic for players on the internet): forward TCP 80,443, UDP+TCP 3478 and UDP 49152-49252 to the container, then run inside it:${CL}"
echo -e "${TAB}${BGN}whist-domain whist.yourdomain.com${CL}"
