#!/bin/sh
# Creates the Cloudflare tunnel for the public server and stores its token in msecrets.json
# (production). Run once from apps/public, on a machine with cloudflared:
#
#   npm run tunnel
#
# The first run opens a browser to authorize cloudflared for the mwdapis.stream zone. Running it
# again is safe: the tunnel and the DNS record are reused, and the token is written again.
set -e
cd "$(dirname "$0")/.."
name=${TUNNEL_NAME:-matrix-public}
hostname=${TUNNEL_HOSTNAME:-matrix.mwdapis.stream}

[ -f "$HOME/.cloudflared/cert.pem" ] || cloudflared tunnel login
cloudflared tunnel info "$name" >/dev/null 2>&1 || cloudflared tunnel create "$name"
# A CNAME from the hostname to the tunnel (replaces an existing record for the hostname).
cloudflared tunnel route dns --overwrite-dns "$name" "$hostname"
# The token goes straight into the encrypted file, never to the terminal.
cloudflared tunnel token "$name" | npx msecrets set CLOUDFLARE_TUNNEL_TOKEN -e production
echo "Tunnel $name serves $hostname; its token is in msecrets.json (production)."
