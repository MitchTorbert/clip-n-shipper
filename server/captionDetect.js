// Finds Twitch's burned-in auto-captions in a downloaded clip.
//
// Twitch draws them as white text near the bottom center of the frame, with a
// bright Twitch-purple highlight on the word being spoken. That purple is the
// giveaway: it sits in the same horizontal band in every clip we've looked at
// (about 90%-96% of the frame height), at any resolution.
//
// 1. Pull ~20 small frames spread across the clip, as raw pixels.
// 2. In the bottom of each frame, find Twitch-purple pixels. Purple that is
//    there in many frames is part of the stream's own overlay, not a caption,
//    so it's ignored.
// 3. A frame "has a caption" when what's left is one compact blob, centered,
//    in the caption band. Two or more such frames that agree on where the band
//    starts count as captions; the top of the band is where to crop.
//
// Captions only show while someone is talking, so a clip with a long silence
// can slip through; the panel's crop is always editable by hand.

const { execFile } = require("child_process");

const SAMPLES = 20;
const FRAME_WIDTH = 640;
const SEARCH_FROM = 0.75; // only look in the bottom quarter
const SIDE_MARGIN = 0.05; // ignore the far left/right edges (stream UI)
const STATIC_SHARE = 0.4; // purple present in this share of frames = overlay, not captions
const MIN_PIXELS_SHARE = 0.0001; // purple pixels needed, as a share of the frame
const BAND_MIN = 0.82; // the caption band must start between these heights...
const BAND_MAX = 0.95; // ...of the frame
const MIN_BAND_HEIGHT = 0.03;
const MAX_BAND_HEIGHT = 0.1;
const MAX_BAND_WIDTH = 0.45;
const MIN_FRAMES = 2;
const AGREE = 0.012; // frames must agree on where the band starts, within this fraction of the height
const CROP_MARGIN = 0.006; // a little extra above the first purple pixel

function isTwitchPurple(r, g, b) {
  return Math.abs(r - 145) < 28 && Math.abs(g - 70) < 30 && b > 215;
}

function readFrames(ffmpegPath, videoPath, durationSeconds, width, height, signal) {
  return new Promise((resolve, reject) => {
    execFile(
      ffmpegPath,
      [
        "-v", "error",
        "-i", videoPath,
        "-vf", `fps=${SAMPLES}/${Math.max(durationSeconds, 1)},scale=${width}:${height}`,
        "-an",
        "-f", "rawvideo",
        "-pix_fmt", "rgb24",
        "-",
      ],
      { encoding: "buffer", maxBuffer: width * height * 3 * (SAMPLES + 6), signal, timeout: 60000 },
      (err, stdout) => (err ? reject(err) : resolve(stdout))
    );
  });
}

// Returns { found: true, topY } (topY = where the captions begin, 0-1 from the
// top, already including a small margin) or { found: false }.
async function findCaptions(tools, videoPath, durationSeconds, srcWidth, srcHeight, signal) {
  if (!durationSeconds || !srcWidth || !srcHeight) return { found: false };
  const W = FRAME_WIDTH;
  const H = Math.max(2, Math.round((W * srcHeight) / srcWidth));
  const raw = await readFrames(tools.ffmpeg, videoPath, durationSeconds, W, H, signal);
  const frameBytes = W * H * 3;
  const count = Math.floor(raw.length / frameBytes);
  if (count < 4) return { found: false };

  const y0 = Math.floor(H * SEARCH_FROM);
  const x0 = Math.floor(W * SIDE_MARGIN);
  const x1 = Math.ceil(W * (1 - SIDE_MARGIN));
  const masks = [];
  const hits = new Uint16Array(W * H);
  for (let f = 0; f < count; f++) {
    const base = f * frameBytes;
    const mask = new Uint8Array(W * H);
    for (let y = y0; y < H; y++) {
      for (let x = x0; x < x1; x++) {
        const i = base + (y * W + x) * 3;
        if (isTwitchPurple(raw[i], raw[i + 1], raw[i + 2])) {
          mask[y * W + x] = 1;
          hits[y * W + x]++;
        }
      }
    }
    masks.push(mask);
  }

  const tops = [];
  const minPixels = Math.max(8, Math.round(W * H * MIN_PIXELS_SHARE));
  for (const mask of masks) {
    let n = 0;
    let minY = H;
    let maxY = -1;
    let minX = W;
    let maxX = -1;
    for (let y = y0; y < H; y++) {
      for (let x = x0; x < x1; x++) {
        const k = y * W + x;
        if (!mask[k] || hits[k] / count > STATIC_SHARE) continue;
        n++;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
      }
    }
    if (n < minPixels) continue;
    const top = minY / H;
    const height = (maxY - minY + 1) / H;
    const width = (maxX - minX + 1) / W;
    if (top < BAND_MIN || top > BAND_MAX) continue;
    if (height < MIN_BAND_HEIGHT || height > MAX_BAND_HEIGHT || width > MAX_BAND_WIDTH) continue;
    tops.push(top);
  }
  if (tops.length < MIN_FRAMES) return { found: false };
  tops.sort((a, b) => a - b);
  const median = tops[Math.floor(tops.length / 2)];
  const agreeing = tops.filter((t) => Math.abs(t - median) <= AGREE);
  if (agreeing.length < MIN_FRAMES) return { found: false };
  return { found: true, topY: Math.max(0.5, agreeing[0] - CROP_MARGIN), frames: agreeing.length };
}

module.exports = { findCaptions };
