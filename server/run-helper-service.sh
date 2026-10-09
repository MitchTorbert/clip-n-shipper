#!/bin/zsh
# Used by the optional background login service. Same as the .command file,
# minus the Terminal window; the service manager restarts it whenever it exits.
cd "$(dirname "$0")/.."
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
export CLIPNSHIP_AUTORESTART=1
exec node server/index.js
