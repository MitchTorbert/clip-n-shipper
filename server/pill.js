// Renders a name pill through the hosted Pill Generator and saves it into the
// project's "02 Pills" folder as a .mov (ProRes 4444 with transparency).
//
// The service renders one pill at a time for everyone, so a request can wait in
// its queue. Nothing here is allowed to hang the build: each attempt has a
// timeout, one retry covers a cold start or a hiccup, and the caller treats a
// failure as "no pill for this streamer", never as a failed clip.

const fs = require("fs");
const path = require("path");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");

const PILL_SERVICE = "https://pill-generator-262830497959.us-central1.run.app";
const ATTEMPT_TIMEOUT_MS = 4 * 60 * 1000;
const RETRY_DELAY_MS = 3000;

function fileSafe(name) {
  return String(name).replace(/[/\\?%*:|"<>]/g, "-").trim() || "streamer";
}

// e.g. "ohnePixel Pill Dragon Ambassador.mov". The settings are in the name so
// a repeat run with the same settings reuses the file instead of re-rendering.
function pillFileName({ name, colorName, ambassador, fps, fileType }) {
  const rate = pillFps(fps);
  const rateTag = rate === 30 ? "" : rate === 60 ? " 60fps" : " 24fps";
  return `${fileSafe(name)} Pill ${fileSafe(colorName)}${ambassador ? " Ambassador" : ""}${rateTag}.${fileType === "gif" ? "gif" : "mov"}`;
}

// The pill service offers 23.976, 30 and 60 fps; use the one closest to the footage's.
const PILL_FPS = [23.976, 30, 60];
function pillFps(footageFps) {
  if (!footageFps || !Number.isFinite(footageFps)) return 30;
  return PILL_FPS.reduce((best, f) => (Math.abs(f - footageFps) < Math.abs(best - footageFps) ? f : best), 30);
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("Stopped."));
      },
      { once: true }
    );
  });
}

async function attempt({ name, colorHex, ambassador, scale, fps, fileType }, destPath, signal) {
  const res = await fetch(PILL_SERVICE + "/api/render", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      // The service draws the text exactly as sent, and its own page starts the box with a "/".
      pills: [{ username: "/" + name, colorHex, ambassador: !!ambassador }],
      scale,
      fileType: fileType === "gif" ? "gif" : "mov",
      fps: pillFps(fps),
    }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(ATTEMPT_TIMEOUT_MS)]),
  });
  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.json()).error || "";
    } catch (e) {
      // not JSON
    }
    const err = new Error(`The pill service said ${res.status}${detail ? ": " + detail : ""}`);
    err.retryable = res.status >= 500;
    throw err;
  }
  const partPath = destPath + ".part";
  try {
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(partPath));
    fs.renameSync(partPath, destPath);
  } catch (e) {
    fs.rmSync(partPath, { force: true });
    throw e;
  }
}

// Returns { name, path, cached }, or throws.
async function renderPill(spec, destDir, signal) {
  fs.mkdirSync(destDir, { recursive: true });
  const destPath = path.join(destDir, pillFileName(spec));
  if (fs.existsSync(destPath) && fs.statSync(destPath).size > 0) {
    return { name: spec.name, path: destPath, cached: true };
  }
  let lastError;
  for (let tryNumber = 1; tryNumber <= 2; tryNumber++) {
    try {
      await attempt(spec, destPath, signal);
      return { name: spec.name, path: destPath, cached: false };
    } catch (e) {
      if (signal.aborted) throw new Error("Stopped.");
      lastError = e;
      const timedOut = e.name === "TimeoutError";
      const retryable = timedOut || e.retryable !== false; // network errors and 5xx are worth one more try
      if (tryNumber === 2 || !retryable) break;
      await sleep(RETRY_DELAY_MS, signal);
    }
  }
  throw new Error(lastError && lastError.name === "TimeoutError" ? "The pill service took too long." : lastError.message);
}

module.exports = { renderPill, pillFileName, pillFps };
