#!/bin/bash
# Removes Clip-n-Shipper completely.
UPIA="/Library/Application Support/Adobe/Adobe Desktop Common/RemoteComponents/UPI/UnifiedPluginInstallerAgent/UnifiedPluginInstallerAgent.app/Contents/MacOS/UnifiedPluginInstallerAgent"
LABEL="com.clipnshipper.helper"
launchctl bootout "gui/$(id -u)/${LABEL}" >/dev/null 2>&1 || true
rm -f "$HOME/Library/LaunchAgents/${LABEL}.plist"
[ -x "$UPIA" ] && "$UPIA" --remove "Clip-n-Shipper" >/dev/null 2>&1
rm -rf "$HOME/Library/Application Support/Clip-n-Shipper"
echo "Clip-n-Shipper has been removed. Restart Premiere to finish."
