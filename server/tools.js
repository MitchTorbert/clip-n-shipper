// Resolves external CLI tools (yt-dlp, ffmpeg, ffprobe) to full paths.
//
// This server is launched via a double-clicked .command file, which usually
// gets a normal login-shell PATH, but we still check common Homebrew
// locations directly as a fallback in case it doesn't — cheap insurance
// against `which`-style lookups failing even when a tool is installed.

const fs = require("fs");
const path = require("path");

const EXTRA_DIRS = [
  "/opt/homebrew/bin", // Homebrew on Apple Silicon
  "/usr/local/bin", // Homebrew on Intel
  "/usr/bin",
  "/bin",
];

// A Mac set up by the installer keeps its own copies here (no Homebrew needed).
function bundledBinDir() {
  return process.env.CNS_BIN || null;
}

// ffmpeg / ffprobe that ship inside the helper's npm packages (last resort).
function fromNpm(name) {
  try {
    if (name === "ffmpeg") return require("ffmpeg-static");
    if (name === "ffprobe") return require("ffprobe-static").path;
  } catch (e) {
    // not installed
  }
  return null;
}

function resolveTool(name) {
  const own = bundledBinDir() && path.join(bundledBinDir(), name);
  if (own && fs.existsSync(own)) return own;
  const found = resolveOnPath(name);
  if (found) return found;
  const npm = fromNpm(name);
  return npm && fs.existsSync(npm) ? npm : null;
}

function resolveOnPath(name) {
  const pathDirs = (process.env.PATH || "").split(":").filter(Boolean);
  const searchDirs = [...pathDirs, ...EXTRA_DIRS];
  for (const dir of searchDirs) {
    const candidate = path.join(dir, name);
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch (e) {
      // ignore and keep looking
    }
  }
  return null;
}

function checkAllTools() {
  return {
    ytDlp: resolveTool("yt-dlp"),
    ffmpeg: resolveTool("ffmpeg"),
    ffprobe: resolveTool("ffprobe"),
  };
}

module.exports = { resolveTool, checkAllTools };
