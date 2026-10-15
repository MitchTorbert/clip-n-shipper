// Downloads a single Twitch clip via yt-dlp and reads back its metadata.
// Every external command runs through execFile with an argument ARRAY
// (never a shell string) so a clip title or URL can never be interpreted
// as a shell command.

const { execFile } = require("child_process");
const os = require("os");
const path = require("path");
const fs = require("fs");

// A Twitch clip is at most a minute or two (X videos can run longer, but a
// stringout source is never close to this); anything much longer is a VOD or stream.
const MAX_CLIP_SECONDS = 300;
const METADATA_TIMEOUT_MS = 45 * 1000;
const DOWNLOAD_TIMEOUT_MS = 4 * 60 * 1000;
const MAX_YOUTUBE_SECONDS = 5 * 60; // the most footage taken from one YouTube video
const YOUTUBE_DOWNLOAD_TIMEOUT_MS = 12 * 60 * 1000;

// `signal` lets the Stop button kill the running command; `timeout` kills one
// that hangs.
function run(bin, args, { signal, timeout } = {}) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { maxBuffer: 1024 * 1024 * 50, signal, timeout, killSignal: "SIGKILL" }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      if (signal && signal.aborted) return reject(new Error("Stopped."));
      if (err.killed && timeout) return reject(new Error("Timed out — Twitch didn't respond in time."));
      reject(new Error((stderr && stderr.trim()) || err.message));
    });
  });
}

// "60/1" or "30000/1001" -> 60 / 29.97
function parseRate(text) {
  const m = String(text || "").match(/^(\d+)\/(\d+)$/);
  if (m && Number(m[2])) return Number(m[1]) / Number(m[2]);
  return parseFloat(text) || 0;
}

// yt-dlp needs ffmpeg itself (to cut out a stretch of a YouTube video, and to join the video
// and audio streams). It looks for ffmpeg on PATH, but the installer keeps its own copy inside
// the helper's packages, where yt-dlp can't see it. So hand it a small folder holding links to
// the ffmpeg and ffprobe the helper found, and point yt-dlp there with --ffmpeg-location.
function ffmpegLocationArgs(tools) {
  if (!tools.ffmpeg) return [];
  const dir = path.join(os.tmpdir(), "clip-n-shipper-tools");
  try {
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, src] of [["ffmpeg", tools.ffmpeg], ["ffprobe", tools.ffprobe]]) {
      if (!src) continue;
      const dest = path.join(dir, name + (process.platform === "win32" ? ".exe" : ""));
      try {
        if (fs.existsSync(dest) && fs.statSync(dest).size === fs.statSync(src).size) continue; // already there
      } catch (e) {
        // fall through and (re)make it
      }
      fs.rmSync(dest, { force: true });
      try {
        fs.symlinkSync(src, dest); // Windows usually can't make links without special rights...
      } catch (e) {
        fs.copyFileSync(src, dest); // ...so it copies the file instead
        try {
          fs.chmodSync(dest, 0o755);
        } catch (e2) {
          // not needed on Windows
        }
      }
    }
    return ["--ffmpeg-location", dir];
  } catch (e) {
    return [];
  }
}

function sanitize(name) {
  return String(name || "unknown")
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60) || "unknown";
}

// Extracts {streamer, clipSlug} from a twitch.tv/<channel>/clip/<slug> URL, or
// from an x.com / twitter.com/<user>/status/<id> post (the post's video is
// downloaded). clips.twitch.tv/<slug> URLs don't carry the channel name, so
// streamer comes back null and gets filled in from yt-dlp's own metadata.
function parseUrl(url) {
  const yt = url.match(/(?:youtube\.com\/(?:watch\?(?:[^#]*&)?v=|shorts\/|live\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/i);
  if (yt) return { streamer: null, clipSlug: yt[1], isYouTube: true };
  const postMatch = url.match(/(?:x|twitter)\.com\/([^\/?#]+)\/status\/(\d+)/i);
  if (postMatch) {
    return { streamer: postMatch[1], clipSlug: postMatch[2], isXPost: true };
  }
  const channelMatch = url.match(/twitch\.tv\/([^\/]+)\/clip\/([^\/?&#]+)/i);
  if (channelMatch) {
    return { streamer: channelMatch[1], clipSlug: channelMatch[2] };
  }
  const bareMatch = url.match(/clips\.twitch\.tv\/([^\/?&#]+)/i);
  if (bareMatch) {
    return { streamer: null, clipSlug: bareMatch[1] };
  }
  return { streamer: null, clipSlug: null };
}

// Asks Twitch about a clip (about a third of a second). Returns
// { exists, name, duration }, or null if Twitch couldn't be reached.
const TWITCH_GQL = "https://gql.twitch.tv/gql";
const TWITCH_CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko";

async function twitchGql(query) {
  const res = await fetch(TWITCH_GQL, {
    method: "POST",
    headers: { "Client-ID": TWITCH_CLIENT_ID, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) return null;
  return (await res.json()).data || null;
}

async function twitchClipInfo(slug) {
  try {
    const data = await twitchGql(
      `{ clip(slug: ${JSON.stringify(slug)}) { title durationSeconds broadcaster { displayName login } video { title } } }`
    );
    if (!data) return null;
    const clip = data.clip;
    if (!clip) return { exists: false, name: null, duration: 0 };
    const b = clip.broadcaster;
    return {
      exists: true,
      name: (b && (b.displayName || b.login)) || null,
      login: (b && b.login) || null,
      duration: clip.durationSeconds || 0,
      titles: [clip.title, clip.video && clip.video.title].filter(Boolean).join(" "),
    };
  } catch (e) {
    return null;
  }
}

// Other streamers a clip names (an @mention in the clip's or its stream's title,
// the way "BIG WALK w/ @wink_42 @haletales" credits the people playing along).
// Each is checked against Twitch, so only real accounts come back, with their
// properly cased names.
async function collaboratorsFrom(titles, ownLogin) {
  const logins = [];
  for (const m of String(titles || "").matchAll(/@([A-Za-z0-9_]{3,25})/g)) {
    const login = m[1].toLowerCase();
    if (login !== String(ownLogin || "").toLowerCase() && !logins.includes(login)) logins.push(login);
  }
  const wanted = logins.slice(0, 4);
  if (!wanted.length) return [];
  try {
    const query = "{ " + wanted.map((l, i) => `u${i}: user(login: ${JSON.stringify(l)}) { displayName login }`).join(" ") + " }";
    const data = await twitchGql(query);
    if (!data) return [];
    return wanted.map((_, i) => data["u" + i]).filter(Boolean).map((u) => ({ login: u.login, name: u.displayName || u.login }));
  } catch (e) {
    return [];
  }
}

// The streamer's properly cased name for a Twitch clip link, so the panel can
// show the pill before anything is downloaded. null if it can't tell.
async function quickStreamerName(url) {
  const parsed = parseUrl(url);
  if (parsed.isXPost || !parsed.clipSlug) return null;
  const info = await twitchClipInfo(parsed.clipSlug);
  return info && info.exists ? info.name : null;
}

// Streamer name plus any other streamers the clip names, for the panel's preview.
async function quickClipPeople(url) {
  const parsed = parseUrl(url);
  if (parsed.isXPost || !parsed.clipSlug) return { name: null, others: [] };
  const info = await twitchClipInfo(parsed.clipSlug);
  if (!info || !info.exists) return { name: null, others: [] };
  return { name: info.name, others: await collaboratorsFrom(info.titles, info.login) };
}

// Right-after-paste check: is this link a real clip / a post with a video?
// Twitch links are checked against Twitch (fast). X posts need yt-dlp (a few
// seconds), with its own short time limit. Anything we can't confirm either way
// comes back ok, so a flaky check never blocks a good link.
async function checkUrl(tools, url) {
  const parsed = parseUrl(url);
  if (!parsed.clipSlug) return { ok: false, reason: "Not a Twitch clip or Twitter video link" };
  if (parsed.isYouTube) {
    if (!tools.ytDlp) return { ok: true, unchecked: true };
    try {
      const meta = await fetchMetadata(tools.ytDlp, url, undefined, 25 * 1000);
      if (meta.isLive) return { ok: false, reason: "Live stream" };
      return { ok: true, duration: meta.duration || 0 };
    } catch (e) {
      if (/timed out/i.test(String(e.message))) return { ok: true, unchecked: true };
      return { ok: false, reason: "Video unavailable" };
    }
  }
  if (parsed.isXPost) {
    if (!tools.ytDlp) return { ok: true, unchecked: true };
    try {
      const meta = await fetchMetadata(tools.ytDlp, url, undefined, 20 * 1000);
      return meta.duration ? { ok: true } : { ok: false, reason: "No video in this post" };
    } catch (e) {
      const m = String(e.message || e);
      if (/no video/i.test(m)) return { ok: false, reason: "No video in this post" };
      if (/timed out/i.test(m)) return { ok: true, unchecked: true };
      return { ok: false, reason: "Post not found, private, or has no video" };
    }
  }
  const info = await twitchClipInfo(parsed.clipSlug);
  if (!info) return { ok: true, unchecked: true };
  if (!info.exists) return { ok: false, reason: "Clip not found" };
  if (info.duration > MAX_CLIP_SECONDS) return { ok: false, reason: "Too long to be a clip" };
  return { ok: true, name: info.name };
}

async function fetchMetadata(ytDlpPath, url, signal, timeout) {
  const stdout = await run(ytDlpPath, ["-j", "--no-warnings", "--no-playlist", url], {
    signal,
    timeout: timeout || METADATA_TIMEOUT_MS,
  });
  const data = JSON.parse(stdout.trim().split("\n").pop());
  return {
    // For Twitch clips `uploader` is the person who CLIPPED it; the streamer's
    // properly cased name is `channel` (a.k.a. `creator`).
    uploader: data.uploader || null,
    channel: data.channel || data.creator || null,
    title: data.title || null,
    id: data.id || null,
    isLive: !!data.is_live,
    duration: data.duration || 0,
  };
}

function clock(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(sec).padStart(2, "0");
}

// opts (YouTube only): { startSeconds, lengthSeconds } — only that stretch is downloaded.
async function downloadClip(tools, url, destDir, onProgress, signal, opts = {}) {
  const parsed = parseUrl(url);
  if (!parsed.clipSlug) {
    throw new Error("That isn't a Twitch clip, X post or YouTube link (expected twitch.tv/<channel>/clip/<name>, x.com/<user>/status/<id> or a youtube.com/watch?v= link).");
  }
  onProgress(parsed.isYouTube ? "Reading video info…" : "Reading clip info…");
  const meta = await fetchMetadata(tools.ytDlp, url, signal);
  if (meta.isLive) throw new Error("That link is a live stream, not a clip.");
  let section = null;
  if (parsed.isYouTube) {
    // Videos are long, so only the asked-for stretch is downloaded, never the whole video.
    const start = Math.max(0, Number(opts.startSeconds) || 0);
    const length = Number(opts.lengthSeconds) || 0;
    if (!(length > 0)) throw new Error("Enter how many minutes of the video to use.");
    if (length > MAX_YOUTUBE_SECONDS) throw new Error(`That's more than ${MAX_YOUTUBE_SECONDS / 60} minutes of footage — too long.`);
    if (meta.duration && start >= meta.duration) throw new Error(`The start time (${clock(start)}) is past the end of the video (${clock(meta.duration)}).`);
    const end = meta.duration ? Math.min(start + length, meta.duration) : start + length;
    section = { start, end };
  } else if (meta.duration > MAX_CLIP_SECONDS) {
    throw new Error(`That video is ${Math.round(meta.duration / 60)} minutes long — too long to be a clip.`);
  }

  const streamer = parsed.isYouTube ? String(meta.channel || meta.uploader || "YouTube") : parsed.streamer || sanitize(meta.channel || meta.uploader);
  const slug = parsed.clipSlug || sanitize(meta.id) || sanitize(meta.title);
  const filename = `${sanitize(streamer)}__${sanitize(slug)}.mp4`;
  const destPath = path.join(destDir, filename);

  const args = parsed.isYouTube
    ? [
        "-f",
        "bv*[height<=1080]+ba/b[height<=1080]/bv*+ba/b",
        "--merge-output-format",
        "mp4",
        "--download-sections",
        `*${section.start}-${section.end}`,
        "--force-keyframes-at-cuts",
        "--no-warnings",
        "--no-playlist",
        "--socket-timeout",
        "20",
        ...ffmpegLocationArgs(tools),
        "-o",
        destPath,
        url,
      ]
    : ["-f", "best", "--merge-output-format", "mp4", "--no-warnings", "--no-playlist", "--socket-timeout", "20", "--max-filesize", "500M", ...ffmpegLocationArgs(tools), "-o", destPath, url];
  onProgress(parsed.isYouTube ? `Downloading ${clock(section.start)}–${clock(section.end)} of ${streamer}'s video…` : `Downloading ${streamer}'s clip…`);
  // YouTube sometimes answers "403 Forbidden" for a stretch of a video it served a moment ago. A new
  // attempt gets fresh links, so those (and similar passing network errors) are retried.
  const attempts = parsed.isYouTube ? 3 : 1;
  for (let attempt = 1; ; attempt++) {
    try {
      // A retry asks YouTube for ordinary web links (the kind that failed came from its visionOS client).
      const tryArgs = attempt === 1 || !parsed.isYouTube ? args : [...args.slice(0, -1), "--extractor-args", "youtube:player_client=web,mweb", args[args.length - 1]];
      await run(tools.ytDlp, tryArgs, { signal, timeout: parsed.isYouTube ? YOUTUBE_DOWNLOAD_TIMEOUT_MS : DOWNLOAD_TIMEOUT_MS });
      break;
    } catch (e) {
      const passing = /403|forbidden|HTTP error|temporar|connection (reset|refused)|timed out/i.test(String(e.message));
      if (attempt >= attempts || !passing || (signal && signal.aborted)) throw e;
      onProgress(`YouTube refused that attempt (try ${attempt} of ${attempts}). Trying again…`);
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
    }
  }

  if (!fs.existsSync(destPath)) {
    // With a section download yt-dlp can tack the time range onto the file name; pick that file up.
    const base = path.parse(destPath).name;
    const alt = fs.readdirSync(destDir).find((f) => f.startsWith(base) && f.endsWith(".mp4") && !f.endsWith(".part"));
    if (alt) fs.renameSync(path.join(destDir, alt), destPath);
  }
  if (!fs.existsSync(destPath)) {
    throw new Error("yt-dlp reported success but the file is missing: " + destPath);
  }

  onProgress("Reading video dimensions…");
  const probeOut = await run(tools.ffprobe, [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height,duration,avg_frame_rate,r_frame_rate",
    "-of",
    "json",
    destPath,
  ], { signal });
  const probeData = JSON.parse(probeOut);
  const stream = (probeData.streams && probeData.streams[0]) || {};
  let duration = parseFloat(stream.duration);
  if (!duration || isNaN(duration)) {
    // Some clips don't carry duration on the video stream; fall back to format-level duration.
    const fmtOut = await run(tools.ffprobe, [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "json",
      destPath,
    ], { signal });
    duration = parseFloat((JSON.parse(fmtOut).format || {}).duration) || 0;
  }

  return {
    url,
    fps: parseRate(stream.avg_frame_rate) || parseRate(stream.r_frame_rate) || 0,
    streamer,
    // Properly cased Twitch streamer name, for the name pill. Null for X posts,
    // which have no Twitch streamer.
    source: parsed.isYouTube ? "youtube" : parsed.isXPost ? "x" : "twitch",
    channelName: parsed.isXPost || parsed.isYouTube ? null : meta.channel || parsed.streamer || null,
    title: meta.title,
    filePath: destPath,
    srcWidth: parseInt(stream.width, 10) || 0,
    srcHeight: parseInt(stream.height, 10) || 0,
    durationSeconds: duration,
  };
}

module.exports = { downloadClip, parseUrl, sanitize, quickStreamerName, quickClipPeople, checkUrl };
