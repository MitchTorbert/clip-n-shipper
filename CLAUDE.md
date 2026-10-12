# Clip-n-Shipper: notes for Claude

## Who you're working with
Mitch is a video editor at space150, not a programmer. Give click-by-click steps, one at a time. He gives
feedback with screenshots. Keep a visible build stamp in the panel header ("build bNN") so he can confirm a
reload. "Closest guess is fine, we fine-tune by hand." After every change on the PC, end with the full
PowerShell line to reinstall (he doesn't want to scroll back for it), and don't send him file downloads
unless he asks: changes go straight into his project folder. Don't publish, push releases, or install anything
persistent without asking first (the repo and releases are public: github.com/MitchTorbert/clip-n-shipper).

## What this is
A Premiere Pro panel (UXP, plain JS, `uxp-panel/`) plus a local Node helper (`server/`, port 8934).
Editors paste Twitch / YouTube / X links; the helper downloads them (yt-dlp), finds the facecam
(BlazeFace + edge snapping + person outline), detects Twitch captions, makes name pills via the hosted Pill
Generator service, and the panel builds sequences in the open project (folders, crops, linked audio, blurred
background for clips with no facecam, pills on V3+). It can also queue sequences to Media Encoder.

## Layout
- `uxp-panel/` panel (manifest.json, index.html, index.js, icons/). Premiere's UXP quirks are real:
  big CSS border-radius draws hexagons (pills are built from PNG caps), native inputs ignore padding
  (3 non-breaking spaces fake the inset), plain text/div overlays didn't take clicks, `<img>` does.
- `server/` helper. `platform.js` holds all Mac/Windows differences. `tools.js` finds yt-dlp/ffmpeg.
  `node installer/test-platform.js` runs the platform checks (works on any OS).
- `assets/` sounds, caption style, layout templates, Ambassador list (auto-refreshed from Twitch).
- `installer/` `install.sh` / `uninstall.sh` (Mac), `install.ps1` / `uninstall.ps1` (Windows), `build-release.sh` (builds `dist/`).
- `WINDOWS_PORT.md` the Windows work: READ THIS FIRST if you're on a PC.

## Release process
Bump `VERSION` and push to main: the GitHub Action `.github/workflows/release.yml` runs
`installer/build-release.sh` and publishes release `v<VERSION>` (marked latest) by itself. Editors run a
one-line installer; updating = running it again. (Claude sessions can push but can't create releases directly.)

## Things that bit us
- The panel says "helper out of date" when more than one helper is running or the files changed after
  it started: stop all (`pkill -f "node server/index.js"` on Mac) and start one fresh.
- The log box is hidden; user-facing feedback goes in the report under Set Up Project (`log(msg, cls, true)`).
- Face detection regression clips are in Mitch's Desktop test folders; real webcams are 5-11% tall and off
  to a side, a big centered face means a full-screen camera (blurred background, not two facecams).
- Adobe's UnifiedPluginInstallerAgent supports --install / --remove / --list. On the Mac, installing the
  .ccx this way is UNVERIFIED (a first pilot editor is testing); a .ccx on the Desktop is the fallback.
- Never bypass bot checks (streamscharts.com is behind Cloudflare; the Ambassador list now comes from
  Twitch's own GQL instead).
