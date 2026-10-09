# Windows port: status and plan

Goal: the same one-line install for editors on Windows PCs, with the same panel and helper.

## Done (step 1: the code is system-neutral)
- `server/platform.js` holds every Mac/Windows difference: tool file names (`.exe`), PATH splitting,
  opening links, and finding Premiere's / Media Encoder's H.264 preset
  (`C:\Program Files\Adobe\Adobe Premiere Pro 20xx\MediaIO\systempresets\4E49434B_48323634\...`).
- The panel understands `\` as well as `/` in file paths (`dirname`, `basename`, `joinPath` in `uxp-panel/index.js`).
- `node installer/test-platform.js` checks all of that on any machine (15 checks, simulates Windows).
- The Mac side was re-tested after the change (health check + a real clip).

## Still to do (needs a real Windows machine)
1. `installer/install.ps1` (PowerShell) doing what `install.sh` does:
   - install Node (win-x64 zip from nodejs.org), `yt-dlp.exe` (github.com/yt-dlp/yt-dlp releases),
     run `npm install --omit=dev` (ffmpeg-static / ffprobe-static ship Windows builds)
   - install the panel with Adobe's UnifiedPluginInstallerAgent (Windows path to be confirmed, probably
     under `C:\Program Files\Common Files\Adobe\Adobe Desktop Common\RemoteComponents\UPI\...`),
     falling back to a `.ccx` on the Desktop
   - start the helper at login (Task Scheduler "At log on", or a Startup-folder shortcut), with
     `CNS_BIN` pointing at the bin folder, and no console window
   - a matching `uninstall.ps1`
   - the one-liner for editors: `irm https://github.com/MitchTorbert/clip-n-shipper/releases/latest/download/install.ps1 | iex`
2. Add `install.ps1` / `uninstall.ps1` to `installer/build-release.sh` and the release assets.
3. Test on a PC: install, panel appears, Health Check all green, one real clip end to end.
4. Things to watch on Windows: where the panel shows up under the Window menu, Premiere's preset folder,
   Windows Defender / SmartScreen prompts, and long file paths.
