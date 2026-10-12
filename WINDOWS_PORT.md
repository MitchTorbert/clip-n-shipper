# Windows port: status and plan

Goal: the same one-line install for editors on Windows PCs, with the same panel and helper.

## Done (step 1: the code is system-neutral)
- `server/platform.js` holds every Mac/Windows difference: tool file names (`.exe`), PATH splitting,
  opening links, and finding Premiere's / Media Encoder's H.264 preset
  (`C:\Program Files\Adobe\Adobe Premiere Pro 20xx\MediaIO\systempresets\4E49434B_48323634\...`).
- The panel understands `\` as well as `/` in file paths (`dirname`, `basename`, `joinPath` in `uxp-panel/index.js`).
- `node installer/test-platform.js` checks all of that on any machine (15 checks, simulates Windows).
- The Mac side was re-tested after the change (health check + a real clip).

## Written, not yet run on a PC (step 2: the Windows installer)
- `installer/install.ps1` / `installer/uninstall.ps1`, the same 5 steps and the same `CNS_*` test
  variables as `install.sh`. Editor one-liner:
  `irm https://github.com/MitchTorbert/clip-n-shipper/releases/latest/download/install.ps1 | iex`
- Installs into `%LOCALAPPDATA%\Clip-n-Shipper` (`app\`, `node\`, `bin\yt-dlp.exe`, `helper.log`,
  `run-helper.ps1`). No admin needed.
- Adobe's plugin installer, CONFIRMED on Mitch's PC (Oct 2026):
  `C:\Program Files\Common Files\Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe`
  Adobe documents the Windows flags with a slash (`/install file.ccx`, `/remove name`); the script
  tries `--install` too if `/install` fails, then falls back to a `.ccx` on the Desktop
  (the real Desktop, including OneDrive's).
- Start at login: an HKCU `Run` entry launches `run-helper.ps1` with hidden PowerShell. It loops
  node with `CLIPNSHIP_AUTORESTART=1`, restarting it 10 s after it quits (like launchd KeepAlive).
  A Run entry was chosen over Task Scheduler because it never needs admin.
- The script must never call `exit` (it runs via `iex` inside the editor's window) and must stay ASCII.
- Updating stops the old helper first: Windows won't delete a folder a running program is using.

## Tested on Mitch's PC (Oct 2026, Premiere 26.5.2), released as v1.1.0
- `install.ps1` installs and the helper runs at log on; panel installed via UPIA `/install`.
- Windows-only panel fixes (all under `body.win` / `isWindows`): URL box height, vector aspect-ratio icons
  (`icons/win/`), fixed-width Set Up button, a text box lets go of the cursor when the mouse reaches a button
  (native inputs swallowed the first click), poll retries while face detection keeps the helper busy.
- Helper on Windows: yields between face-detection steps; Clear Project skips files Premiere still has locked.
- Global changes in the same release: full-camera rule (a face >=12% of frame height in 2+ frames -> blur),
  same-face check (different people in one spot -> blur), sharp weak-edge snapping for webcam borders,
  sequences match the footage frame rate (lowest when mixed; Premiere 26.2+), Make Pills saves a name still
  being typed.

## Still to do
1. Re-run the Mac face-detection regression clips against the new rules.
2. Watch on Windows: SmartScreen/Defender prompts on other PCs, long file paths, a brief PowerShell flash at log on.
