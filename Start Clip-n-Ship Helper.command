#!/bin/zsh
cd "$(dirname "$0")"
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

echo "Starting Clip-n-Ship Helper..."
echo "(leave this window open while you use the panel in Premiere - closing it stops the helper)"
echo ""

node server/index.js
