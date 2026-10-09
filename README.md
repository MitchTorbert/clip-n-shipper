# Clip-n-Shipper

A Premiere Pro panel plus a small local helper. Paste Twitch / YouTube / X links and it downloads the
footage, finds each streamer's facecam, builds the sequences (folders, layout, crops, audio), makes the
name pills, and can queue renders to Media Encoder.

Made by space150.

## Install (for editors)
Open **Terminal** (press ⌘-Space, type Terminal, press Return), paste this one line, and press Return:

```
curl -fsSL https://github.com/MitchTorbert/clip-n-shipper/releases/latest/download/install.sh | bash
```

It takes a few minutes. When it says "All done", quit Premiere and open it again. The panel is under
**Window ▸ Extensions ▸ Clip-n-Shipper**.

**To update:** run the same line again. **To remove it:** run
`curl -fsSL https://github.com/MitchTorbert/clip-n-shipper/releases/latest/download/uninstall.sh | bash`

---

## What's in here
- `uxp-panel/` — the Premiere panel (loaded with the UXP Developer Tool).
- `server/` — the helper that downloads clips, finds facecams and talks to the Pill Generator service.
- `assets/` — sounds, caption style, layout templates, and the Twitch Ambassador list.
- `Start Clip-n-Ship Helper.command` — double-click to start the helper before using the panel.

## Developer setup (loading the panel by hand)
1. Install Homebrew, then in Terminal: `brew install node yt-dlp ffmpeg`
2. In the `server` folder: `npm install`
3. In the UXP Developer Tool: Add Plugin → choose `uxp-panel/manifest.json` → Load.
4. Double-click `Start Clip-n-Ship Helper.command` and leave its window open.

## Keeping it healthy
- Footer → **Health Check** tests every moving part and says what to fix.
- Update the downloader now and then: `brew upgrade yt-dlp`.
- Footer → **Report an Issue** sends a report to the team.

## Making a release
`bash installer/build-release.sh` builds `dist/` (the `.ccx` panel, the helper zip, `install.sh`, `uninstall.sh`).
Publish those four files on a GitHub release; the installer always fetches the latest.
