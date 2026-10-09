// Everything that differs between macOS and Windows lives here, so the rest of the
// helper stays the same on both. Each function takes the platform as an argument
// (defaulting to the real one) so it can be tested for the other system too.

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const PRESET_FILE = "00 - Match Source - High bitrate.epr"; // Premiere's standard H.264 preset
const PRESET_DIR = "4E49434B_48323634"; // the H.264 exporter's folder

// A tool's possible file names ("yt-dlp" is "yt-dlp.exe" on Windows).
function exeNames(name, platform = process.platform) {
  return platform === "win32" ? [name + ".exe", name] : [name];
}

// The folders in PATH. Windows separates them with ";" and may call the variable "Path".
function pathDirs(env = process.env, platform = process.platform) {
  const raw = env.PATH || env.Path || "";
  return raw.split(platform === "win32" ? ";" : ":").filter(Boolean);
}

// Where tools are commonly installed even when PATH doesn't say so.
function extraToolDirs(platform = process.platform) {
  if (platform === "darwin") return ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
  return [];
}

// Opens a web address in the default browser (only ever called with fixed addresses).
function openLink(url, platform = process.platform, run = execFile) {
  if (platform === "win32") run("rundll32", ["url.dll,FileProtocolHandler", url], () => {});
  else if (platform === "darwin") run("open", [url], () => {});
  else run("xdg-open", [url], () => {});
}

// Where Premiere and Media Encoder are installed, newest first. Returns the full paths of
// their H.264 preset files that exist.
function findH264Preset({ platform = process.platform, env = process.env, exists = fs.existsSync, list = fs.readdirSync } = {}) {
  let base;
  const presetPath = (app) =>
    platform === "win32"
      ? path.win32.join(base, app, "MediaIO", "systempresets", PRESET_DIR, PRESET_FILE)
      : path.posix.join(base, app, `${app}.app`, "Contents", "MediaIO", "systempresets", PRESET_DIR, PRESET_FILE);
  if (platform === "win32") {
    const roots = [env.ProgramFiles || "C:\\Program Files", env["ProgramFiles(x86)"]].filter(Boolean);
    for (const root of roots) {
      base = path.win32.join(root, "Adobe");
      const found = searchApps(base, list, presetPath, exists);
      if (found) return found;
    }
    return null;
  }
  base = "/Applications";
  return searchApps(base, list, presetPath, exists);
}

function searchApps(base, list, presetPath, exists) {
  let names = [];
  try {
    names = list(base);
  } catch (e) {
    return null;
  }
  const year = (n) => parseInt((n.match(/(\d{4})$/) || [0, 0])[1], 10);
  const newestFirst = (a, b) => year(b) - year(a);
  const apps = [
    ...names.filter((n) => /^Adobe Premiere Pro \d{4}$/.test(n)).sort(newestFirst),
    ...names.filter((n) => /^Adobe Media Encoder \d{4}$/.test(n)).sort(newestFirst),
  ];
  for (const app of apps) {
    const file = presetPath(app);
    if (exists(file)) return file;
  }
  return null;
}

module.exports = { exeNames, pathDirs, extraToolDirs, openLink, findH264Preset, PRESET_FILE, PRESET_DIR };
