#!/bin/bash
# Clip-n-Shipper installer. Safe to run again: running it is also how you update.
#
#   curl -fsSL https://github.com/MitchTorbert/clip-n-shipper/releases/latest/download/install.sh | bash
#
# What it does (all inside your own user account, no admin password):
#   1. puts the helper and its tools in ~/Library/Application Support/Clip-n-Shipper
#   2. installs the Premiere panel (through Adobe's own plugin installer)
#   3. makes the helper start by itself when you log in
set -euo pipefail

REPO="MitchTorbert/clip-n-shipper"
RELEASE="https://github.com/${REPO}/releases/latest/download"
HOME_DIR="${CNS_HOME:-$HOME/Library/Application Support/Clip-n-Shipper}"
NODE_VERSION="v24.21.0"
LABEL="com.clipnshipper.helper"
PORT="${CNS_PORT:-8934}"
UPIA="/Library/Application Support/Adobe/Adobe Desktop Common/RemoteComponents/UPI/UnifiedPluginInstallerAgent/UnifiedPluginInstallerAgent.app/Contents/MacOS/UnifiedPluginInstallerAgent"

say()  { printf "\n\033[1m%s\033[0m\n" "$1"; }
fail() { printf "\n\033[31mSomething went wrong: %s\033[0m\n" "$1"; echo "Take a screenshot of this window and send it to Mitch."; exit 1; }

[ "$(uname -s)" = "Darwin" ] || fail "This installer is for Mac."
case "$(uname -m)" in
  arm64)  NODE_ARCH="arm64" ;;
  x86_64) NODE_ARCH="x64" ;;
  *) fail "Unknown Mac type $(uname -m)" ;;
esac

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fetch() { # fetch <file-name> <destination>   (a local release folder can stand in for the web, for testing)
  if [ -n "${CNS_LOCAL_RELEASE:-}" ]; then cp "$CNS_LOCAL_RELEASE/$1" "$2"; else curl -fsSL "$RELEASE/$1" -o "$2"; fi
}

say "1/5  Getting the latest Clip-n-Shipper…"
mkdir -p "$HOME_DIR/bin"
fetch clip-n-shipper-helper.zip "$TMP/helper.zip" || fail "couldn't download the helper (check your internet connection)"
rm -rf "$HOME_DIR/app.new"; mkdir -p "$HOME_DIR/app.new"
unzip -q "$TMP/helper.zip" -d "$HOME_DIR/app.new"
VERSION="$(cat "$HOME_DIR/app.new/VERSION" 2>/dev/null || echo "?")"
# keep the installed packages across updates so they don't re-download
[ -d "$HOME_DIR/app/server/node_modules" ] && mv "$HOME_DIR/app/server/node_modules" "$HOME_DIR/app.new/server/node_modules"
rm -rf "$HOME_DIR/app"; mv "$HOME_DIR/app.new" "$HOME_DIR/app"
echo "Version $VERSION"

say "2/5  Setting up the tools it needs…"
if [ ! -x "$HOME_DIR/node/bin/node" ]; then
  echo "Downloading Node…"
  curl -fsSL "https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-darwin-${NODE_ARCH}.tar.gz" -o "$TMP/node.tgz" || fail "couldn't download Node"
  rm -rf "$HOME_DIR/node"; mkdir -p "$HOME_DIR/node"
  tar -xzf "$TMP/node.tgz" -C "$HOME_DIR/node" --strip-components 1
fi
echo "Downloading the video downloader (yt-dlp)…"
curl -fsSL "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos" -o "$HOME_DIR/bin/yt-dlp" || fail "couldn't download yt-dlp"
chmod +x "$HOME_DIR/bin/yt-dlp"
echo "Installing the helper's packages (a minute or two the first time)…"
( cd "$HOME_DIR/app/server" && PATH="$HOME_DIR/node/bin:$PATH" "$HOME_DIR/node/bin/npm" install --omit=dev --no-audit --no-fund >"$TMP/npm.log" 2>&1 ) || { tail -15 "$TMP/npm.log"; fail "couldn't install the helper's packages"; }

say "3/5  Installing the Premiere panel…"
fetch clip-n-shipper-panel.ccx "$TMP/Clip-n-Shipper.ccx" || fail "couldn't download the panel"
if [ "${CNS_SKIP_PANEL:-}" = "1" ]; then
  echo "(skipped)"
elif [ -x "$UPIA" ]; then
  # Replace any older copy first, so an update is clean.
  "$UPIA" --remove "Clip-n-Shipper" >/dev/null 2>&1 || true
  "$UPIA" --remove "Clip-n-Ship Setup" >/dev/null 2>&1 || true
  if "$UPIA" --install "$TMP/Clip-n-Shipper.ccx" >"$TMP/upia.log" 2>&1; then
    echo "Panel installed."
  else
    cp "$TMP/Clip-n-Shipper.ccx" "$HOME/Desktop/Clip-n-Shipper.ccx"
    echo "Adobe's installer didn't accept it automatically."
    echo "Double-click  Clip-n-Shipper.ccx  on your Desktop to finish (Creative Cloud will install it)."
  fi
else
  cp "$TMP/Clip-n-Shipper.ccx" "$HOME/Desktop/Clip-n-Shipper.ccx"
  echo "Creative Cloud's plugin installer wasn't found."
  echo "Double-click  Clip-n-Shipper.ccx  on your Desktop to finish (Creative Cloud will install it)."
fi

say "4/5  Making the helper start by itself…"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
if [ "${CNS_SKIP_AGENT:-}" = "1" ]; then
  echo "(skipped)"
else
  mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
  cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${HOME_DIR}/node/bin/node</string><string>${HOME_DIR}/app/server/index.js</string></array>
  <key>WorkingDirectory</key><string>${HOME_DIR}/app</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CNS_BIN</key><string>${HOME_DIR}/bin</string>
    <key>PATH</key><string>${HOME_DIR}/bin:${HOME_DIR}/node/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${HOME}/Library/Logs/Clip-n-Shipper.log</string>
  <key>StandardErrorPath</key><string>${HOME}/Library/Logs/Clip-n-Shipper.log</string>
</dict>
</plist>
PLISTEOF
  launchctl bootout "gui/$(id -u)/${LABEL}" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST" || fail "couldn't start the helper"
fi

say "5/5  Checking that the helper is up…"
if [ "${CNS_SKIP_AGENT:-}" = "1" ]; then
  echo "(skipped)"
else
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
    if curl -fs "http://127.0.0.1:${PORT}/ping" >/dev/null 2>&1; then OK=1; break; fi
    sleep 2
  done
  [ "${OK:-}" = "1" ] || fail "the helper didn't start (details are in ~/Library/Logs/Clip-n-Shipper.log)"
  echo "Helper is running."
fi

say "All done!  (version $VERSION)"
echo "Next: quit Premiere if it's open, then open it again."
echo "Find the panel under  Window ▸ Extensions ▸ Clip-n-Shipper."
echo "To update later, just run this installer again."
