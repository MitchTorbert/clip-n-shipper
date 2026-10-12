// Finds the facecam in a downloaded clip.
//
// 1. Pull a handful of frames spread across the clip.
// 2. Find faces by scanning overlapping tiles of each frame (BlazeFace only
//    sees 128px, so a webcam in a corner is too small on a full 1080p frame).
// 3. Vote: the facecam face shows up in the same screen cell in most frames;
//    stray "faces" in game footage don't repeat in the same place.
// 4. Snap to the webcam's rectangle by scanning outward from the face for
//    straight edges that show up in every sampled frame (an overlay border is
//    static; game footage behind it isn't). Where no clear edge exists, fall
//    back to the frame boundary (webcams usually sit in a corner) or a padded
//    guess around the face.
// 5. Green-screen ("keyed") webcams have no border to find, so edge snapping
//    ends up guessing. When it has to guess two or more sides, those sides come
//    from the outline of the person instead (a person-segmentation model),
//    which lands on the camera's own cut edges when the person touches them.
//
// Pure JavaScript (tfjs CPU + jpeg-js) — no native toolchain needed.

const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const tf = require("@tensorflow/tfjs");
const blazeface = require("@tensorflow-models/blazeface");
const jpeg = require("jpeg-js");
const bodySegmentation = require("@tensorflow-models/body-segmentation");

const SAMPLE_COUNT = 8;
const GRID_COLS = 6;
const GRID_ROWS = 4;
const MIN_FRAME_FRACTION = 0.5; // face must show up in at least half the sampled frames
const MIN_CONFIDENCE = 0.85;
const FULLSCREEN_FACE_HEIGHT = 0.14; // a centered face at least this tall (share of frame height) = full-screen camera

const EDGE_DELTA = 28; // gray-level jump (0-255) that counts as an edge pixel
// Fraction of the band that must show the edge, in every frame (median), to
// call it a webcam border. Edges inside the webcam (chairs, shelves) are partial.
const EDGE_MIN_SIDES = 0.7;
const EDGE_MIN_TOP_BOTTOM = 0.65;

// Full-screen camera: a big face (anywhere in the frame) in at least this many sampled frames.
// Then the clip gets the blurred background, whatever else looks like a face (plushies, posters).
// Webcam overlay faces are ~5-11% of the frame height.
const FULLCAM_FACE_HEIGHT = 0.12;
const FULLCAM_MIN_FRAMES = 2;

// A side with no clear border can still take a weaker edge when it's a thin, sharp line (a webcam
// overlay's border) rather than broad room texture. Used only for where the crop goes, never as
// evidence that a webcam exists, so it can't turn IRL footage into a "facecam".
// The faces in the chosen spot must look like one person: sizes within this ratio of each other,
// and centers within this many face-widths. Otherwise different people walked through that spot.
const SAME_FACE_MAX_SIZE_RATIO = 1.7;
const SAME_FACE_MAX_DRIFT = 1.0;

const WEAK_EDGE_MIN = 0.45;
const WEAK_EDGE_ISOLATION = 0.5; // nearby columns/rows must average at most this share of the peak (a border can be a double line)

// Person outline for keyed webcams.
const PERSON_THRESHOLD = 0.85; // stricter than 0.5, which grabs dark background above hair
const PERSON_MARGIN = 0.01; // breathing room around the outline, as a fraction of its size
const MIN_GUESSED_SIDES_FOR_KEYED = 2;

// Fallback padding (multiples of the detected face box) when edges aren't found.
const PAD_SIDE = 0.9;
const PAD_ABOVE = 0.65; // hair/hats rise ~0.5x the face box above it; real headroom varies 0.3-1.6x
const PAD_BELOW = 1.6;

let modelPromise = null;
function getModel() {
  if (!modelPromise) modelPromise = blazeface.load();
  return modelPromise;
}

let segmenterPromise = null;
function getSegmenter() {
  if (!segmenterPromise) {
    segmenterPromise = bodySegmentation.createSegmenter(bodySegmentation.SupportedModels.MediaPipeSelfieSegmentation, {
      runtime: "tfjs",
      modelType: "general",
    });
  }
  return segmenterPromise;
}

function run(bin, args, signal) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { maxBuffer: 1024 * 1024 * 20, signal, killSignal: "SIGKILL" }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      if (signal && signal.aborted) return reject(new Error("Stopped."));
      reject(new Error((stderr && stderr.trim()) || err.message));
    });
  });
}

// Windows: the face models run in plain JavaScript and can keep the helper busy long enough
// that the panel's "how's it going?" checks go unanswered. Pausing for a moment between
// pieces of work lets those checks through. The Mac doesn't need it and skips it.
function letOthersIn() {
  return process.platform === "win32" ? new Promise((resolve) => setImmediate(resolve)) : Promise.resolve();
}

function throwIfStopped(signal) {
  if (signal && signal.aborted) throw new Error("Stopped.");
}

async function extractSampleFrames(tools, videoPath, durationSeconds, signal) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clip-n-ship-frames-"));
  const framePaths = [];
  for (let i = 0; i < SAMPLE_COUNT; i++) {
    // Skip the very first/last instants; clips often fade in/out there.
    const t = (durationSeconds * (i + 1)) / (SAMPLE_COUNT + 1);
    const outPath = path.join(tmpDir, `frame_${i}.jpg`);
    await run(tools.ffmpeg, ["-y", "-ss", String(t), "-i", videoPath, "-frames:v", "1", "-q:v", "3", outPath], signal);
    if (fs.existsSync(outPath)) framePaths.push(outPath);
  }
  return { tmpDir, framePaths };
}

function decodeFrame(framePath) {
  const d = jpeg.decode(fs.readFileSync(framePath), { useTArray: true });
  const rgb = new Uint8Array(d.width * d.height * 3);
  const gray = new Uint8Array(d.width * d.height);
  for (let i = 0, j = 0, g = 0; i < d.data.length; i += 4, j += 3, g++) {
    rgb[j] = d.data[i];
    rgb[j + 1] = d.data[i + 1];
    rgb[j + 2] = d.data[i + 2];
    gray[g] = (d.data[i] * 77 + d.data[i + 1] * 150 + d.data[i + 2] * 29) >> 8;
  }
  return { w: d.width, h: d.height, rgb, gray };
}

// Faces in frame pixels: {x, y, w, h}, origin top-left. Scans a 3x3 grid of
// overlapping half-frame tiles.
// `frac` is each tile's size as a share of the frame, and `cols`/`rows` how many
// tiles span it. The default is the quick pass (3x3 half-frame tiles); a finer
// pass (smaller tiles) finds small webcams whose face is only a few % of the frame.
async function detectFaces(model, img, frac = 0.5, cols = 3, rows = 3, edgesOnly = false) {
  const tileW = Math.round(img.w * frac);
  const tileH = Math.round(img.h * frac);
  const spread = (total, size, n) => Array.from({ length: n }, (_, i) => (n === 1 ? 0 : Math.round(((total - size) * i) / (n - 1))));
  const xs = spread(img.w, tileW, cols);
  const ys = spread(img.h, tileH, rows);
  const faces = [];
  for (let yi = 0; yi < ys.length; yi++) {
    for (let xi = 0; xi < xs.length; xi++) {
      // Webcams sit along the frame's edges (corners, mid-left, mid-right, top/bottom middle), so the finer pass skips the interior.
      if (edgesOnly && xi > 0 && xi < xs.length - 1 && yi > 0 && yi < ys.length - 1) continue;
      const ty = ys[yi];
      const tx = xs[xi];
      const buf = new Uint8Array(tileW * tileH * 3);
      for (let y = 0; y < tileH; y++) {
        const src = ((ty + y) * img.w + tx) * 3;
        buf.set(img.rgb.subarray(src, src + tileW * 3), y * tileW * 3);
      }
      await letOthersIn();
      const tensor = tf.tensor3d(buf, [tileH, tileW, 3]);
      let preds;
      try {
        preds = await model.estimateFaces(tensor, false);
      } finally {
        tensor.dispose();
      }
      for (const p of preds) {
        const prob = p.probability ? p.probability[0] : 1;
        if (prob < MIN_CONFIDENCE) continue;
        faces.push({
          x: p.topLeft[0] + tx,
          y: p.topLeft[1] + ty,
          w: p.bottomRight[0] - p.topLeft[0],
          h: p.bottomRight[1] - p.topLeft[1],
        });
      }
    }
  }
  return faces;
}

function clusterFace(perFrameFaces, W, H) {
  const cells = new Map();
  for (const faces of perFrameFaces) {
    const seen = new Set(); // count a cell once per frame (overlapping tiles repeat detections)
    for (const f of faces) {
      const col = Math.min(GRID_COLS - 1, Math.floor(((f.x + f.w / 2) / W) * GRID_COLS));
      const row = Math.min(GRID_ROWS - 1, Math.floor(((f.y + f.h / 2) / H) * GRID_ROWS));
      const key = row * GRID_COLS + col;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!cells.has(key)) cells.set(key, []);
      cells.get(key).push(f);
    }
  }
  let best = null;
  for (const list of cells.values()) {
    if (!best || list.length > best.length) best = list;
  }
  if (!best || perFrameFaces.length === 0 || best.length / perFrameFaces.length < MIN_FRAME_FRACTION) return null;
  const avg = (k) => best.reduce((s, f) => s + f[k], 0) / best.length;
  const heights = best.map((f) => f.h);
  const cxs = best.map((f) => f.x + f.w / 2);
  const cys = best.map((f) => f.y + f.h / 2);
  return {
    x: avg("x"),
    y: avg("y"),
    w: avg("w"),
    h: avg("h"),
    hits: best.length,
    // how much the faces in this spot differ: one streamer on a webcam barely changes,
    // different people walking through the same spot (IRL footage) do
    sizeRatio: Math.max(...heights) / Math.max(1, Math.min(...heights)),
    drift: Math.hypot(Math.max(...cxs) - Math.min(...cxs), Math.max(...cys) - Math.min(...cys)) / Math.max(1, avg("w")),
  };
}

// True when a big face sits in the middle of the frame in enough sampled frames: the
// footage is the camera itself (IRL / just chatting), not gameplay with a webcam overlay.
function looksLikeFullCamera(perFrameFaces, W, H) {
  let frames = 0;
  for (const faces of perFrameFaces) {
    // Big faces mean the footage is the camera itself, wherever they are: a handheld IRL camera
    // catches faces near the edges too. Webcam overlay faces are ~5-11% of the frame height.
    const big = faces.some((f) => f.h / H >= FULLCAM_FACE_HEIGHT);
    if (big) frames++;
  }
  return frames >= FULLCAM_MIN_FRAMES;
}

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

// Fraction of rows in [y0,y1) showing a vertical edge at column x (median over frames).
function verticalEdgeScore(frames, x, y0, y1) {
  return median(
    frames.map((f) => {
      if (x < 2 || x >= f.w - 2) return 0;
      let hits = 0;
      let total = 0;
      for (let y = Math.max(0, y0); y < Math.min(f.h, y1); y += 2) {
        total++;
        if (Math.abs(f.gray[y * f.w + x + 2] - f.gray[y * f.w + x - 2]) > EDGE_DELTA) hits++;
      }
      return total ? hits / total : 0;
    })
  );
}

// Fraction of columns in [x0,x1) showing a horizontal edge at row y (median over frames).
function horizontalEdgeScore(frames, y, x0, x1) {
  return median(
    frames.map((f) => {
      if (y < 2 || y >= f.h - 2) return 0;
      let hits = 0;
      let total = 0;
      for (let x = Math.max(0, x0); x < Math.min(f.w, x1); x += 2) {
        total++;
        if (Math.abs(f.gray[(y + 2) * f.w + x] - f.gray[(y - 2) * f.w + x]) > EDGE_DELTA) hits++;
      }
      return total ? hits / total : 0;
    })
  );
}

// Walk outward from `start` (step +1/-1) for up to maxDist px and take the
// strongest edge scoring >= minScore. No edge: use the frame boundary if it's
// within reach. Otherwise null (caller falls back to padding).
function findEdge(scoreAt, start, step, maxDist, limit, minScore) {
  let best = null;
  for (let d = 0; d <= maxDist; d++) {
    const p = start + step * d;
    if (p < 0 || p > limit) break;
    const s = scoreAt(p);
    if (s >= minScore && (!best || s > best.s + 0.05)) best = { p, s };
  }
  if (best) return { pos: best.p, how: "edge" };
  const boundary = step > 0 ? limit : 0;
  if (Math.abs(boundary - start) <= maxDist) return { pos: boundary, how: "boundary" };
  const weak = findSharpEdge(scoreAt, start, step, maxDist, limit);
  if (weak) return weak;
  return null;
}

// The strongest thin, sharp line within reach scoring >= WEAK_EDGE_MIN, or null.
function findSharpEdge(scoreAt, start, step, maxDist, limit) {
  const near = Math.max(3, Math.round(limit * 0.0025)); // ~5 px on a 1080p frame
  const far = Math.max(near + 4, Math.round(limit * 0.01)); // ~19 px
  const cache = new Map();
  const score = (p) => {
    if (p < 0 || p > limit) return 0;
    if (!cache.has(p)) cache.set(p, scoreAt(p));
    return cache.get(p);
  };
  let best = null;
  for (let d = 0; d <= maxDist; d++) {
    const p = start + step * d;
    if (p < 0 || p > limit) break;
    const s = score(p);
    if (s < WEAK_EDGE_MIN || (best && s <= best.s)) continue;
    let sum = 0;
    let n = 0;
    for (let k = near; k <= far; k++) {
      sum += score(p - k) + score(p + k);
      n += 2;
    }
    if (sum / n <= s * WEAK_EDGE_ISOLATION) best = { p, s };
  }
  return best ? { pos: best.p, how: "weak" } : null;
}

function snapToWebcam(frames, face) {
  const W = frames[0].w;
  const H = frames[0].h;
  const faceL = Math.round(face.x);
  const faceR = Math.round(face.x + face.w);
  const faceT = Math.round(face.y);
  const faceB = Math.round(face.y + face.h);
  const reachX = Math.round(2.2 * face.w);
  const reachY = Math.round(3.5 * face.h);

  const sideScore = (x) => verticalEdgeScore(frames, x, faceT, faceB);
  const right = findEdge(sideScore, faceR, 1, reachX, W, EDGE_MIN_SIDES);
  const left = findEdge(sideScore, faceL, -1, reachX, W, EDGE_MIN_SIDES);

  // Top/bottom borders run the whole width of the webcam, so score them across it.
  const bandL = left ? left.pos : faceL;
  const bandR = right ? right.pos : faceR;
  const rowScore = (y) => horizontalEdgeScore(frames, y, bandL, bandR);
  const bottom = findEdge(rowScore, faceB, 1, reachY, H, EDGE_MIN_TOP_BOTTOM);
  const top = findEdge(rowScore, faceT, -1, reachY, H, EDGE_MIN_TOP_BOTTOM);

  return {
    left: left || { pos: Math.max(0, faceL - PAD_SIDE * face.w), how: "guess" },
    right: right || { pos: Math.min(W, faceR + PAD_SIDE * face.w), how: "guess" },
    top: top || { pos: Math.max(0, faceT - PAD_ABOVE * face.h), how: "guess" },
    bottom: bottom || { pos: Math.min(H, faceB + PAD_BELOW * face.h), how: "guess" },
  };
}

function quantile(values, q) {
  const sorted = [...values].sort((x, y) => x - y);
  return sorted[Math.round(q * (sorted.length - 1))];
}

// Bounding box (frame px) of the person whose face is `face`, in one frame.
async function personBox(segmenter, img, face) {
  const regionW = Math.min(img.w, Math.round(face.w * 6.5));
  const regionH = Math.min(img.h, Math.round(face.h * 7.5));
  const rx = Math.max(0, Math.min(img.w - regionW, Math.round(face.x + face.w / 2 - regionW / 2)));
  const ry = Math.max(0, Math.min(img.h - regionH, Math.round(face.y + face.h / 2 - regionH / 2)));

  const buf = new Uint8Array(regionW * regionH * 3);
  for (let y = 0; y < regionH; y++) {
    const src = ((ry + y) * img.w + rx) * 3;
    buf.set(img.rgb.subarray(src, src + regionW * 3), y * regionW * 3);
  }
  const input = tf.tensor3d(buf, [regionH, regionW, 3]);
  let people;
  try {
    people = await segmenter.segmentPeople(input, { multiSegmentation: false, segmentBodyParts: false });
  } finally {
    input.dispose();
  }
  if (!people.length) return null;

  const maskTensor = await people[0].mask.toTensor();
  const data = await maskTensor.data();
  const [mh, mw, mc] = maskTensor.shape;
  maskTensor.dispose();

  // Work on a coarse grid; keep only the blob that contains the face so other
  // people in the frame don't count.
  const step = Math.max(1, Math.floor(Math.max(mw, mh) / 220));
  const gw = Math.ceil(mw / step);
  const gh = Math.ceil(mh / step);
  const fg = new Uint8Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      fg[gy * gw + gx] = data[(gy * step * mw + gx * step) * mc] > PERSON_THRESHOLD ? 1 : 0;
    }
  }

  const sx = mw / regionW;
  const sy = mh / regionH;
  const seedX = Math.min(gw - 1, Math.max(0, Math.floor(((face.x + face.w / 2 - rx) * sx) / step)));
  const seedY = Math.min(gh - 1, Math.max(0, Math.floor(((face.y + face.h / 2 - ry) * sy) / step)));
  if (!fg[seedY * gw + seedX]) return null;

  const seen = new Uint8Array(gw * gh);
  const queue = new Int32Array(gw * gh);
  let head = 0;
  let tail = 0;
  queue[tail++] = seedY * gw + seedX;
  seen[seedY * gw + seedX] = 1;
  let minX = gw, minY = gh, maxX = -1, maxY = -1;
  while (head < tail) {
    const idx = queue[head++];
    const x = idx % gw;
    const y = (idx - x) / gw;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
      if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
      const n = ny * gw + nx;
      if (fg[n] && !seen[n]) {
        seen[n] = 1;
        queue[tail++] = n;
      }
    }
  }

  return {
    l: Math.max(0, rx + (minX * step) / sx),
    t: Math.max(0, ry + (minY * step) / sy),
    r: Math.min(img.w, rx + ((maxX + 1) * step) / sx),
    b: Math.min(img.h, ry + ((maxY + 1) * step) / sy),
  };
}

// The person's extents across all sampled frames (outer quartiles, so one odd
// frame can't stretch the box), or null if they can't be found.
async function personBounds(frames, face, onProgress, signal) {
  let segmenter;
  try {
    segmenter = await getSegmenter();
  } catch (e) {
    return null;
  }
  const boxes = [];
  for (let i = 0; i < frames.length; i++) {
    throwIfStopped(signal);
    onProgress && onProgress(`Outlining the streamer, frame ${i + 1}/${frames.length}…`);
    try {
      await letOthersIn();
      const box = await personBox(segmenter, frames[i], face);
      if (box) boxes.push(box);
    } catch (e) {
      // skip a frame that fails
    }
  }
  if (boxes.length < Math.ceil(frames.length / 2)) return null;
  return {
    l: quantile(boxes.map((b) => b.l), 0.25),
    t: quantile(boxes.map((b) => b.t), 0.25),
    r: quantile(boxes.map((b) => b.r), 0.75),
    b: quantile(boxes.map((b) => b.b), 0.75),
  };
}

async function buildResult(frames, face, onProgress, signal) {
  const W = frames[0].w;
  const H = frames[0].h;
  const edges = snapToWebcam(frames, face);

  // Keyed webcam: no border to snap to, so replace the guessed sides with the person's outline.
  const guessed = ["left", "top", "right", "bottom"].filter((side) => edges[side].how === "guess");
  if (guessed.length >= MIN_GUESSED_SIDES_FOR_KEYED) {
    onProgress && onProgress("No webcam border found — outlining the streamer instead…");
    const person = await personBounds(frames, face, onProgress, signal);
    if (person) {
      const padX = (person.r - person.l) * PERSON_MARGIN;
      const padY = (person.b - person.t) * PERSON_MARGIN;
      const fromPerson = {
        left: Math.max(0, person.l - padX),
        top: Math.max(0, person.t - padY),
        right: Math.min(W, person.r + padX),
        bottom: Math.min(H, person.b + padY),
      };
      for (const side of guessed) edges[side] = { pos: fromPerson[side], how: "person" };
    }
  }

  const rect = { l: edges.left.pos, t: edges.top.pos, r: edges.right.pos, b: edges.bottom.pos };
  const rectW = rect.r - rect.l;
  const rectH = rect.b - rect.t;
  const faceCx = face.x + face.w / 2;
  const faceCy = face.y + face.h / 2;

  // A big face right in the middle of the frame is the camera shot itself (a full-screen
  // facecam), not a webcam overlay sitting on top of gameplay. Real webcam overlays sit
  // toward an edge or corner and their faces are small (about 10-12% of the frame height).
  if (Math.abs(faceCx / W - 0.5) < 0.2 && Math.abs(faceCy / H - 0.5) < 0.25 && face.h / H >= FULLSCREEN_FACE_HEIGHT) {
    return { found: false, reason: "a large face in the middle of the frame — looks like a full-screen camera" };
  }

  const containsFace = faceCx > rect.l && faceCx < rect.r && faceCy > rect.t && faceCy < rect.b;
  const plausible = containsFace && rectW >= face.w * 1.1 && rectH >= face.h * 1.1 && (rectW * rectH) / (W * H) <= 0.6;
  if (!plausible) return { found: false, reason: "snapped box wasn't plausible" };

  // A real overlay has at least one side we actually found (a border or the
  // person's outline). A box made only of frame edges and padding guesses is
  // just "a person somewhere in the footage" — IRL streams, not a facecam.
  const hows = ["left", "top", "right", "bottom"].map((side) => edges[side].how);
  const edgeSides = hows.filter((h) => h === "edge").length;
  const outlineSides = hows.filter((h) => h === "person").length;
  const boundarySides = hows.filter((h) => h === "boundary").length;
  if (!edgeSides && !outlineSides) return { found: false, reason: "no webcam border or outline found — looks like full-frame footage" };
  // A webcam with no visible border (green-screen style) sits in a corner, so it
  // touches two frame edges. A person outline floating mid-frame is a bystander in
  // IRL footage, not a facecam.
  if (!edgeSides && boundarySides < 2) return { found: false, reason: "a person outline in the middle of the frame — looks like IRL footage" };

  return {
    found: true,
    // webcam rectangle, normalized 0-1, origin top-left
    x: rect.l / W,
    y: rect.t / H,
    width: rectW / W,
    height: rectH / H,
    // the detected face inside it, same units — used to center the crop
    faceX: face.x / W,
    faceY: face.y / H,
    faceW: face.w / W,
    faceH: face.h / H,
    edges: {
      left: edges.left.how,
      top: edges.top.how,
      right: edges.right.how,
      bottom: edges.bottom.how,
    },
    confidence: face.hits / SAMPLE_COUNT,
  };
}

async function findFacecam(tools, videoPath, durationSeconds, onProgress, signal) {
  if (!durationSeconds || durationSeconds <= 0) {
    return { found: false, reason: "no duration" };
  }
  const { tmpDir, framePaths } = await extractSampleFrames(tools, videoPath, durationSeconds, signal);
  try {
    const model = await getModel();
    const frames = [];
    const perFrameFaces = [];
    for (let i = 0; i < framePaths.length; i++) {
      throwIfStopped(signal);
      onProgress && onProgress(`Scanning frame ${i + 1}/${framePaths.length} for a face…`);
      await letOthersIn();
      const img = decodeFrame(framePaths[i]);
      frames.push(img);
      try {
        perFrameFaces.push(await detectFaces(model, img));
      } catch (e) {
        perFrameFaces.push([]); // one bad frame shouldn't sink the whole clip
      }
    }
    if (!frames.length) return { found: false, reason: "no frames" };
    if (looksLikeFullCamera(perFrameFaces, frames[0].w, frames[0].h)) {
      return { found: false, reason: "a large face on screen — looks like a full-screen camera (IRL / just chatting)" };
    }
    let face = clusterFace(perFrameFaces, frames[0].w, frames[0].h);
    if (!face) {
      // Nothing in the quick pass. Look again with smaller tiles, which can see a small webcam.
      onProgress && onProgress("Looking closer for a small webcam…");
      const finer = [];
      for (let i = 0; i < frames.length; i += 2) {
        throwIfStopped(signal);
        try {
          finer.push(await detectFaces(model, frames[i], 0.34, 5, 4, true));
        } catch (e) {
          finer.push([]);
        }
      }
      face = clusterFace(finer, frames[0].w, frames[0].h);
    }
    if (!face) return { found: false, reason: "no face seen consistently" };
    if (face.sizeRatio > SAME_FACE_MAX_SIZE_RATIO || face.drift > SAME_FACE_MAX_DRIFT) {
      return { found: false, reason: "different people passing through the same spot — looks like an IRL camera, not a webcam" };
    }
    onProgress && onProgress("Finding the webcam edges…");
    return await buildResult(frames, face, onProgress, signal);
  } finally {
    for (const f of framePaths) {
      try {
        fs.unlinkSync(f);
      } catch (e) {
        // ignore
      }
    }
    try {
      fs.rmdirSync(tmpDir);
    } catch (e) {
      // ignore
    }
  }
}

module.exports = { findFacecam };
