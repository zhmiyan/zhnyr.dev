#!/usr/bin/env bash
# deploy.sh — build, copy to nginx's webroot, make sure the /fable-5-1 location exists, reload nginx.
set -euo pipefail
cd "$(dirname "$0")"
python3 build.py
DEST=/var/www/zhnyr.dev/fable-5-1
sudo mkdir -p "$DEST/assets"
sudo cp index.html build.json "$DEST/"
sudo cp assets/* "$DEST/assets/"
sudo chown -R root:root "$DEST"
sudo chmod -R a+rX "$DEST"
# nginx: serve /fable-5-1 (no trailing slash) as the page, cache assets
CONF=/etc/nginx/snippets/fable-5-1.conf
if [ ! -f "$CONF" ]; then
  sudo tee "$CONF" >/dev/null <<'EOF'
# fable-5-1 exhibit page (maintained by sapphire; deployed from ~/projects/zhnyr.dev/fable-5-1/deploy.sh)
location = /fable-5-1 { try_files /fable-5-1/index.html =404; }
location /fable-5-1/assets/ { expires 7d; add_header Cache-Control "public, max-age=604800, immutable"; }
EOF
fi
SITE=/etc/nginx/sites-available/zhnyr.dev   # sites-enabled/zhnyr.dev is a symlink to this
if ! grep -q 'snippets/fable-5-1.conf' "$SITE"; then
  sudo sed -i --follow-symlinks 's|^\(\s*\)location / {|\1include snippets/fable-5-1.conf;\n\1location / {|' "$SITE"
fi
sudo nginx -t
sudo systemctl reload nginx
echo "deployed -> https://zhnyr.dev/fable-5-1"
