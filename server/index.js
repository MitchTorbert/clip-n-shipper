// Clip-n-Ship helper server.
//
// Runs locally, does the parts a UXP panel inside Premiere isn't allowed to
// do itself (download clips, extract frames, run the face detector). The
// panel talks to this over plain fetch() to localhost and gets back a
// manifest it uses to actually build the Premiere project.
//
// No third-party npm packages — only Node's built-ins — so there's nothing
// to `npm install` before this will run.

const http = require("http");
const fs = require("fs");
const path = require("path");
const { checkAllTools } = require("./tools");
const { downloadClip, quickClipPeople, checkUrl } = require("./download");
const { findFacecam } = require("./faceDetect");
const { findCaptions } = require("./captionDetect");
const { renderPill, pillFps } = require("./pill");
const { refreshIfStale } = require("./ambassadors");
const { runHealth } = require("./health");

const PORT = Number(process.env.CNS_PORT) || 8934;
const PILL_SERVICE_URL = "https://pill-generator-262830497959.us-central1.run.app";
// Fixed addresses the panel's footer links can open (it never opens anything it supplies itself).
const OPEN_TARGETS = { space150: "https://www.space150.com/", pillgen: PILL_SERVICE_URL + "/" };
// Files every project gets in its SFX folder (kept next to the helper, so they travel with it).
const SHARED_SFX = ["bleep2.mp3", "vine-boom.mp3", "huh.mp3", "anime-wow-sound-effect.mp3"].map((f) => path.join(__dirname, "..", "assets", f));
// The caption look ("Twitch Subtitles"), dropped into each project's GFX folder.
const SHARED_STYLES = ["Twitch Subtitles.prtextstyle", "tiktok_template.png", "instagram_reels_template.png"].map((f) => path.join(__dirname, "..", "assets", f));
// Fraction of the pill generator's full size. 30% is the default the editing workflow uses.
const DEFAULT_PILL_SCALE = 0.3;

const FOLDER_NAMES = {
  sourceFootage: "01 Source Footage",
  pills: "02 Pills",
  sfx: "03 SFX",
  gfx: "04 GFX",
  renders: "05 Renders",
};

// Premiere's standard H.264 preset ("Match Source - High bitrate"), looked up in
// the installed Premiere / Media Encoder (newest first) so it follows updates.
function findH264Preset() {
  let names = [];
  try {
    names = fs.readdirSync("/Applications");
  } catch (e) {
    return null;
  }
  const year = (n) => parseInt((n.match(/(\d{4})$/) || [0, 0])[1], 10);
  const byYearDesc = (a, b) => year(b) - year(a);
  const apps = [
    ...names.filter((n) => /^Adobe Premiere Pro \d{4}$/.test(n)).sort(byYearDesc),
    ...names.filter((n) => /^Adobe Media Encoder \d{4}$/.test(n)).sort(byYearDesc),
  ];
  for (const n of apps) {
    const file = path.join("/Applications", n, `${n}.app`, "Contents", "MediaIO", "systempresets", "4E49434B_48323634", "00 - Match Source - High bitrate.epr");
    if (fs.existsSync(file)) return file;
  }
  return null;
}

// Twitch Ambassador logins (lowercase), from assets/ambassadors.txt, so the panel can tick the Ambassador box.
function readAmbassadors() {
  try {
    return fs
      .readFileSync(path.join(__dirname, "..", "assets", "ambassadors.txt"), "utf8")
      .split(/\r?\n/)
      .map((l) => l.trim().toLowerCase())
      .filter((l) => l && !l.startsWith("#"));
  } catch (e) {
    return [];
  }
}

const jobs = new Map();
const controllers = new Map(); // one AbortController per job, for the Stop button

// Node loads these files once at startup, so edits made afterwards don't take
// effect until the helper is restarted. The panel uses this to warn about it.
const STARTED_AT = Date.now();
function codeIsStale() {
  return fs
    .readdirSync(__dirname)
    .filter((f) => f.endsWith(".js"))
    .some((f) => fs.statSync(path.join(__dirname, f)).mtimeMs > STARTED_AT);
}

function makeJobId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

// "Clear entire project first": empties the downloaded clips and the pills on
// disk. Only those two folders — never the project file, the autosaves, or
// anything in SFX / GFX / Renders — and only when projectDir really is a
// Premiere project folder (it holds a .prproj).
function clearGeneratedFolders(projectDir, dirs, log) {
  const real = path.resolve(projectDir);
  const looksLikeProject = fs.existsSync(real) && fs.readdirSync(real).some((f) => f.toLowerCase().endsWith(".prproj"));
  if (!looksLikeProject || real === path.resolve(require("os").homedir()) || real === path.parse(real).root) {
    log("Not clearing files: " + real + " doesn't look like a Premiere project folder.");
    return;
  }
  let removed = 0;
  for (const dir of [dirs.sourceFootage, dirs.pills]) {
    for (const name of fs.readdirSync(dir)) {
      fs.rmSync(path.join(dir, name), { recursive: true, force: true });
      removed++;
    }
  }
  log(`Cleared ${removed} file(s) from "${FOLDER_NAMES.sourceFootage}" and "${FOLDER_NAMES.pills}".`);
}

// Clips are named "<Streamer> 1", "<Streamer> 2"… in the order they were pasted.
// Numbering carries on from the highest number already used for that streamer,
// whether it's in the folder on disk or (passed in by the panel) in the project.
function safeFileName(name) {
  return String(name).replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").trim() || "clip";
}

function existingClipNumbers(dir) {
  const counts = new Map();
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    return counts;
  }
  for (const file of names) {
    const m = path.parse(file).name.match(/^(.*\S) (\d+)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    counts.set(key, Math.max(counts.get(key) || 0, parseInt(m[2], 10)));
  }
  return counts;
}

function ensureProjectFolders(projectDir) {
  const dirs = {};
  for (const [key, name] of Object.entries(FOLDER_NAMES)) {
    const full = path.join(projectDir, name);
    fs.mkdirSync(full, { recursive: true });
    dirs[key] = full;
  }
  return dirs;
}

// Accepts { clips: [{ url, pill }] } (or the older { urls: [...] }) and returns
// only well-formed entries.
function cleanClipSpecs(body) {
  const raw = Array.isArray(body.clips) ? body.clips : Array.isArray(body.urls) ? body.urls.map((url) => ({ url })) : [];
  return raw
    .filter((c) => c && typeof c.url === "string" && c.url.trim())
    .map((c) => {
      const p = c.pill;
      const pillOk = p && p.enabled === true && typeof p.colorHex === "string" && /^#[0-9a-fA-F]{6}$/.test(p.colorHex);
      const extraPills = (Array.isArray(c.extraPills) ? c.extraPills : [])
        .filter((x) => x && typeof x.name === "string" && x.name.trim() && typeof x.colorHex === "string" && /^#[0-9a-fA-F]{6}$/.test(x.colorHex))
        .slice(0, 6)
        .map((x) => ({
          name: x.name.trim().slice(0, 50),
          colorHex: x.colorHex,
          colorName: typeof x.colorName === "string" && x.colorName ? x.colorName : x.colorHex,
          ambassador: x.ambassador === true,
        }));
      const start = Number(c.start);
      const minutes = Number(c.minutes);
      return {
        url: c.url.trim(),
        // YouTube only: where to start (seconds) and how much to take (minutes).
        startSeconds: Number.isFinite(start) && start >= 0 ? start : 0,
        lengthSeconds: Number.isFinite(minutes) && minutes > 0 ? minutes * 60 : 0,
        pill: pillOk
          ? {
              enabled: true,
              colorHex: p.colorHex,
              colorName: typeof p.colorName === "string" && p.colorName ? p.colorName : p.colorHex,
              ambassador: p.ambassador === true,
              duplicate: p.duplicate === true, // a second pill for a streamer who already has one
              name: typeof p.name === "string" ? p.name.trim().slice(0, 50) : "", // typed by hand for X / YouTube clips
            }
          : null,
        extraPills,
      };
    });
}

// clipSpecs: [{ url, pill: { enabled, colorHex, colorName, ambassador } }].
// options.alreadyPilled: lowercase streamer names that got a pill in an earlier
// sequence of this run, so a streamer who shows up again isn't given a second one.
async function runJob(job, clipSpecs, projectDir, signal, options) {
  const { detectFacecam, detectCaptions, pillScale, alreadyPilled, clearFolders, nameCounts } = options;
  job.log.push("Checking for yt-dlp / ffmpeg…");
  const tools = checkAllTools();
  const missing = [];
  if (!tools.ytDlp) missing.push("yt-dlp");
  if (!tools.ffmpeg) missing.push("ffmpeg");
  if (!tools.ffprobe) missing.push("ffprobe");
  if (missing.length) {
    job.status = "error";
    job.error = `Missing required tool(s): ${missing.join(", ")}. Install with Homebrew (brew install yt-dlp ffmpeg) and try again.`;
    return;
  }

  job.log.push("Creating folders…");
  const dirs = ensureProjectFolders(projectDir);
  if (clearFolders) clearGeneratedFolders(projectDir, dirs, (m) => job.log.push(m));
  const styleFiles = [];
  for (const src of SHARED_STYLES) {
    try {
      const dest = path.join(dirs.gfx, path.basename(src));
      if (!fs.existsSync(dest)) fs.copyFileSync(src, dest);
      styleFiles.push(dest);
    } catch (e) {
      job.log.push("Couldn't copy " + path.basename(src) + " into the GFX folder: " + e.message);
    }
  }
  const sfxFiles = [];
  for (const src of SHARED_SFX) {
    try {
      const dest = path.join(dirs.sfx, path.basename(src));
      if (!fs.existsSync(dest)) fs.copyFileSync(src, dest);
      sfxFiles.push(dest);
    } catch (e) {
      job.log.push("Couldn't copy " + path.basename(src) + " into the SFX folder: " + e.message);
    }
  }

  // Highest clip number used so far per streamer (lowercase name).
  const counts = existingClipNumbers(dirs.sourceFootage);
  for (const [name, n] of Object.entries(nameCounts || {})) {
    const key = String(name).toLowerCase();
    counts.set(key, Math.max(counts.get(key) || 0, Number(n) || 0));
  }

  const pilled = new Set(alreadyPilled);
  const clips = [];
  for (let i = 0; i < clipSpecs.length; i++) {
    if (signal.aborted) break;
    const spec = clipSpecs[i];
    const prefix = `Clip ${i + 1}/${clipSpecs.length}: `;
    let pillKey = null;
    let extraKeys = [];
    try {
      const clip = await downloadClip(tools, spec.url, dirs.sourceFootage, (msg) => {
        job.log.push(prefix + msg);
      }, signal, { startSeconds: spec.startSeconds, lengthSeconds: spec.lengthSeconds });

      // Rename the download to "<Streamer> <number>".
      const display = clip.channelName || clip.streamer;
      const key = display.toLowerCase();
      let number = (counts.get(key) || 0) + 1;
      let target;
      for (;;) {
        target = path.join(dirs.sourceFootage, `${safeFileName(display)} ${number}.mp4`);
        if (!fs.existsSync(target)) break;
        number++;
      }
      fs.renameSync(clip.filePath, target);
      clip.filePath = target;
      clip.displayName = display;
      clip.number = number;
      counts.set(key, number);

      // Start the pill right away so it renders while the facecam search runs.
      let pillPromise = null;
      clip.pill = null;
      if (spec.pill && spec.pill.enabled) {
        const pillName = clip.channelName || spec.pill.name; // X / YouTube: the name typed in by hand
        if (!pillName) {
          job.log.push(prefix + "No pill — this clip has no streamer name and none was typed in.");
        } else if (pilled.has(pillName.toLowerCase()) && !spec.pill.duplicate) {
          job.log.push(prefix + `${pillName} already has a pill, so none for this clip.`);
        } else {
          pillKey = pillName.toLowerCase();
          pilled.add(pillKey);
          job.log.push(prefix + `Making a pill for ${pillName}…`);
          pillPromise = renderPill(
            {
              name: pillName,
              colorHex: spec.pill.colorHex,
              colorName: spec.pill.colorName,
              ambassador: spec.pill.ambassador,
              scale: pillScale,
              fps: clip.fps,
            },
            dirs.pills,
            signal
          ).then(
            (result) => ({ ...result, login: pillKey }),
            (e) => {
              if (signal.aborted) throw e;
              return { failed: true, name: pillName, error: e.message };
            }
          );
          pillPromise.catch(() => {}); // awaited below; this just keeps an early failure from going unhandled
        }
      }

      // Pills for other streamers named in the clip, rendered alongside.
      const extraJobs = [];
      for (const ex of spec.extraPills || []) {
        const key = ex.name.toLowerCase();
        if (pilled.has(key)) {
          job.log.push(prefix + `${ex.name} already has a pill, so none for this clip.`);
          continue;
        }
        pilled.add(key);
        extraKeys.push(key);
        job.log.push(prefix + `Making a pill for ${ex.name}…`);
        const promise = renderPill(
          { name: ex.name, colorHex: ex.colorHex, colorName: ex.colorName, ambassador: ex.ambassador, scale: pillScale, fps: clip.fps },
          dirs.pills,
          signal
        ).then(
          (result) => ({ ...result, login: key }),
          (e) => {
            if (signal.aborted) throw e;
            return { failed: true, name: ex.name, error: e.message };
          }
        );
        promise.catch(() => {});
        extraJobs.push({ key, promise });
      }

      if (detectFacecam) {
        job.log.push(prefix + "Looking for a facecam…");
        const facecam = await findFacecam(
          tools,
          clip.filePath,
          clip.durationSeconds,
          (msg) => job.log.push(prefix + msg),
          signal
        );
        clip.facecam = facecam;
        job.log.push(
          prefix + (facecam.found ? "Found a likely facecam region." : "No facecam found.")
        );
      } else {
        clip.facecam = { found: false, skipped: true };
        job.log.push(prefix + "Downloaded (stringout only, so no facecam search).");
      }

      // Twitch's own burned-in captions (often wrong): find where they start so the panel can crop them off.
      clip.captions = { found: false };
      if (detectCaptions && clip.source === "twitch") {
        try {
          job.log.push(prefix + "Checking for Twitch captions…");
          clip.captions = await findCaptions(tools, clip.filePath, clip.durationSeconds, clip.srcWidth, clip.srcHeight, signal);
          if (clip.captions.found) job.log.push(prefix + "Found Twitch captions — they'll be cropped out.");
        } catch (e) {
          if (signal.aborted) throw e;
          clip.captions = { found: false };
        }
      }

      if (pillPromise) {
        clip.pill = await pillPromise;
        if (clip.pill.failed) {
          pilled.delete(pillKey); // a later clip from this streamer can try again
          job.log.push(prefix + `The pill for ${clip.pill.name} didn't work (${clip.pill.error}) — continuing without it.`);
        } else {
          job.log.push(prefix + `Pill for ${clip.pill.name} ready${clip.pill.cached ? " (reused)" : ""}.`);
        }
      }
      clip.extraPills = [];
      for (const { key, promise } of extraJobs) {
        const result = await promise;
        if (result.failed) {
          pilled.delete(key);
          job.log.push(prefix + `The pill for ${result.name} didn't work (${result.error}) — continuing without it.`);
        } else {
          clip.extraPills.push(result);
          job.log.push(prefix + `Pill for ${result.name} ready${result.cached ? " (reused)" : ""}.`);
        }
      }
      clips.push(clip);
    } catch (e) {
      if (signal.aborted) break;
      if (pillKey) pilled.delete(pillKey);
      for (const key of extraKeys) pilled.delete(key);
      job.log.push(prefix + "FAILED: " + e.message);
      clips.push({ url: spec.url, failed: true, error: e.message });
    }
  }

  if (signal.aborted) {
    job.status = "cancelled";
    job.log.push("Stopped.");
    return;
  }

  job.manifest = {
    projectDir,
    folders: FOLDER_NAMES,
    sfxFiles,
    styleFiles,
    nameCounts: Object.fromEntries(counts),
    clips,
  };
  job.status = "done";
  job.log.push("Done.");
}

// Pills made on their own (the panel's Pill Generator view): rendered one after
// another into the project's "02 Pills" folder.
async function runPillJob(job, pills, projectDir, signal, options) {
  const dirs = ensureProjectFolders(projectDir);
  const results = [];
  for (let i = 0; i < pills.length; i++) {
    if (signal.aborted) break;
    const pill = pills[i];
    job.log.push(`Pill ${i + 1}/${pills.length}: making /${pill.name}…`);
    try {
      const result = await renderPill({ ...pill, scale: options.scale, fps: options.fps, fileType: options.fileType }, dirs.pills, signal);
      results.push(result);
      job.log.push(`Pill for ${pill.name} ready${result.cached ? " (reused)" : ""}.`);
    } catch (e) {
      if (signal.aborted) break;
      results.push({ failed: true, name: pill.name, error: e.message });
      job.log.push(`The pill for ${pill.name} didn't work: ${e.message}`);
    }
  }
  if (signal.aborted) {
    job.status = "cancelled";
    return;
  }
  job.manifest = { folders: FOLDER_NAMES, pills: results };
  job.status = "done";
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    sendJson(res, 200, {});
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === "GET" && url.pathname === "/ping") {
    sendJson(res, 200, { ok: true, stale: codeIsStale() });
    return;
  }

  if (req.method === "POST" && url.pathname === "/open") {
    const target = OPEN_TARGETS[url.searchParams.get("target")];
    if (!target) {
      sendJson(res, 400, { error: "Unknown link." });
      return;
    }
    require("child_process").execFile("open", [target], () => {});
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && url.pathname === "/health") {
    const assetsDir = path.join(__dirname, "..", "assets");
    const rows = await runHealth(checkAllTools(), {
      pillService: PILL_SERVICE_URL,
      ambassadorCount: () => readAmbassadors().length,
      h264Preset: findH264Preset,
      assets: [...SHARED_SFX, ...SHARED_STYLES],
    });
    sendJson(res, 200, { rows });
    return;
  }

  // "Report an Issue": handed to the Pill Generator's hosted service, which files it as a GitHub
  // issue with a token kept on the server (nothing secret lives on anyone's computer).
  if (req.method === "POST" && url.pathname === "/send-report") {
    try {
      const body = await readJsonBody(req);
      const diagnostics = {};
      for (const [k, v] of Object.entries(body.diagnostics && typeof body.diagnostics === "object" ? body.diagnostics : {}).slice(0, 12)) {
        diagnostics[String(k).slice(0, 40)] = String(v).slice(0, 300);
      }
      const svcRes = await fetch(PILL_SERVICE_URL + "/api/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: ["bug", "idea", "question"].includes(body.type) ? body.type : "bug",
          title: "[Clip-n-Shipper] " + String(body.title || "").trim().slice(0, 100),
          description: String(body.description || "").slice(0, 4900),
          name: String(body.name || ""),
          email: String(body.email || ""),
          browser: diagnostics,
          website: body.dryRun === true ? "dry-run" : "", // the service's spam trap: a filled field is accepted but filed nowhere
        }),
        signal: AbortSignal.timeout(15000),
      });
      let data = {};
      try {
        data = await svcRes.json();
      } catch (e) {
        // not JSON
      }
      sendJson(res, svcRes.ok ? 200 : svcRes.status, svcRes.ok ? { ok: true } : { error: data.error || "The report service said no." });
    } catch (e) {
      sendJson(res, 502, { error: "Couldn't reach the report service. Check your internet connection." });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/open-pill-generator") {
    // Fixed address only: this never opens anything the panel sends.
    require("child_process").execFile("open", ["https://pill-generator-262830497959.us-central1.run.app/"], () => {});
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && url.pathname === "/render-info") {
    const projectDir = url.searchParams.get("projectDir") || "";
    if (!projectDir) {
      sendJson(res, 400, { error: "No projectDir provided." });
      return;
    }
    const rendersDir = path.join(projectDir, FOLDER_NAMES.renders);
    fs.mkdirSync(rendersDir, { recursive: true });
    sendJson(res, 200, { preset: findH264Preset(), rendersDir });
    return;
  }

  if (req.method === "GET" && url.pathname === "/ambassadors") {
    sendJson(res, 200, { logins: readAmbassadors() });
    return;
  }

  if (req.method === "GET" && url.pathname === "/check-url") {
    sendJson(res, 200, await checkUrl(checkAllTools(), url.searchParams.get("url") || ""));
    return;
  }

  if (req.method === "GET" && url.pathname === "/streamer") {
    sendJson(res, 200, await quickClipPeople(url.searchParams.get("url") || ""));
    return;
  }

  if (req.method === "GET" && url.pathname === "/check-tools") {
    sendJson(res, 200, checkAllTools());
    return;
  }

  if (req.method === "POST" && url.pathname === "/process") {
    try {
      const body = await readJsonBody(req);
      const clipSpecs = cleanClipSpecs(body);
      const projectDir = body.projectDir;
      if (!clipSpecs.length) {
        sendJson(res, 400, { error: "No clip URLs provided." });
        return;
      }
      if (!projectDir || typeof projectDir !== "string") {
        sendJson(res, 400, { error: "No projectDir provided." });
        return;
      }
      const jobId = makeJobId();
      const job = { status: "running", log: [], error: null, manifest: null };
      jobs.set(jobId, job);
      const controller = new AbortController();
      controllers.set(jobId, controller);
      runJob(job, clipSpecs, projectDir, controller.signal, {
        detectFacecam: body.detectFacecam !== false,
        pillScale: typeof body.pillScale === "number" && body.pillScale > 0 && body.pillScale <= 1 ? body.pillScale : DEFAULT_PILL_SCALE,
        alreadyPilled: Array.isArray(body.alreadyPilled) ? body.alreadyPilled.map((n) => String(n).toLowerCase()) : [],
        clearFolders: body.clearFolders === true,
        detectCaptions: body.detectCaptions === true,
        nameCounts: body.nameCounts && typeof body.nameCounts === "object" ? body.nameCounts : {},
      })
        .catch((e) => {
          job.status = "error";
          job.error = e.message;
        })
        .finally(() => controllers.delete(jobId));
      sendJson(res, 200, { jobId });
    } catch (e) {
      sendJson(res, 400, { error: e.message });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/make-pills") {
    try {
      const body = await readJsonBody(req);
      const pills = (Array.isArray(body.pills) ? body.pills : [])
        .filter((p) => p && typeof p.name === "string" && p.name.trim() && typeof p.colorHex === "string" && /^#[0-9a-fA-F]{6}$/.test(p.colorHex))
        .slice(0, 20)
        .map((p) => ({
          name: p.name.trim().slice(0, 50),
          colorHex: p.colorHex,
          colorName: typeof p.colorName === "string" && p.colorName ? p.colorName : p.colorHex,
          ambassador: p.ambassador === true,
        }));
      if (!pills.length) {
        sendJson(res, 400, { error: "No pills to make." });
        return;
      }
      if (!body.projectDir || typeof body.projectDir !== "string") {
        sendJson(res, 400, { error: "No projectDir provided." });
        return;
      }
      const options = {
        scale: [0.3, 0.35, 0.5, 1].includes(body.scale) ? body.scale : DEFAULT_PILL_SCALE,
        fps: pillFps(Number(body.fps)),
        fileType: body.fileType === "gif" ? "gif" : "mov",
      };
      const jobId = makeJobId();
      const job = { status: "running", log: [], error: null, manifest: null };
      jobs.set(jobId, job);
      const controller = new AbortController();
      controllers.set(jobId, controller);
      runPillJob(job, pills, body.projectDir, controller.signal, options)
        .catch((e) => {
          job.status = "error";
          job.error = e.message;
        })
        .finally(() => controllers.delete(jobId));
      sendJson(res, 200, { jobId });
    } catch (e) {
      sendJson(res, 400, { error: e.message });
    }
    return;
  }

  if (req.method === "POST" && url.pathname.startsWith("/cancel/")) {
    const jobId = url.pathname.slice("/cancel/".length);
    const controller = controllers.get(jobId);
    if (!controller) {
      sendJson(res, 404, { error: "That job isn't running." });
      return;
    }
    jobs.get(jobId).log.push("Stopping…");
    controller.abort();
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && url.pathname.startsWith("/status/")) {
    const jobId = url.pathname.slice("/status/".length);
    const job = jobs.get(jobId);
    if (!job) {
      sendJson(res, 404, { error: "Unknown jobId" });
      return;
    }
    sendJson(res, 200, job);
    return;
  }

  sendJson(res, 404, { error: "Not found" });
});

// When another copy is already answering on this port (say the helper was also
// started by hand), say so and step aside instead of crashing noisily.
server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.log(`Clip-n-Ship helper is already running on port ${PORT} — nothing more to do here.`);
    process.exit(0);
  }
  throw e;
});

// Running as the optional background login service: restart on our own after
// the code changes (the service manager starts a fresh copy), but never mid-job.
if (process.env.CLIPNSHIP_AUTORESTART === "1") {
  setInterval(() => {
    if (codeIsStale() && controllers.size === 0) {
      console.log("Helper code changed — restarting.");
      process.exit(0);
    }
  }, 2000);
}

// Keep the Ambassador list current (it refreshes at most every few days).
refreshIfStale((m) => console.log(m));
setInterval(() => refreshIfStale((m) => console.log(m)), 6 * 60 * 60 * 1000);

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Clip-n-Ship helper listening on http://127.0.0.1:${PORT}`);
  console.log("Leave this window open while using the panel in Premiere.");
});
