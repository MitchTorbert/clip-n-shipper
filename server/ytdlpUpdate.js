// Keeps the installed copy of yt-dlp (the downloader) current by itself. YouTube, Twitch and X
// change often and an old yt-dlp is the most likely thing to stop working.
//
// Safe by design:
//   - only touches the copy the installer put in the helper's own bin folder (never Homebrew's)
//   - at most once a day, and never while a download is running
//   - keeps a backup, tests the new copy by asking its version, and puts the backup back if the
//     new copy doesn't run
//   - a failed update just leaves the working copy in place

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const MIN_HOURS_BETWEEN = 20;

function stampFile() {
  return path.join(process.env.CNS_BIN, ".yt-dlp-update.json");
}

function readStamp() {
  try {
    return JSON.parse(fs.readFileSync(stampFile(), "utf8"));
  } catch (e) {
    return null;
  }
}

function writeStamp(data) {
  try {
    fs.writeFileSync(stampFile(), JSON.stringify({ ...data, at: Date.now() }));
  } catch (e) {
    // not worth failing over
  }
}

function runOut(bin, args, timeout) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout }, (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || "") + String(stderr || "") }));
  });
}

const looksLikeVersion = (text) => /^\d{4}\.\d{2}\.\d{2}/.test(String(text).trim());

// Returns { status, from, to } where status is "skipped", "up-to-date", "updated", "rolled-back" or "failed".
async function updateYtDlp(tools, { force = false, log = () => {} } = {}) {
  const bin = tools.ytDlp;
  if (!process.env.CNS_BIN || !bin || !path.resolve(bin).startsWith(path.resolve(process.env.CNS_BIN))) {
    return { status: "skipped", reason: "not the installer's own copy" };
  }
  const last = readStamp();
  if (!force && last && Date.now() - last.at < MIN_HOURS_BETWEEN * 3600 * 1000) {
    return { status: "skipped", reason: "checked recently" };
  }

  const before = await runOut(bin, ["--version"], 60000);
  if (!before.ok || !looksLikeVersion(before.out)) return { status: "failed", reason: "the current copy doesn't run" };
  const from = before.out.trim();

  const backup = bin + ".bak";
  try {
    fs.copyFileSync(bin, backup);
  } catch (e) {
    return { status: "failed", reason: "couldn't make a backup: " + e.message };
  }

  const update = await runOut(bin, ["-U"], 120000);
  const after = await runOut(bin, ["--version"], 60000);
  if (!after.ok || !looksLikeVersion(after.out)) {
    // The new copy is broken: put the old one back.
    try {
      fs.copyFileSync(backup, bin);
      fs.chmodSync(bin, 0o755);
      fs.rmSync(backup, { force: true });
    } catch (e) {
      log("yt-dlp update broke the downloader and the backup couldn't be restored: " + e.message);
    }
    writeStamp({ result: "rolled-back", from });
    log(`yt-dlp update didn't work out; kept version ${from}.`);
    return { status: "rolled-back", from };
  }

  try {
    fs.rmSync(backup, { force: true });
  } catch (e) {
    // harmless leftover
  }
  const to = after.out.trim();
  if (!update.ok && to === from) {
    writeStamp({ result: "failed", from });
    return { status: "failed", from, reason: "the update check didn't finish" };
  }
  const result = to === from ? "up-to-date" : "updated";
  writeStamp({ result, from, to });
  if (result === "updated") log(`yt-dlp updated: ${from} -> ${to}`);
  return { status: result, from, to };
}

module.exports = { updateYtDlp, readStamp };
