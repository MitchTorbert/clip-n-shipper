#!/bin/bash
# Builds the files a release needs into ./dist :
#   clip-n-shipper-panel.ccx   (the Premiere panel, both systems)
#   clip-n-shipper-helper.zip  (helper code + assets, no node_modules, both systems)
#   install.sh / uninstall.sh      (Mac)
#   install.ps1 / uninstall.ps1    (Windows)
set -euo pipefail
cd "$(dirname "$0")/.."
# One source of truth: VERSION. The panel reads its own version from its manifest, so stamp it in.
python3 - <<'PYEOF'
import json
version = open("VERSION").read().strip()
m = json.load(open("uxp-panel/manifest.json"))
m["version"] = version
json.dump(m, open("uxp-panel/manifest.json", "w"), indent=2)
open("uxp-panel/manifest.json", "a").write("\n")
print("panel version stamped:", version)
PYEOF
rm -rf dist; mkdir -p dist
( cd uxp-panel && zip -qr ../dist/clip-n-shipper-panel.ccx . -x ".DS_Store" "*.DS_Store" "icons/ambassador check.svg" )
zip -qr dist/clip-n-shipper-helper.zip server assets VERSION -x "server/node_modules/*" "*.DS_Store"
cp installer/install.sh installer/uninstall.sh installer/install.ps1 installer/uninstall.ps1 dist/
ls -la dist
