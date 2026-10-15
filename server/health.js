// Health check: tests the pieces on the helper's side that tend to break when
// something outside changes (Twitch, yt-dlp, the pill service, Premiere's presets).
// Returns rows of { level: "ok" | "warn" | "err", label, detail }.

const fs = require("fs");
const { execFile } = require("child_process");

const YTDLP_WARN_DAYS = 60;

function runOut(bin, args) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: 60000 }, (err, stdout) => resolve(err ? null : String(stdout).trim()));
  });
}

async function fetchOk(url, init) {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(8000) });
    return { ok: res.ok, status: res.status, res };
  } catch (e) {
    return { ok: false, status: 0, error: e.message };
  }
}

async function runHealth(tools, ctx) {
  const rows = [];
  const add = (level, label, detail) => rows.push({ level, label, detail });

  add("ok", "Helper", `v${ctx.version || "?"}, running (Node ${process.version})`);

  if (!tools.ytDlp) add("err", "yt-dlp (downloader)", "not found. Run the Clip-n-Shipper installer again");
  else {
    const v = await runOut(tools.ytDlp, ["--version"]);
    const m = v && v.match(/^(\d{4})\.(\d{2})\.(\d{2})/);
    if (!m) add("warn", "yt-dlp (downloader)", "installed, but its version couldn't be read");
    else {
      // Compare with the newest release (an old-looking version is fine if it IS the newest).
      let latest = null;
      const rel = await fetchOk("https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest", { headers: { "User-Agent": "clip-n-shipper" } });
      if (rel.ok) {
        try {
          latest = String((await rel.res.json()).tag_name || "").trim();
        } catch (e) {
          // fall back to the age rule
        }
      }
      const days = Math.floor((Date.now() - Date.UTC(+m[1], +m[2] - 1, +m[3])) / 86400000);
      const stamp = ctx.ytdlpStamp;
      const auto = ctx.ytdlpBundled ? (stamp ? `; checked for updates ${Math.max(0, Math.round((Date.now() - stamp.at) / 3600000))}h ago` : "; checks for updates by itself") : "";
      if (latest && latest === v) add("ok", "yt-dlp (downloader)", `${v}, the newest${auto}`);
      else if (latest) {
        add("warn", "yt-dlp (downloader)", ctx.ytdlpBundled ? `${v}; ${latest} is out and will install itself within a day${auto}` : `${v}; ${latest} is out. Update it: brew upgrade yt-dlp`);
      } else if (days > YTDLP_WARN_DAYS) add("warn", "yt-dlp (downloader)", `${v} is ${days} days old (couldn't check for a newer one)`);
      else add("ok", "yt-dlp (downloader)", `${v}${auto}`);
    }
  }
  add(tools.ffmpeg ? "ok" : "err", "ffmpeg", tools.ffmpeg ? "found" : "not found — install with: brew install ffmpeg");
  add(tools.ffprobe ? "ok" : "err", "ffprobe", tools.ffprobe ? "found" : "not found — install with: brew install ffmpeg");

  const twitch = await fetchOk("https://gql.twitch.tv/gql", {
    method: "POST",
    headers: { "Client-ID": "kimne78kx3ncx6brgo4mv6wki5h1ko", "Content-Type": "application/json" },
    body: JSON.stringify({ query: '{ team(name: "ambassadors") { displayName } }' }),
  });
  let twitchWorks = false;
  if (twitch.ok) {
    try {
      twitchWorks = !!(await twitch.res.json()).data.team;
    } catch (e) {
      // handled below
    }
  }
  add(twitchWorks ? "ok" : "err", "Twitch lookups", twitchWorks ? "working (names, link checks, Ambassadors)" : "Twitch didn't answer as expected — streamer names and link checks may fail");

  const pill = await fetchOk(ctx.pillService + "/api/status");
  add(pill.ok ? "ok" : "err", "Pill Generator service", pill.ok ? "reachable" : "not reachable — pills can't be made right now");

  const ambassadors = ctx.ambassadorCount();
  add(ambassadors >= 100 ? "ok" : "warn", "Ambassador list", `${ambassadors} channels`);

  const preset = ctx.h264Preset();
  add(preset ? "ok" : "warn", "H.264 export preset", preset ? "found (Match Source - High bitrate)" : "not found — Queue to Media Encoder won't work");

  const missingAssets = ctx.assets.filter((f) => !fs.existsSync(f));
  add(missingAssets.length ? "warn" : "ok", "Bundled files", missingAssets.length ? `${missingAssets.length} missing (sounds / templates)` : "sounds, templates and caption style present");

  return rows;
}

module.exports = { runHealth };
