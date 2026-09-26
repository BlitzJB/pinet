#!/usr/bin/env bash
# Idempotent installer for the PiNet coordinator on Debian/Ubuntu with systemd
# and nginx. Run as root from the repository root:
#
#   sudo DOMAIN=pineit.bharathi.fi ./deploy/install.sh
#
set -euo pipefail

DOMAIN="${DOMAIN:-pineit.bharathi.fi}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR=/opt/pinet
DATA_DIR=/var/lib/pinet
CONF_DIR=/etc/pinet
ENV_FILE="$CONF_DIR/coordinator.env"
SERVICE=pinet-coordinator

if [[ "$(id -u)" -ne 0 ]]; then
  echo "run as root" >&2
  exit 1
fi

echo "==> user and directories"
id -u pinet >/dev/null 2>&1 || useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin pinet
install -d -m 0700 -o pinet -g pinet "$DATA_DIR"
install -d -m 0755 -o root -g root "$APP_DIR"
install -d -m 0750 -o root -g pinet "$CONF_DIR"

echo "==> application"
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete --exclude node_modules --exclude .git "$REPO_DIR"/ "$APP_DIR"/
else
  find "$APP_DIR" -mindepth 1 -delete
  cp -a "$REPO_DIR"/. "$APP_DIR"/
  rm -rf "$APP_DIR/.git" "$APP_DIR/node_modules"
fi
( cd "$APP_DIR" && npm install --omit=dev --omit=peer --no-audit --no-fund )

echo "==> web app"
if [[ -f "$APP_DIR/web/package.json" ]]; then
  ( cd "$APP_DIR/web" && npm install --no-audit --no-fund && npm run build )
else
  echo "    no web/ directory; /app will show a build notice"
fi

echo "==> configuration"
if [[ ! -f "$ENV_FILE" ]]; then
  SESSION_SECRET="$(openssl rand -hex 32)"
  SERVER_ID="srv_$(openssl rand -hex 6)"
  cat > "$ENV_FILE" <<EOF
PINET_HOST=127.0.0.1
PINET_PORT=8787
PINET_PUBLIC_URL=https://$DOMAIN
PINET_SERVER_ID=$SERVER_ID
PINET_SESSION_SECRET=$SESSION_SECRET
PINET_DATA_DIR=$DATA_DIR

# Bring your own Google OAuth client (Web application).
# Authorized redirect URI: https://$DOMAIN/auth/callback
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=https://$DOMAIN/auth/callback
EOF
  echo "    generated $ENV_FILE (add Google credentials, then restart)"
else
  echo "    keeping existing $ENV_FILE"
fi
chown pinet:pinet "$ENV_FILE"
chmod 0600 "$ENV_FILE"

echo "==> systemd"
install -m 0644 "$APP_DIR/deploy/pinet-coordinator.service" "/etc/systemd/system/$SERVICE.service"
systemctl daemon-reload
systemctl enable "$SERVICE"
systemctl restart "$SERVICE"

echo "==> nginx"
install -m 0644 "$APP_DIR/deploy/nginx-pinet-upgrade.conf" /etc/nginx/conf.d/pinet-upgrade.conf
if [[ -d "/etc/letsencrypt/live/$DOMAIN" ]]; then
  echo "    TLS certificate present; leaving certbot-managed vhost untouched"
else
  sed "s/__DOMAIN__/$DOMAIN/g" "$APP_DIR/deploy/nginx-pinet.conf" > /etc/nginx/sites-available/pinet
  chmod 0644 /etc/nginx/sites-available/pinet
fi
ln -sf /etc/nginx/sites-available/pinet /etc/nginx/sites-enabled/pinet
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

echo "==> firewall"
if command -v ufw >/dev/null 2>&1; then
  ufw allow 80/tcp >/dev/null || true
  ufw allow 443/tcp >/dev/null || true
fi

echo
 echo "Coordinator status:"
systemctl --no-pager --lines=5 status "$SERVICE" || true
echo
echo "Local health:"
curl -fsS http://127.0.0.1:8787/health && echo
echo
 if [[ -d "/etc/letsencrypt/live/$DOMAIN" ]]; then
  echo "TLS already configured for $DOMAIN; health:"
  curl -fsS "https://$DOMAIN/health" && echo
else
  echo "Next: point $DOMAIN (A/AAAA) at this host, then run:"
  echo "  certbot --nginx -d $DOMAIN --redirect --agree-tos -m you@example.com"
fi
