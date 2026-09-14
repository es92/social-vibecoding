#!/usr/bin/env bash
#
# One-time setup for a fresh Ubuntu VPS that will host Homeroom
# standalone. Run as root on a newly-provisioned Hetzner (or similar)
# box. Idempotent — safe to re-run.
#
# What it does:
#   1. Installs Docker Engine + compose plugin
#   2. Creates a `deploy` user with passwordless sudo for docker ops
#   3. Authorizes a GitHub Actions SSH key for `deploy`
#   4. Opens firewall ports 22, 80, 443
#   5. Creates /opt/usernode (owned by deploy)
#
# Usage (run as root on the new VPS):
#
#   curl -fsSL https://raw.githubusercontent.com/Usernode-Labs/social-vibecoding/main/scripts/server-bootstrap.sh \
#     | sudo DEPLOY_SSH_PUBLIC_KEY="ssh-ed25519 AAAA... actions@github" bash
#
# Or copy the file over and:
#
#   sudo DEPLOY_SSH_PUBLIC_KEY="ssh-ed25519 AAAA..." bash server-bootstrap.sh
#
# After it completes:
#   - DNS: point <USERNODE_DOMAIN> and *.<USERNODE_DOMAIN> A records at
#     this VPS IP.
#   - GitHub: add the matching SSH *private* key to this repo's Actions
#     secrets as DEPLOY_SSH_KEY, and DEPLOY_HOST = the VPS IP/hostname.
#   - Trigger the Deploy workflow (workflow_dispatch).

set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Must be run as root (sudo bash server-bootstrap.sh)" >&2
  exit 1
fi

if [ -z "${DEPLOY_SSH_PUBLIC_KEY:-}" ]; then
  echo "DEPLOY_SSH_PUBLIC_KEY must be set (the public half of the key GitHub Actions will SSH with)." >&2
  echo "Generate a fresh keypair for this:" >&2
  echo "  ssh-keygen -t ed25519 -f usernode-deploy -C actions@usernode -N ''" >&2
  echo "Put the private half in GitHub repo secret DEPLOY_SSH_KEY." >&2
  exit 1
fi

echo "── 1. Installing system packages ──────────────────"
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
  ca-certificates \
  curl \
  gnupg \
  ufw \
  rsync

echo "── 2. Installing Docker Engine ────────────────────"
if ! command -v docker >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $VERSION_CODENAME stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
    docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
else
  echo "Docker already installed, skipping."
fi

echo "── 3. Creating deploy user ────────────────────────"
if ! id -u deploy >/dev/null 2>&1; then
  adduser --disabled-password --gecos "" deploy
fi
usermod -aG docker deploy

# Passwordless sudo is not strictly needed — deploy owns /opt/usernode
# and is in the docker group — but we add it for emergency ops.
cat > /etc/sudoers.d/deploy <<'SUDOEOF'
deploy ALL=(ALL) NOPASSWD:ALL
SUDOEOF
chmod 0440 /etc/sudoers.d/deploy

echo "── 4. Authorizing GitHub Actions SSH key ──────────"
install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
# De-dupe: only append if this exact key isn't already authorized.
if ! grep -qxF "$DEPLOY_SSH_PUBLIC_KEY" /home/deploy/.ssh/authorized_keys 2>/dev/null; then
  echo "$DEPLOY_SSH_PUBLIC_KEY" >> /home/deploy/.ssh/authorized_keys
fi
chown deploy:deploy /home/deploy/.ssh/authorized_keys
chmod 600 /home/deploy/.ssh/authorized_keys

echo "── 5. Firewall (ufw) ──────────────────────────────"
ufw allow 22/tcp >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw allow 443/udp >/dev/null  # HTTP/3 (QUIC)
# --force skips the interactive prompt. Idempotent: re-enabling an
# enabled firewall is a no-op.
ufw --force enable >/dev/null

echo "── 6. Creating /opt/usernode ──────────────────────"
mkdir -p /opt/usernode
chown -R deploy:deploy /opt/usernode

echo
echo "── Done. Next steps: ─────────────────────────────"
echo "  1. DNS: point A records for <domain> and *.<domain> at this IP"
echo "  2. GitHub repo Actions secrets:"
echo "       DEPLOY_HOST              = $(curl -fsS https://api.ipify.org 2>/dev/null || echo '<this-vps-ip>')"
echo "       DEPLOY_SSH_KEY           = (private half of the key you just authorized)"
echo "       USERNODE_ADMIN_USERNAME, USERNODE_ADMIN_PASSWORD,"
echo "       USERNODE_SESSION_SECRET, USERNODE_JWT_SECRET,"
echo "         (USERNODE_JWT_SECRET is the at-rest data key — set once,"
echo "          never rotate it or stored BYOK keys/app secrets are lost)"
echo "       USERNODE_WORKER_JWT_SECRET, USERNODE_EDGE_JWT_SECRET,"
echo "       USERNODE_IFRAME_JWT_PRIVATE_KEY, USERNODE_IFRAME_JWT_PUBLIC_KEY,"
echo "         (RSA-2048 pair, single line with literal \\n — recipe in .env.example)"
echo "       USERNODE_DB_PASSWORD,"
echo "       USERNODE_GITHUB_APP_ID, USERNODE_GITHUB_PRIVATE_KEY,"
echo "       USERNODE_GITHUB_BOT_TOKEN,"
echo "       USERNODE_ANTHROPIC_API_KEY (optional — BYOK covers the rest)"
echo "  3. GitHub repo Actions variable:"
echo "       USERNODE_DOMAIN          = the domain you just pointed at this VPS"
echo "  4. Trigger the Deploy workflow (Actions tab → Deploy → Run workflow)"
