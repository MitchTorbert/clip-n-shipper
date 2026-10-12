const ppro = require("premierepro");

// Bump on every edit so the panel header shows the reload actually took.
const BUILD = "b36";
const HELPER_BASE = "http://localhost:8934";
// The facecam section is sized to the whole webcam at full width, so none of
// the webcam gets trimmed; gameplay gets the rest. The facecam never takes
// more than half the frame; past that limit the webcam gets trimmed to fit.
const MIN_FACECAM_SHARE = 0.25;
const MAX_FACECAM_SHARE = 0.4;

// The pill generator's brand colors: 8 families x 4 shades (light to dark).
const PILL_COLOR_FAMILIES = [
  [["Ice", "#F0F0FF"], ["Smoke", "#D2D2E6"], ["Iron", "#91919F"], ["Black Ops", "#000000"]],
  [["Widow", "#BFABFF"], ["Purple", "#9146FF"], ["Dragon", "#8205B4"], ["Twilight", "#41145F"]],
  [["Jiggle", "#FF8DFF"], ["Cuddle", "#FA1ED2"], ["Edgeworth", "#BE0078"], ["Overlord", "#821946"]],
  [["Worm", "#FACDCD"], ["Peach", "#EA7078"], ["Barrel", "#F7262C"], ["Scrouge", "#A91A26"]],
  [["Star", "#FAFA19"], ["Tangy", "#FDB210"], ["Crash", "#FF6905"], ["Dig", "#904B1C"]],
  [["Ooze", "#BEFF00"], ["Junimo", "#00FA05"], ["Grass", "#009919"], ["Linc", "#006441"]],
  [["Rosalina", "#BEFAE1"], ["Rune", "#69FDC2"], ["Surf", "#00C8AF"], ["Knights", "#215264"]],
  [["Pylon", "#00FAFA"], ["Mana", "#57BEE6"], ["Zero", "#1E69FF"], ["Sonic", "#0014A5"]],
].map((family) => family.map(([name, hex]) => ({ name, hex })));
// New pills start bright pink (Cuddle); later rows reuse whatever color was picked last.
let lastPillColor = PILL_COLOR_FAMILIES[2][1];

// `facecam: false` means a plain stringout: no facecam search, split, or crop.
const DIMENSIONS = [
  { label: "9x16", icon: "916", iw: 9, ih: 16, width: 1080, height: 1920, facecam: true },
  { label: "4x5", icon: "45", iw: 13, ih: 16, width: 1080, height: 1350, facecam: true },
  { label: "16x9", icon: "169", iw: 21, ih: 12, width: 1920, height: 1080, facecam: false },
  { label: "3x4", icon: "34", iw: 14, ih: 18, width: 1080, height: 1440, facecam: true }, // drawn with the X logo
];

const logEl = document.getElementById("log");
const statusEl = document.getElementById("statusLine");
const setupBtn = document.getElementById("setupBtn");
const stopBtn = document.getElementById("stopBtn");
const sequencesEl = document.getElementById("sequences");
const addSeqBtn = document.getElementById("addSeqBtn");
let premiereVersion = "";
try {
  premiereVersion = require("uxp").host.version || "";
} catch (e) {
  // not available; the build number alone is fine
}
// Windows-only look fixes live in index.html under "body.win"; the Mac never gets this class.
let isWindows = false;
try {
  isWindows = require("os").platform() === "win32";
} catch (e) {
  isWindows = /^win/i.test((typeof navigator !== "undefined" && navigator.platform) || "");
}
if (isWindows) document.body.className = (document.body.className + " win").trim();
document.getElementById("build").textContent = "build " + BUILD + (premiereVersion ? " · Premiere " + premiereVersion : "");

// Progress chatter goes to the developer console only. Anything the user needs to know
// (errors, and messages marked `notice`) is kept in `notices` and shown in the report.
let logLines = [];
const notices = []; // { text, level }
function log(msg, cls, notice) {
  logLines.push(msg);
  if (cls === "err" || notice) notices.push({ text: msg, level: cls === "err" ? "err" : "warn" });
  console.log("[clip-n-ship]", msg);
}

// The status line only appears when something needs fixing.
function setStatus(msg, cls) {
  statusEl.textContent = msg;
  statusEl.className = cls || "";
  statusEl.style.display = cls === "ok" ? "none" : "block";
}

// Buttons are plain divs: UXP's built-in <button> draws its own pill-shaped
// outline that fights our rounded corners, so we style everything ourselves.
// Windows draws the 3x PNG aspect-ratio icons unevenly at its display scales (top and
// left edges look thicker), so it gets vector copies of the same icons instead.
function sizeIconSrc(icon, color) {
  return isWindows ? `icons/win/ar_${icon}_${color}.svg` : `icons/ar_${icon}_${color}.png`;
}

function iconImg(src, className) {
  const img = el("img", className || "btn-icon");
  img.setAttribute("src", src);
  return img;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// Premiere's plain <input> draws its text hard against the left edge and ignores
// padding, text-indent and wrapper tricks. So the inset is made of a few real
// (non-breaking) spaces at the front of whatever is typed: added when you click
// in, kept in front of anything typed or pasted, and removed again when you
// click away from an empty box so the preview text shows. Everything that reads
// a field trims it, so the spaces never reach a link or a sequence name.
const FIELD_INSET = "\u00A0\u00A0\u00A0";
function textInput(placeholder) {
  const input = el("input", "text");
  input.setAttribute("type", "text");
  if (placeholder) input.setAttribute("placeholder", FIELD_INSET + placeholder);
  input.addEventListener("focus", () => {
    if (input.value === "") input.value = FIELD_INSET;
  });
  input.addEventListener("input", () => {
    if (input.value !== "" && !input.value.startsWith(FIELD_INSET)) {
      input.value = FIELD_INSET + input.value.replace(/^[\s\u00A0]+/, "");
    }
  });
  input.addEventListener("blur", () => {
    if (input.value.trim() === "") input.value = "";
  });
  return input;
}

// The colored box around a text input (see the note in index.html).
function boxed(input) {
  const box = el("div", "field-box");
  box.appendChild(input);
  return box;
}

function setEnabled(node, enabled) {
  node._enabled = enabled;
  node.className = node.className.replace(/\s*\bdisabled\b/g, "") + (enabled ? "" : " disabled");
}

// Premiere's panel sometimes drops the first "click" (the one that also moves
// focus out of a text box), so react to the mouse-down as well and make sure
// one physical click only ever counts once.
//
// Windows: there the text boxes are native Windows controls, and while one has the cursor the
// first click anywhere else in the panel only takes focus back and never arrives (pill name ->
// color circle needed two clicks). So when the mouse reaches something clickable and nobody has
// typed for a moment, the text box lets go of the cursor first and the click lands.
let lastTypedAt = 0;
if (isWindows) {
  document.addEventListener("keydown", () => (lastTypedAt = Date.now()), true);
  document.addEventListener("input", () => (lastTypedAt = Date.now()), true);
  document.addEventListener("focus", () => (lastTypedAt = Date.now()), true); // just clicked into a box: give it a moment
}
function releaseTextFocus() {
  const active = document.activeElement;
  if (!active || active.tagName !== "INPUT" || active.type === "checkbox") return;
  if (Date.now() - lastTypedAt < 800) return;
  try {
    active.blur();
  } catch (e) {
    // nothing to let go of
  }
}
function onClick(node, handler) {
  if (isWindows) node.addEventListener("mouseenter", releaseTextFocus);
  let lastFired = 0;
  const fire = () => {
    const now = Date.now();
    if (now - lastFired < 400) return;
    lastFired = now;
    if (node._enabled === false) return;
    handler();
  };
  node.addEventListener("mousedown", fire);
  node.addEventListener("click", fire);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---- helper server ----

async function pingHelper() {
  try {
    const res = await fetch(HELPER_BASE + "/ping");
    return res.ok ? await res.json() : null;
  } catch (e) {
    return null;
  }
}

let activeJobId = null;
let stopRequested = false;

async function startJob(clips, projectDir, detectFacecam, alreadyPilled, clearFolders, detectCaptions, nameCounts) {
  const res = await fetch(HELPER_BASE + "/process", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clips, projectDir, detectFacecam, alreadyPilled, clearFolders: !!clearFolders, detectCaptions: !!detectCaptions, nameCounts: nameCounts || {} }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Helper rejected the request");
  return data.jobId;
}

// Returns the manifest, or null if the job was stopped.
async function pollJob(jobId, onLogLine) {
  let linesShown = 0;
  let missedPolls = 0;
  while (true) {
    await sleep(1500);
    let job;
    try {
      const res = await fetch(HELPER_BASE + "/status/" + jobId);
      job = await res.json();
      missedPolls = 0;
    } catch (e) {
      // Windows: the helper can be too busy (face detection) to answer for a while.
      // Keep waiting up to about 3 minutes before calling it a failure. The Mac fails at once as before.
      if (!isWindows || ++missedPolls > 120) throw e;
      if (stopRequested) return null;
      continue;
    }
    for (; linesShown < job.log.length; linesShown++) onLogLine(job.log[linesShown]);
    if (job.status === "done") return job.manifest;
    if (job.status === "cancelled" || stopRequested) return null;
    if (job.status === "error") throw new Error(job.error || "Helper job failed");
  }
}

async function onStopClick() {
  stopRequested = true;
  setEnabled(stopBtn, false);
  log("Stopping…", "warn");
  if (activeJobId) {
    try {
      await fetch(HELPER_BASE + "/cancel/" + activeJobId, { method: "POST" });
    } catch (e) {
      // the helper may already be gone; the panel stops waiting either way
    }
  }
}

// ---- project / status ----

// Clips are named "<Streamer> <n>". When adding to a project that already has
// clips, numbering carries on from the highest number found in its footage bin.
const SOURCE_BIN_NAME = "01 Source Footage";
async function countExistingClips(project) {
  const counts = {};
  try {
    const root = await project.getRootItem();
    const bin = (await root.getItems()).find((i) => i.name === SOURCE_BIN_NAME);
    if (!bin) return counts;
    for (const item of await ppro.FolderItem.cast(bin).getItems()) {
      const m = item.name.replace(/\.[A-Za-z0-9]{2,4}$/, "").match(/^(.*\S) (\d+)$/);
      if (!m) continue;
      const key = m[1].toLowerCase();
      counts[key] = Math.max(counts[key] || 0, parseInt(m[2], 10));
    }
  } catch (e) {
    console.error("[clip-n-ship] couldn't read existing clip names:", e);
  }
  return counts;
}

async function refreshStatus() {
  const ping = await pingHelper();
  const helperUp = !!ping;
  const helperStale = !!(ping && ping.stale);
  const project = await ppro.Project.getActiveProject();
  if (!helperUp && !project) {
    setStatus('The helper is not running and no project is open. Double-click "Start Clip-n-Ship Helper.command", then open a project in Premiere.', "err");
  } else if (!helperUp) {
    setStatus('The helper is not running. Double-click "Start Clip-n-Ship Helper.command" in the Clip-n-Ship Setup folder.', "err");
  } else if (helperStale) {
    setStatus('The helper is out of date. Close its Terminal window, then double-click "Start Clip-n-Ship Helper.command" again.', "err");
  } else if (!project) {
    setStatus("No project is open. Open or create one in Premiere.", "err");
  } else {
    setStatus("", "ok");
  }
  return { helperUp, helperStale, project };
}

// A box normally holds one link, but pasting several at once (which a
// single-line box runs together) still works: split wherever a new link starts.
function splitLinks(value) {
  return value
    .split(/(?=https?:\/\/)/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

// twitch.tv/<channel>/clip/<name>, clips.twitch.tv/<name>, or an x.com /
// twitter.com post (x.com/<user>/status/<id>). Anything else (a channel, a VOD,
// a typo) isn't a clip and is skipped.
const MAX_YOUTUBE_MINUTES = 5; // the most footage taken from a YouTube video
const YOUTUBE_RE = /(?:youtube\.com\/(?:watch\?(?:[^#]*&)?v=|shorts\/|live\/|embed\/)|youtu\.be\/)[A-Za-z0-9_-]{11}/i;
function isClipUrl(url) {
  return (
    /twitch\.tv\/[^\/]+\/clip\/[^\/?&#]+/i.test(url) ||
    /clips\.twitch\.tv\/[^\/?&#]+/i.test(url) ||
    /(?:x|twitter)\.com\/[^\/?#]+\/status\/\d+/i.test(url) ||
    YOUTUBE_RE.test(url)
  );
}

// Mac paths use "/" and Windows paths use "\\" (C:\\Users\\Ed\\Project.prproj), so both are understood.
function lastSeparator(filePath) {
  return Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
}
function dirname(filePath) {
  const idx = lastSeparator(filePath);
  return idx >= 0 ? filePath.slice(0, idx) : filePath;
}
function basename(filePath) {
  const idx = lastSeparator(filePath);
  return idx >= 0 ? filePath.slice(idx + 1) : filePath;
}
// A file inside a folder, joined with the separator that folder already uses.
function joinPath(dir, name) {
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  return dir.replace(/[\\/]+$/, "") + sep + name;
}

// ---- crop math ----
// Position is pixel coordinates in sequence space, origin top-left, where the
// clip's Anchor Point (left at its native default: the clip's own center)
// ends up. Scale is a percentage where 100 = source pixels map 1:1 onto the
// sequence. To land a specific source-pixel crop window centered at
// (cropCenterX, cropCenterY) into a target rect in the sequence:
//
//   scale% = (targetW / cropW) * 100
//   Position = targetCenter - scale * (cropCenter - nativeCenter)

function fitCropWindow(centerX, centerY, w, h, srcW, srcH) {
  w = Math.min(w, srcW);
  h = Math.min(h, srcH);
  let x0 = centerX - w / 2;
  let y0 = centerY - h / 2;
  x0 = Math.max(0, Math.min(srcW - w, x0));
  y0 = Math.max(0, Math.min(srcH - h, y0));
  return { centerX: x0 + w / 2, centerY: y0 + h / 2, w, h };
}

function computeTransform(srcW, srcH, crop, target) {
  const scaleFactor = target.w / crop.w;
  const nativeCenterX = srcW / 2;
  const nativeCenterY = srcH / 2;
  const targetCenterX = target.x + target.w / 2;
  const targetCenterY = target.y + target.h / 2;
  return {
    scale: scaleFactor * 100,
    posX: targetCenterX - scaleFactor * (crop.centerX - nativeCenterX),
    posY: targetCenterY - scaleFactor * (crop.centerY - nativeCenterY),
  };
}

// Where the facecam and gameplay sections go: facecam on top, sized to the
// webcam's own shape within the limits above, gameplay below it.
function layoutFor(srcW, srcH, facecam, seq) {
  const camAspect = (facecam.width * srcW) / (facecam.height * srcH);
  const h = Math.min(
    Math.round(seq.height * MAX_FACECAM_SHARE),
    Math.max(Math.round(seq.height * MIN_FACECAM_SHARE), Math.round(seq.width / camAspect))
  );
  return {
    facecam: { x: 0, y: 0, w: seq.width, h },
    gameplay: { x: 0, y: h, w: seq.width, h: seq.height - h },
  };
}

// Fills the facecam section with the largest slice of the webcam rectangle that
// has the section's shape, centered on the face and kept inside the webcam.
// Normally that's the whole webcam; it only trims when the limits kicked in.
function facecamTransform(srcW, srcH, facecam, target) {
  const targetAspect = target.w / target.h;
  const rx = facecam.x * srcW;
  const ry = facecam.y * srcH;
  const rw = facecam.width * srcW;
  const rh = facecam.height * srcH;

  let cropW, cropH;
  if (rw / rh >= targetAspect) {
    cropH = rh;
    cropW = rh * targetAspect;
  } else {
    cropW = rw;
    cropH = rw / targetAspect;
  }

  const faceCenterX = (facecam.faceX + facecam.faceW / 2) * srcW;
  const faceCenterY = (facecam.faceY + facecam.faceH / 2) * srcH;
  const x0 = Math.min(Math.max(faceCenterX - cropW / 2, rx), rx + rw - cropW);
  const y0 = Math.min(Math.max(faceCenterY - cropH / 2, ry), ry + rh - cropH);
  const crop = { centerX: x0 + cropW / 2, centerY: y0 + cropH / 2, w: cropW, h: cropH };
  return {
    ...computeTransform(srcW, srcH, crop, target),
    // The window as fractions of the source frame trimmed off each side, for the Crop effect.
    edges: {
      left: x0 / srcW,
      top: y0 / srcH,
      right: (srcW - x0 - cropW) / srcW,
      bottom: (srcH - y0 - cropH) / srcH,
    },
  };
}

// Full source height, centered, so it fills exactly the gameplay section. The
// overflow runs off-canvas to the sides. When Twitch captions sit along the
// bottom (`bottomCrop` = the share of the height they take), that strip is
// cropped off and the rest is scaled up to fill the section instead.
function gameplayTransform(srcW, srcH, target, bottomCrop) {
  bottomCrop = bottomCrop || 0;
  const usableH = srcH * (1 - bottomCrop);
  const targetAspect = target.w / target.h;
  let cropH = usableH;
  let cropW = cropH * targetAspect;
  if (cropW > srcW) {
    cropW = srcW;
    cropH = cropW / targetAspect;
  }
  const crop = fitCropWindow(srcW / 2, usableH / 2, cropW, cropH, srcW, usableH);
  const transform = computeTransform(srcW, srcH, crop, target);
  if (bottomCrop > 0) transform.edges = { left: 0, top: 0, right: 0, bottom: bottomCrop };
  return transform;
}

// A whole-frame layer shown at scale factor k, centered in the sequence, with
// the bottom `bottomCrop` share of the footage cropped away. The crop lives in
// Motion's Crop Bottom; the position is shifted so what's left stays centered.
function centeredLayerTransform(srcW, srcH, seq, k, bottomCrop) {
  bottomCrop = bottomCrop || 0;
  const usableH = srcH * (1 - bottomCrop);
  const crop = { centerX: srcW / 2, centerY: usableH / 2, w: srcW, h: usableH };
  const target = { x: seq.width / 2 - (srcW * k) / 2, y: seq.height / 2 - (usableH * k) / 2, w: srcW * k, h: usableH * k };
  const transform = computeTransform(srcW, srcH, crop, target);
  if (bottomCrop > 0) transform.edges = { left: 0, top: 0, right: 0, bottom: bottomCrop };
  return transform;
}

// Plain stringout: the whole clip, centered, scaled down only if it's bigger
// than the sequence (or up if smaller) so it fits.
function stringoutTransform(srcW, srcH, seq) {
  const k = Math.min(seq.width / srcW, seq.height / srcH);
  return { scale: k * 100, posX: seq.width / 2, posY: seq.height / 2 };
}

// Blurred-background layer: the same footage scaled up until it fills the whole
// frame (full height for a widescreen clip in a vertical sequence), centered.
// It works from the clip's real pixel size, so any source resolution lands on
// exactly the sequence height (1920, 1440, ...). A 2.5% overscan keeps the
// blur's soft edges outside the frame.
const BLUR_OVERSCAN = 1.025;
function blurBackgroundTransform(srcW, srcH, seq, bottomCrop) {
  const usableH = srcH * (1 - (bottomCrop || 0));
  const k = Math.max(seq.width / srcW, seq.height / usableH) * BLUR_OVERSCAN;
  return centeredLayerTransform(srcW, srcH, seq, k, bottomCrop);
}

// Sharp footage over a blurred background: Scale 100 for 1080p footage (about
// 56% of a 1920-tall frame, 75% of a 1440-tall one), centered. Footage with
// another resolution is scaled to the same on-screen size, so it looks the
// same as 1080p footage at 100. Vertical footage just fits the frame.
const SHARP_REFERENCE_HEIGHT = 1080;
function sharpOverBlurTransform(srcW, srcH, seq, bottomCrop) {
  const usableH = srcH * (1 - (bottomCrop || 0));
  const k = srcH > srcW ? Math.min(seq.width / srcW, seq.height / usableH) : SHARP_REFERENCE_HEIGHT / srcH;
  return centeredLayerTransform(srcW, srcH, seq, k, bottomCrop);
}

// ---- Premiere-side build ----

async function findMotionComponent(trackItem) {
  const chain = await trackItem.getComponentChain();
  const count = chain.getComponentCount();
  for (let i = 0; i < count; i++) {
    const c = chain.getComponentAtIndex(i);
    const matchName = await c.getMatchName();
    if (matchName === "AE.ADBE Motion") return c;
  }
  for (let i = 0; i < count; i++) {
    const c = chain.getComponentAtIndex(i);
    const displayName = await c.getDisplayName();
    if (displayName === "Motion") return c;
  }
  return null;
}

function findParamsOnMotion(motion) {
  const byName = {};
  const count = motion.getParamCount();
  for (let i = 0; i < count; i++) {
    const p = motion.getParam(i);
    byName[p.displayName] = p;
  }
  return {
    posParam: byName["Position"] || motion.getParam(0),
    scaleParam: byName["Scale"] || byName["Scale Height"] || motion.getParam(1),
    // Motion's crop fields sit at slots 7-10, in this order.
    crop: {
      left: byName["Crop Left"] || (count > 10 ? motion.getParam(7) : undefined),
      top: byName["Crop Top"] || (count > 10 ? motion.getParam(8) : undefined),
      right: byName["Crop Right"] || (count > 10 ? motion.getParam(9) : undefined),
      bottom: byName["Crop Bottom"] || (count > 10 ? motion.getParam(10) : undefined),
    },
  };
}

// Sets Position and Scale on the clip's Motion settings and, when the
// transform has crop edges, the Crop Left/Top/Right/Bottom fields right
// there too (percentages), so everything stays editable in Effect Controls.
async function applyFraming(project, trackItem, transform, seq) {
  const numbers = [transform.posX, transform.posY, transform.scale];
  if (transform.edges) numbers.push(transform.edges.left, transform.edges.top, transform.edges.right, transform.edges.bottom);
  if (!numbers.every(Number.isFinite)) {
    throw new Error("framing numbers came out invalid — the helper may be running old code; restart it and try again");
  }
  const motion = await findMotionComponent(trackItem);
  if (!motion) throw new Error("Couldn't find the Motion effect on this clip");
  const { posParam, scaleParam, crop } = findParamsOnMotion(motion);

  // Position is a fraction of the sequence frame (0-1, origin top-left), not pixels.
  const posKeyframe = posParam.createKeyframe(new ppro.PointF(transform.posX / seq.width, transform.posY / seq.height));
  const scaleKeyframe = scaleParam.createKeyframe(transform.scale);

  const cropKeyframes = [];
  if (transform.edges) {
    if (!crop.left || !crop.top || !crop.right || !crop.bottom) {
      throw new Error("couldn't find Motion's Crop Left/Top/Right/Bottom settings");
    }
    for (const side of ["left", "top", "right", "bottom"]) {
      const percent = Math.max(0, transform.edges[side] * 100);
      cropKeyframes.push([crop[side], crop[side].createKeyframe(percent)]);
    }
  }

  // Create the set-value actions inside the transaction, as the earlier working version did.
  let success = false;
  project.lockedAccess(() => {
    success = project.executeTransaction((compound) => {
      compound.addAction(posParam.createSetValueAction(posKeyframe, true));
      compound.addAction(scaleParam.createSetValueAction(scaleKeyframe, true));
      for (const [param, keyframe] of cropKeyframes) {
        compound.addAction(param.createSetValueAction(keyframe, true));
      }
    }, "Clip-n-Ship: apply framing");
  });
  if (!success) throw new Error("Premiere rejected the framing changes");
  console.log("[clip-n-ship] framing applied:", { scale: transform.scale, posX: transform.posX, posY: transform.posY, edges: transform.edges });
}

// Adds the Gaussian Blur effect to a clip and sets its Amount. The newer
// effect (the one in the editors' own projects) is tried first, then the
// older one, whose strength field is called Blurriness.
const BLUR_MATCH_NAMES = ["AE.Impact_Blur_FX", "AE.ADBE Gaussian Blur 2"];
const BLUR_AMOUNT = 8;

async function addGaussianBlur(project, trackItem, amount) {
  let component = null;
  let matchName = null;
  for (const name of BLUR_MATCH_NAMES) {
    try {
      component = await ppro.VideoFilterFactory.createComponent(name);
    } catch (e) {
      component = null;
    }
    if (component) {
      matchName = name;
      break;
    }
  }
  if (!component) throw new Error("this version of Premiere didn't offer a Gaussian Blur effect");

  const chain = await trackItem.getComponentChain();
  let added = false;
  project.lockedAccess(() => {
    added = project.executeTransaction((compound) => {
      compound.addAction(chain.createAppendComponentAction(component));
    }, "Clip-n-Ship: add Gaussian Blur");
  });
  if (!added) throw new Error("Premiere rejected adding the blur effect");

  // Look the effect up again on the clip, then set its strength.
  const after = await trackItem.getComponentChain();
  let blur = null;
  for (let i = after.getComponentCount() - 1; i >= 0; i--) {
    const c = after.getComponentAtIndex(i);
    if ((await c.getMatchName()) === matchName) {
      blur = c;
      break;
    }
  }
  if (!blur) throw new Error("the blur effect was added but couldn't be found to set its amount");
  let amountParam = null;
  for (let i = 0; i < blur.getParamCount(); i++) {
    const p = blur.getParam(i);
    if (p.displayName === "Amount" || p.displayName === "Blurriness") {
      amountParam = p;
      break;
    }
  }
  if (!amountParam) throw new Error("couldn't find the blur's Amount setting");
  const keyframe = amountParam.createKeyframe(amount);
  let set = false;
  project.lockedAccess(() => {
    set = project.executeTransaction((compound) => {
      compound.addAction(amountParam.createSetValueAction(keyframe, true));
    }, "Clip-n-Ship: set blur amount");
  });
  if (!set) throw new Error("Premiere rejected setting the blur amount");
}

// Children returned by FolderItem.getItems() come back as plain ProjectItem
// references without the bin-specific methods (getItems, createBinAction)
// attached — they need an explicit cast to unlock those, same pattern the
// official samples use for ClipProjectItem.
async function asFolderItem(item) {
  return ppro.FolderItem.cast(item);
}

async function ensureFolders(project, folderNames) {
  const root = await project.getRootItem();
  const existing = await root.getItems();
  const binsByName = {};
  for (const item of existing) {
    if (folderNames.includes(item.name)) binsByName[item.name] = await asFolderItem(item);
  }

  const missing = folderNames.filter((n) => !binsByName[n]);
  if (missing.length) {
    project.lockedAccess(() => {
      project.executeTransaction((compound) => {
        for (const name of missing) {
          compound.addAction(root.createBinAction(name, false));
        }
      }, "Clip-n-Ship: create folders");
    });
    const after = await root.getItems();
    for (const item of after) {
      if (folderNames.includes(item.name)) binsByName[item.name] = await asFolderItem(item);
    }
  }
  return binsByName;
}

// Drops a pill on V3 at the given time, centered at its native size (the user
// positions pills by hand). Overwrite, so nothing else in the sequence shifts.
async function placePill(project, sequence, pillItem, timeSeconds, videoTrackIndex) {
  const editor = ppro.SequenceEditor.getEditor(sequence);
  const time = ppro.TickTime.createWithSeconds(timeSeconds);
  let success = false;
  project.lockedAccess(() => {
    success = project.executeTransaction((compound) => {
      const action =
        typeof editor.createOverwriteItemAction === "function"
          ? editor.createOverwriteItemAction(pillItem, time, videoTrackIndex === undefined ? 2 : videoTrackIndex, 0)
          : editor.createInsertProjectItemAction(pillItem, time, videoTrackIndex === undefined ? 2 : videoTrackIndex, 0, false);
      compound.addAction(action);
    }, "Clip-n-Ship: place pill");
  });
  if (!success) throw new Error("Premiere rejected placing the pill");
}

// Standard frame rates, and Premiere's exact ticks per frame for each (254016000000 ticks a second).
const STANDARD_FPS = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60];
const TICKS_PER_SECOND = 254016000000;
function ticksPerFrame(fps) {
  const ntsc = { 23.976: 24, 29.97: 30, 59.94: 60 }[fps];
  return ntsc ? Math.round((TICKS_PER_SECOND * 1001) / (ntsc * 1000)) : Math.round(TICKS_PER_SECOND / fps);
}

// The sequence frame rate for a set of clips: each clip's rate snapped to the nearest standard
// one, then the lowest of them when they're mixed. Null when no clip says.
function sequenceFpsFor(clips) {
  const rates = clips
    .map((c) => Number(c.fps))
    .filter((f) => Number.isFinite(f) && f > 1)
    .map((f) => STANDARD_FPS.reduce((a, b) => (Math.abs(b - f) < Math.abs(a - f) ? b : a)));
  return rates.length ? Math.min(...rates) : null;
}

async function buildSequence(project, seq, fps) {
  const sequence = await project.createSequence(seq.name);
  const settings = await sequence.getSettings();
  const rect = new ppro.RectF();
  rect.width = seq.width;
  rect.height = seq.height;
  await settings.setVideoFrameRect(rect);
  // Match the footage instead of Premiere's default preset (Premiere 26.2+; older builds keep the default).
  if (fps && typeof settings.setVideoFrameRate === "function" && ppro.FrameRate && typeof ppro.FrameRate.createWithValue === "function") {
    try {
      const rate = ppro.FrameRate.createWithValue(fps);
      try {
        rate.ticksPerFrame = ticksPerFrame(fps); // exact NTSC rates (23.976 etc.)
      } catch (e) {
        // read-only on this build; createWithValue's own rate is close enough
      }
      await settings.setVideoFrameRate(rate);
      log(`Sequence frame rate set to ${fps} fps to match the footage.`);
    } catch (e) {
      log(`Couldn't set the sequence frame rate (${e && e.message ? e.message : e}); it uses Premiere's default.`, "warn", true);
    }
  }

  let success = false;
  project.lockedAccess(() => {
    success = project.executeTransaction((compound) => {
      compound.addAction(sequence.createSetSettingsAction(settings));
    }, `Clip-n-Ship: set sequence to ${seq.width}x${seq.height}`);
  });
  if (!success) throw new Error(`Couldn't set the sequence to ${seq.width}x${seq.height}`);

  await project.setActiveSequence(sequence);
  return sequence;
}

// Makes a copy of the clip that has video only, so the gameplay layer never
// carries a second audio track. It's a subclip: same media, no new file.
async function createVideoOnlyCopy(project, folders, projectItem, name) {
  const clip = ppro.ClipProjectItem.cast(projectItem);
  const start = await clip.getInPoint(ppro.Constants.MediaType.VIDEO);
  const end = await clip.getOutPoint(ppro.Constants.MediaType.VIDEO);
  let success = false;
  project.lockedAccess(() => {
    success = project.executeTransaction((compound) => {
      compound.addAction(clip.createSubClipAction(name, start, end, false, { takeVideo: true, takeAudio: false }));
    }, "Clip-n-Ship: video-only copy");
  });
  if (!success) throw new Error("Premiere rejected making the video-only copy");
  for (const folder of folders) {
    const items = await folder.getItems();
    const copy = items.find((i) => i.name === name);
    if (copy) return copy;
  }
  throw new Error("couldn't find the video-only copy after making it");
}

// Removes the audio that came along with the gameplay layer (it sits on A2), so
// both layers can share the one project item instead of a "(video only)" copy.
// Returns true when the audio is really gone.
async function removeExtraAudio(project, sequence, audioTrackIndex) {
  const trackAfter = async () => (await sequence.getAudioTrack(audioTrackIndex)).getTrackItems(ppro.Constants.TrackItemType.CLIP, false);
  const before = await trackAfter();
  const item = before[before.length - 1];
  if (!item) return false;
  const editor = ppro.SequenceEditor.getEditor(sequence);
  let ok = false;
  // The selection only exists inside this callback, so the removal is built and run in here.
  ppro.TrackItemSelection.createEmptySelection((selection) => {
    selection.addItem(item, true);
    project.lockedAccess(() => {
      ok = project.executeTransaction((compound) => {
        compound.addAction(editor.createRemoveItemsAction(selection, false, ppro.Constants.MediaType.AUDIO, false));
      }, "Clip-n-Ship: drop extra audio");
    });
  });
  if (!ok) return false;
  return (await trackAfter()).length < before.length;
}
let extraAudioRemovalBroken = false; // once it fails, the rest of the run falls back to video-only copies

// Gameplay goes on V1. The facecam copy goes on V2 above it, with the real
// audio on A1 so it stays linked to the facecam clip. A clip with no facecam
// is just placed on V1/A1.
async function insertClips(project, sequence, gameplaySource, gameplayAudioTrack, facecamSource, timeSeconds) {
  const editor = ppro.SequenceEditor.getEditor(sequence);
  const time = ppro.TickTime.createWithSeconds(timeSeconds);
  let success = false;
  project.lockedAccess(() => {
    success = project.executeTransaction((compound) => {
      compound.addAction(editor.createInsertProjectItemAction(gameplaySource, time, 0, gameplayAudioTrack, false));
      if (facecamSource) {
        compound.addAction(editor.createInsertProjectItemAction(facecamSource, time, 1, 0, false));
      }
    }, "Clip-n-Ship: insert clip");
  });
  if (!success) throw new Error("Premiere rejected inserting this clip");

  const lastItem = async (trackIndex) => {
    const track = await sequence.getVideoTrack(trackIndex);
    const items = track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false);
    return items[items.length - 1];
  };
  return {
    gameplayItem: await lastItem(0),
    facecamItem: facecamSource ? await lastItem(1) : null,
  };
}

// Testing aid: removes every sequence, bin, and clip from the open project.
// Only touches the Premiere project — files on disk are never deleted.
async function clearProject(project) {
  const sequences = await project.getSequences();
  for (const seq of sequences) {
    try {
      await project.closeSequence(seq);
    } catch (e) {
      // a sequence that isn't open can't be closed; that's fine
    }
    try {
      await project.deleteSequence(seq);
    } catch (e) {
      log(`Couldn't delete a sequence: ${e && e.message ? e.message : e}`, "warn");
    }
  }

  const root = await project.getRootItem();
  const items = await root.getItems();
  if (items.length) {
    let success = false;
    project.lockedAccess(() => {
      success = project.executeTransaction((compound) => {
        for (const item of items) compound.addAction(root.createRemoveItemAction(item));
      }, "Clip-n-Ship: clear project");
    });
    if (!success) throw new Error("Premiere rejected clearing the project");
  }
  log(`Cleared ${sequences.length} sequence(s) and ${items.length} top-level item(s).`);
}

// What happened to each clip, for the end-of-run report.
function shortError(error) {
  const e = String(error || "");
  if (/too long|minutes long/i.test(e)) return "Too long for a clip";
  if (/live stream/i.test(e)) return "Live stream, not a clip";
  if (/isn't a twitch clip|not a clip/i.test(e)) return "Not a clip link";
  if (/time(d)? ?out/i.test(e)) return "Timed out";
  if (/private|unavailable|not found|404/i.test(e)) return "Clip unavailable";
  return e ? e.slice(0, 40) : "Download failed";
}

function shortLink(url) {
  const m = String(url).match(/(?:twitch\.tv\/|x\.com\/|twitter\.com\/)([^\/?#]+)/i);
  return m ? m[1] : String(url).slice(0, 40);
}

async function buildProject(project, manifest, seq, clearFirst) {
  const entries = new Map();
  for (const c of manifest.clips) {
    entries.set(c, {
      label: c.failed ? shortLink(c.url) : c.displayName && c.number ? `${c.displayName} ${c.number}` : c.channelName || c.streamer || basename(c.filePath),
      layout: "",
      captions: false,
      pill: null,
      flags: c.failed ? [{ level: "err", text: shortError(c.error) }] : [],
    });
  }
  const finish = () => manifest.clips.map((c) => entries.get(c));

  if (clearFirst) {
    log("Clearing the project…");
    await clearProject(project);
  }

  const folderNames = Object.values(manifest.folders);
  log("Creating folders in the project…");
  const bins = await ensureFolders(project, folderNames);
  const sourceBin = bins[manifest.folders.sourceFootage];

  const okClips = manifest.clips.filter((c) => !c.failed);
  if (!okClips.length) {
    log("No clips downloaded successfully — nothing to build.", "err");
    return finish();
  }

  const filePaths = okClips.map((c) => c.filePath);
  console.log("[clip-n-ship] sourceBin =", sourceBin, "typeof:", typeof sourceBin);
  console.log("[clip-n-ship] filePaths =", filePaths);
  log(`Importing ${okClips.length} clip(s)…`);
  try {
    const importResult = await project.importFiles(filePaths, true, sourceBin || null, false);
    console.log("[clip-n-ship] importFiles result =", importResult);
  } catch (e) {
    console.error("[clip-n-ship] importFiles threw:", e, "stringified:", String(e), "JSON:", JSON.stringify(e));
    throw new Error("importFiles failed: " + String(e));
  }

  const sourceItems = await sourceBin.getItems();
  const root = await project.getRootItem();
  function findItemIn(items, filePath) {
    const base = basename(filePath);
    const baseNoExt = base.replace(/\.[^.]+$/, "");
    return items.find((i) => i.name === base || i.name === baseNoExt);
  }
  const findItemForFile = (filePath) => findItemIn(sourceItems, filePath);

  // Bring the name pills into the "02 Pills" bin.
  let pillItems = [];
  const pillFiles = [...new Set(okClips.flatMap((c) => [c.pill, ...(c.extraPills || [])]).filter((p) => p && !p.failed).map((p) => p.path))];
  const pillsBin = bins[manifest.folders.pills];
  if (pillFiles.length && pillsBin) {
    log(`Importing ${pillFiles.length} pill(s)…`);
    try {
      await project.importFiles(pillFiles, true, pillsBin, false);
      pillItems = await pillsBin.getItems();
    } catch (e) {
      log(`Couldn't import the pills: ${e && e.message ? e.message : e}`, "warn", true);
    }
  }

  // Bring the shared sound effects (the bleep) into "03 SFX", once.
  const sfxBin = bins[manifest.folders.sfx];
  if (sfxBin && manifest.sfxFiles && manifest.sfxFiles.length) {
    try {
      const have = (await sfxBin.getItems()).map((i) => i.name);
      const missing = manifest.sfxFiles.filter((f) => !have.some((n) => n === basename(f) || n === basename(f).replace(/\.[^.]+$/, "")));
      if (missing.length) await project.importFiles(missing, true, sfxBin, false);
    } catch (e) {
      log(`Couldn't import the sound effects: ${e && e.message ? e.message : e}`, "warn", true);
    }
  }

  // The caption look: bring "Twitch Subtitles" into the GFX bin, once.
  const gfxBin = bins[manifest.folders.gfx];
  if (gfxBin && manifest.styleFiles && manifest.styleFiles.length) {
    try {
      const have = (await gfxBin.getItems()).map((i) => i.name);
      const missing = manifest.styleFiles.filter((f) => !have.some((n) => n === basename(f) || n === basename(f).replace(/\.[^.]+$/, "")));
      if (missing.length) {
        await project.importFiles(missing, true, gfxBin, false);
        const after = (await gfxBin.getItems()).map((i) => i.name);
        log("GFX files imported (caption style, layout templates). GFX bin now holds: " + (after.join(", ") || "nothing") + ".");
      }
    } catch (e) {
      log(`Couldn't import the caption style and templates: ${e && e.message ? e.message : e}`, "warn", true);
    }
  }

  log(`Creating sequence "${seq.name}" at ${seq.width}x${seq.height}…`);
  const sequence = await buildSequence(project, seq, sequenceFpsFor(okClips));

  let t = 0;
  for (const clip of okClips) {
    if (stopRequested) {
      log("Stopped — the clips placed so far are in the sequence.", "warn", true);
      return finish();
    }
    const E = entries.get(clip);
    const flag = (level, text) => E.flags.push({ level, text });
    const projectItem = findItemForFile(clip.filePath);
    if (!projectItem) {
      log(`Couldn't find the imported clip for ${basename(clip.filePath)} — skipping.`, "err");
      flag("err", "Clip not found in project");
      continue;
    }
    const clipName = basename(clip.filePath).replace(/\.[^.]+$/, "");
    const wantsFacecam = seq.facecam && !seq.blurBackground;
    const hasFacecam = wantsFacecam && !!(clip.facecam && clip.facecam.found && clip.srcWidth && clip.srcHeight);
    // Vertical sequences: blurred background when asked for, and also as the fallback when no facecam turned up.
    const useBlur = seq.facecam && !hasFacecam && !!(clip.srcWidth && clip.srcHeight);
    // Twitch's own captions along the bottom (vertical sequences): crop them off.
    const capCrop = seq.facecam && clip.captions && clip.captions.found ? 1 - clip.captions.topY : 0;

    let gameplaySource = projectItem;
    let gameplayAudioTrack = 0;
    // Both layers use the same project item. The gameplay layer's audio goes to A2 and is removed
    // after placing; if that ever can't be done, fall back to a separate video-only copy.
    const sharesFootage = (hasFacecam || useBlur) && !extraAudioRemovalBroken;
    if (sharesFootage) {
      gameplayAudioTrack = 1;
    } else if (hasFacecam || useBlur) {
      try {
        gameplaySource = await createVideoOnlyCopy(project, [sourceBin, root], projectItem, `${clipName} (video only)`);
      } catch (e) {
        log(`Couldn't make a video-only copy of ${clipName} (${e && e.message ? e.message : e}) — delete its gameplay audio on A2 by hand.`, "warn");
        gameplaySource = projectItem;
        gameplayAudioTrack = 1;
        flag("warn", "Extra audio on A2");
      }
    }

    E.layout = hasFacecam
      ? "Facecam"
      : useBlur
      ? "No facecam detected"
      : wantsFacecam
      ? "Full frame"
      : "Stringout";
    E.captions = !!capCrop;
    if (hasFacecam) {
      const fc = clip.facecam;
      if (typeof fc.confidence === "number" && fc.confidence < 0.75) {
        flag("warn", "Facecam unsure");
      }
      const guessed = fc.edges ? Object.values(fc.edges).filter((h) => h === "guess").length : 0;
      if (guessed >= 2) flag("warn", "Facecam edges guessed");
      if (capCrop && fc.y + fc.height > 1 - capCrop) flag("warn", "Facecam near captions");
    } else if (useBlur && !seq.blurBackground && clip.facecam && clip.facecam.reason && !/no face seen|no duration|no frames|full-screen camera|IRL camera/i.test(clip.facecam.reason)) {
      flag("warn", "Might have a facecam — check");
    }
    if (capCrop && clip.captions.frames < 3) flag("warn", "Caption crop unsure");
    if (wantsFacecam && !hasFacecam && !useBlur) flag("warn", "Left uncropped");

    const placing = hasFacecam
      ? " (facecam + gameplay)"
      : useBlur
      ? seq.blurBackground
        ? " (blurred background)"
        : " (no facecam found — blurred background)"
      : wantsFacecam
      ? " (no facecam found — full frame, flagged)"
      : "";
    log(`Placing ${clip.streamer || "clip"} at ${t.toFixed(1)}s${placing}${capCrop ? " — cropping out Twitch captions" : ""}…`);
    let gameplayItem, facecamItem;
    try {
      ({ gameplayItem, facecamItem } = await insertClips(
        project, sequence, gameplaySource, gameplayAudioTrack, hasFacecam || useBlur ? projectItem : null, t
      ));
    } catch (e) {
      log(`Failed to place ${clipName}: ${e.message}`, "err");
      flag("err", "Not placed");
      t += clip.durationSeconds || 0;
      continue;
    }
    if (sharesFootage) {
      let removed = false;
      try {
        removed = await removeExtraAudio(project, sequence, 1);
      } catch (e) {
        console.error("[clip-n-ship] removeExtraAudio threw:", e);
      }
      if (!removed) {
        extraAudioRemovalBroken = true;
        log(`Couldn't drop the gameplay layer's extra audio for ${clipName}; later clips will use a video-only copy instead.`, "warn");
        flag("warn", "Extra audio on A2");
      }
    }

    if (hasFacecam) {
      const layout = layoutFor(clip.srcWidth, clip.srcHeight, clip.facecam, seq);
      try {
        await applyFraming(project, facecamItem, facecamTransform(clip.srcWidth, clip.srcHeight, clip.facecam, layout.facecam), seq);
      } catch (e) {
        log(`Facecam framing failed for ${clipName} — left as default: ${e && e.message ? e.message : e}`, "warn");
        flag("err", "Facecam crop failed");
      }
      try {
        await applyFraming(project, gameplayItem, gameplayTransform(clip.srcWidth, clip.srcHeight, layout.gameplay, capCrop), seq);
      } catch (e) {
        log(`Gameplay framing failed for ${clipName} — left as default: ${e && e.message ? e.message : e}`, "warn");
        flag("err", "Gameplay crop failed");
      }
    } else if (useBlur) {
      // V1: the blurred copy filling the frame. V2: the sharp footage across the width, with the audio.
      try {
        await applyFraming(project, gameplayItem, blurBackgroundTransform(clip.srcWidth, clip.srcHeight, seq, capCrop), seq);
      } catch (e) {
        log(`Background framing failed for ${clipName} — left as default: ${e && e.message ? e.message : e}`, "warn");
        flag("err", "Background sizing failed");
      }
      try {
        await addGaussianBlur(project, gameplayItem, BLUR_AMOUNT);
      } catch (e) {
        log(`Couldn't blur the background for ${clipName} — add Gaussian Blur by hand: ${e && e.message ? e.message : e}`, "warn");
        flag("err", "Blur failed — add by hand");
      }
      try {
        await applyFraming(project, facecamItem, sharpOverBlurTransform(clip.srcWidth, clip.srcHeight, seq, capCrop), seq);
      } catch (e) {
        log(`Couldn't size ${clipName} to the frame — left as default: ${e && e.message ? e.message : e}`, "warn");
        flag("err", "Sharp footage sizing failed");
      }
    } else if (wantsFacecam) {
      try {
        project.lockedAccess(() => {
          project.executeTransaction((compound) => {
            compound.addAction(gameplayItem.createSetNameAction("REVIEW - " + clipName));
          }, "Clip-n-Ship: flag for review");
        });
      } catch (e) {
        // non-critical
      }
    } else if (clip.srcWidth && clip.srcHeight) {
      const fit = stringoutTransform(clip.srcWidth, clip.srcHeight, seq);
      if (Math.abs(fit.scale - 100) > 0.1) {
        try {
          await applyFraming(project, gameplayItem, fit, seq);
        } catch (e) {
          log(`Couldn't fit ${clipName} to the frame — left as default: ${e && e.message ? e.message : e}`, "warn");
          flag("err", "Fit failed");
        }
      }
    }

    if (clip.pill && clip.pill.failed) {
      flag("warn", "Pill failed");
    } else if (clip.pill) {
      const pillItem = findItemIn(pillItems, clip.pill.path);
      if (!pillItem) {
        log(`Couldn't find ${clip.pill.name}'s pill in the project to place it.`, "warn");
        flag("warn", "Pill not placed");
      } else {
        try {
          await placePill(project, sequence, pillItem, t, 2);
          E.pill = "/" + clip.pill.name;
          E.pillCount = 1;
        } catch (e) {
          log(`Couldn't place ${clip.pill.name}'s pill: ${e && e.message ? e.message : e}`, "warn");
          flag("warn", "Pill not placed");
        }
      }
    }
    // Pills for other streamers named in the clip go on the tracks above (V4, V5, …).
    let extraTrack = clip.pill ? 3 : 2;
    for (const extra of clip.extraPills || []) {
      const extraItem = findItemIn(pillItems, extra.path);
      if (!extraItem) {
        flag("warn", `${extra.name} pill not placed`);
        continue;
      }
      try {
        await placePill(project, sequence, extraItem, t, extraTrack++);
        E.pillCount = (E.pillCount || 0) + 1;
      } catch (e) {
        log(`Couldn't place ${extra.name}'s pill: ${e && e.message ? e.message : e}`, "warn");
        flag("warn", `${extra.name} pill not placed`);
      }
    }

    t += clip.durationSeconds || 0;
  }

  log(`Finished "${seq.name}".`, "ok");
  return finish();
}

// ---- end-of-run report ----

const reportEl = document.getElementById("report");
const ICON = { ok: "✅", warn: "⚠️", err: "❌" };
function worstLevel(flags) {
  return flags.some((f) => f.level === "err") ? "err" : flags.some((f) => f.level === "warn") ? "warn" : "ok";
}

function formatDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  if (m >= 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return m ? `${m}m ${total % 60}s` : `${total}s`;
}

// status: { running: { index, total, name, phase } } while working, { elapsedMs, stopped } when finished.
function renderReport(sections, status) {
  reportEl.textContent = "";
  const reportWidth = (document.body && document.body.clientWidth) || 380;
  for (const n of notices) reportEl.appendChild(el("div", "rep-line " + n.level, `${ICON[n.level]} ${n.text}`));
  if (status && status.running) {
    // The name of a long sequence breaks onto more lines after underscores.
    const r = status.running;
    reportEl.appendChild(el("div", "rep-title info", `⏳ Working on sequence ${r.index} of ${r.total}`));
    if (r.name) for (const line of wrapLines(r.name, charsAcross(reportWidth - 56, 12, 0.72))) reportEl.appendChild(el("div", "rep-title info", line));
    if (r.phase) reportEl.appendChild(el("div", "rep-title info", `— ${r.phase}`));
  }
  const panelWidth = (document.body && document.body.clientWidth) || 380;
  let clips = 0;
  let needLook = 0;
  let failed = 0;
  for (const sec of sections) {
    for (const c of sec.clips) {
      clips++;
      const level = worstLevel(c.flags);
      if (level === "err") failed++;
      else if (level === "warn") needLook++;
    }
  }
  const running = status && status.running;
  let summary = `${clips} clip${clips === 1 ? "" : "s"}` + (failed ? ` · ${failed} failed` : "") + (needLook ? ` · ${needLook} to check` : "") + (!failed && !needLook && !running ? " · all good" : "");
  if (running) summary += " so far";
  if (status && status.elapsedMs !== undefined) summary += ` · ${status.stopped ? "stopped after" : "took"} ${formatDuration(status.elapsedMs)}`;
  if (sections.length) reportEl.appendChild(el("div", "rep-title " + (failed ? "err" : needLook ? "warn" : "ok"), summary));
  reportEl.style.display = "block";

  for (const sec of sections) {
    const sectionLevel = worstLevel([...sec.clips.flatMap((c) => c.flags), ...(sec.flags || [])]);
    // Long sequence names break onto more lines at underscores.
    const lines = wrapLines(sec.name, charsAcross(panelWidth - 56, 12, 0.72));
    lines.forEach((line, i) => reportEl.appendChild(el("div", "rep-head", (i === 0 ? ICON[sectionLevel] + " " : "") + line)));
    if (sec.empty) {
      const bad = (sec.flags || []).length;
      reportEl.appendChild(el("div", "rep-line " + (bad ? "err" : "ok"), bad ? `${ICON.err} ${sec.flags[0].text}` : `${ICON.ok} Empty sequence created`));
    }
    for (const c of sec.clips) {
      const level = worstLevel(c.flags);
      const parts = [c.label];
      if (c.layout) parts.push(c.layout);
      if (c.captions) parts.push("✂️ Captions cropped");
      if (c.pillCount > 1) parts.push(`${c.pillCount} pills`);
      else if (c.pill || c.pillCount) parts.push("Pill");
      reportEl.appendChild(el("div", "rep-line " + level, `${ICON[level]} ${parts.join(" · ")}`));
      for (const f of c.flags) reportEl.appendChild(el("div", "rep-sub " + f.level, `${ICON[f.level]} ${f.text}`));
    }
  }
  reportEl.style.display = "block";
}

// ---- wiring ----

// ---- sequence cards ----

const cards = []; // one per sequence: { card, title, removeLink, nameInput, dim, chips, rowsEl, rows }

function renumberCards() {
  cards.forEach((c, i) => {
    if (!c.customName) setTitle(c, `Sequence ${i + 1}`);
    c.removeLink.style.display = cards.length > 1 ? "block" : "none";
    fitTitle(c);
  });
}

// Cuts text into lines of at most `maxChars`, breaking only right after an
// underscore or space (a single over-long piece is split as a last resort).
function wrapLines(text, maxChars) {
  const pieces = [];
  let cur = "";
  for (const ch of text) {
    cur += ch;
    if (ch === "_" || ch === " ") {
      pieces.push(cur);
      cur = "";
    }
  }
  if (cur) pieces.push(cur);
  const lines = [];
  let line = "";
  for (let piece of pieces) {
    while (piece.length > maxChars) {
      if (line) {
        lines.push(line);
        line = "";
      }
      lines.push(piece.slice(0, maxChars));
      piece = piece.slice(maxChars);
    }
    if (line && (line + piece).trimEnd().length > maxChars) {
      lines.push(line);
      line = "";
    }
    line += piece;
  }
  if (line) lines.push(line);
  return lines.map((l) => l.trimEnd());
}

// How many characters fit across `width` pixels at a given font size (a bold-text estimate).
function charsAcross(width, fontSize, factor = 0.62) {
  return Math.max(8, Math.floor(width / (fontSize * factor)));
}

// The title is the sequence's name. Long names go onto extra lines at underscores.
function renderTitle(c) {
  const panelWidth = (document.body && document.body.clientWidth) || 380;
  const room = panelWidth - 24 - 20 - 30 - (cards.length > 1 ? 66 : 0);
  const len = c.titleText.length;
  const size = len <= 22 ? 18 : len <= 44 ? 16 : 14;
  c.titleEl.textContent = "";
  const titleLines = wrapLines(c.titleText, charsAcross(room, size));
  if (titleLines.length <= 1) {
    // One plain piece of text: this form takes clicks everywhere on it.
    c.titleEl.textContent = titleLines[0] || "";
  } else {
    // A long name goes onto several lines, broken at underscores.
    for (const line of titleLines) {
      const lineEl = el("div", "head-title-line", line);
      onClick(lineEl, () => startRename(c));
      c.titleEl.appendChild(lineEl);
    }
  }
  c.titleEl.style.fontSize = size + "px";
  c.titleInput.style.fontSize = size + "px";
}

function fitTitle(c) {
  renderTitle(c);
}

function setTitle(c, text) {
  c.titleText = text;
  renderTitle(c);
}

function startRename(c) {
  if (c.renaming) return;
  c.titleEl.style.display = "none";
  c.editIcon.style.display = "none";
  c.titleInput.style.display = "block";
  c.titleInput.value = c.titleText;
  c.renaming = true;
  c.renameStartedAt = Date.now();
  // Focus again a moment later: clicking the title text can move focus right after
  // this handler runs, which would end the rename before it starts.
  const focusIt = () => {
    c.titleInput.focus();
    try {
      c.titleInput.select();
    } catch (e) {
      // selecting is only a convenience
    }
  };
  focusIt();
  setTimeout(focusIt, 0);
  setTimeout(focusIt, 120);
}

function commitRename(c) {
  if (!c.renaming) return;
  c.renaming = false;
  const value = c.titleInput.value.trim();
  c.titleInput.style.display = "none";
  c.titleEl.style.display = "block";
  c.editIcon.style.display = "block";
  if (value) {
    c.customName = true;
    setTitle(c, value);
  } else {
    c.customName = false; // blank goes back to "Sequence N"
    renumberCards();
  }
}

window.addEventListener("resize", () => cards.forEach(fitTitle));

function refreshRowRemoveButtons(c) {
  c.rows.forEach((r) => {
    r.removeBtn.style.display = c.rows.length > 1 ? "block" : "none";
  });
  // The "Add clip" button is as wide as the link boxes, which are narrower when the × buttons show.
  if (c.addClipBtn) c.addClipBtn.style.marginRight = c.rows.length > 1 ? "30px" : "0px";
}

function isLightColor(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return (r * 299 + g * 587 + b * 114) / 1000 >= 145;
}

// What a pasted link tells us about the streamer, before anything is downloaded.
function linkKind(link) {
  const twitch = link.match(/twitch\.tv\/([^\/?#]+)\/clip\//i);
  if (twitch) return { type: "twitch", login: twitch[1].toLowerCase() };
  if (/(?:x|twitter)\.com\/[^\/?#]+\/status\//i.test(link)) return { type: "x" };
  if (YOUTUBE_RE.test(link)) return { type: "youtube" };
  return { type: "other" };
}

// The pill choices that sit under each clip link. Off: a dotted "+ Add pill"
// button. On: a preview of the pill ("/streamer", in its color; click it to
// pick another color), an Ambassador checkbox, and Remove.
//
// The preview is drawn from small images (a round cap, a colored middle, a
// round cap) because Premiere's panel draws big CSS corner radii as angular
// hexagons rather than curves.
function pillImage(side, hex) {
  return iconImg(`icons/pills/${side}_${hex.slice(1).toUpperCase()}.png`, "pill-cap");
}

// A pill you type yourself, like the Pill Generator website: click the pill to
// type the name, a color circle next to it opens the color choices, then the
// Ambassador box. Used for X / YouTube clips (no Twitch streamer to read the
// name from) and on the Pill Generator tab.
//   opts.optional: starts as a dotted "+ Add pill" button, and × returns to it
//   opts.onRemove: × calls this instead (Pill Generator rows)
function buildManualPill(m, opts = {}) {
  m.pill = { on: !opts.optional, color: m.initialColor || lastPillColor, ambassador: false };
  m.streamerName = m.streamerName || "";
  const wrap = el("div", "pill-row");
  const addBtn = el("div", "pill-add");
  addBtn.appendChild(iconImg("icons/pills/add_dashed.png", "pill-add-bg"));
  addBtn.appendChild(el("div", "pill-add-label", "+ Add pill"));
  const removeBtn = el("div", "pill-x", "×");
  const chip = el("div", "pill-chip");
  const body = el("div", "pill-body");
  const edit = el("input", "pill-edit");
  edit.setAttribute("type", "text");
  edit.setAttribute("placeholder", "username");
  edit.style.display = "none";
  const circle = el("div", "swatch-circle");
  const ambassadorBox = el("div", "amb");
  const checkbox = el("input");
  checkbox.setAttribute("type", "checkbox");
  const ambassadorIcon = iconImg("icons/ambassador.png", "amb-icon");
  ambassadorBox.appendChild(checkbox);
  ambassadorBox.appendChild(ambassadorIcon);

  const palette = el("div", "palette");
  palette.style.display = "none";
  const swatchEls = [];
  for (let shade = 0; shade < 4; shade++) {
    const paletteRow = el("div", "palette-row");
    PILL_COLOR_FAMILIES.forEach((family) => {
      const color = family[shade];
      const swatchEl = el("div", "palette-swatch");
      swatchEl.style.background = color.hex;
      swatchEl.style.color = isLightColor(color.hex) ? "#18181b" : "#ffffff";
      onClick(swatchEl, () => {
        m.pill.color = color;
        lastPillColor = color;
        palette.style.display = "none";
        paint();
      });
      swatchEls.push([swatchEl, color]);
      paletteRow.appendChild(swatchEl);
    });
    palette.appendChild(paletteRow);
  }

  function paint() {
    const on = m.pill.on;
    const hex = m.pill.color.hex;
    addBtn.style.display = on ? "none" : "block";
    for (const node of [removeBtn, chip, circle, ambassadorBox]) node.style.display = on ? (node === removeBtn ? "block" : "flex") : "none";
    if (!on) palette.style.display = "none";
    chip.textContent = "";
    chip.appendChild(pillImage("l", hex));
    chip.appendChild(body);
    chip.appendChild(pillImage("r", hex));
    body.style.background = hex;
    body.style.color = isLightColor(hex) ? "#18181b" : "#ffffff";
    body.textContent = "/" + (m.streamerName || "username");
    circle.textContent = "";
    circle.appendChild(pillImage("l", hex));
    circle.appendChild(pillImage("r", hex));
    checkbox.checked = m.pill.ambassador;
    swatchEls.forEach(([swatchEl, color]) => {
      swatchEl.textContent = color.hex === hex ? "✓" : "";
    });
  }
  m.repaintPill = paint;

  let editing = false;
  let editStarted = 0;
  function startEdit() {
    if (editing) return;
    editing = true;
    editStarted = Date.now();
    chip.style.display = "none";
    edit.style.display = "block";
    edit.value = m.streamerName;
    const focusIt = () => edit.focus();
    focusIt();
    setTimeout(focusIt, 0);
    setTimeout(focusIt, 120);
  }
  function finishEdit() {
    if (!editing) return;
    editing = false;
    m.streamerName = edit.value.trim().replace(/^\/+/, "");
    edit.style.display = "none";
    chip.style.display = "flex";
    autoAmbassador(m, m.streamerName);
    paint();
    if (m.onNameChange) m.onNameChange();
  }
  m.commitEdit = finishEdit; // saves a name that's still being typed (Make Pills clicked straight from the box)
  edit.addEventListener("blur", () => {
    if (editing && Date.now() - editStarted < 250) return;
    finishEdit();
  });
  edit.addEventListener("keydown", (e) => {
    if (e.key === "Enter") finishEdit();
  });
  onClick(chip, startEdit);
  onClick(circle, () => {
    palette.style.display = palette.style.display === "none" ? "block" : "none";
  });
  onClick(addBtn, () => {
    m.pill.on = true;
    paint();
    startEdit();
  });
  onClick(removeBtn, () => {
    if (opts.onRemove) return opts.onRemove();
    m.pill.on = false;
    paint();
  });
  checkbox.addEventListener("change", () => {
    m.pill.ambassador = checkbox.checked;
    m.ambassadorTouched = true;
  });
  onClick(ambassadorIcon, () => {
    checkbox.checked = !checkbox.checked;
    m.pill.ambassador = checkbox.checked;
    m.ambassadorTouched = true;
  });

  wrap.appendChild(addBtn);
  wrap.appendChild(removeBtn);
  wrap.appendChild(chip);
  wrap.appendChild(edit);
  wrap.appendChild(circle);
  wrap.appendChild(ambassadorBox);
  m.pillControls = wrap;
  m.palette = palette;
  paint();
  return wrap;
}

function buildPillControls(entry) {
  entry.pill = { on: true, color: entry.initialColor || lastPillColor, ambassador: false };
  entry.streamerName = entry.streamerName || null;
  const wrap = el("div", "pill-row");
  entry.pillControls = wrap;

  // Off state
  const addBtn = el("div", "pill-add");
  addBtn.appendChild(iconImg("icons/pills/add_dashed.png", "pill-add-bg"));
  addBtn.appendChild(el("div", "pill-add-label", "+ Add pill"));

  // On state
  const chip = el("div", "pill-chip");
  const body = el("div", "pill-body");
  let leftCap = null;
  let rightCap = null;
  const ambassadorBox = el("div", "amb");
  const checkbox = el("input");
  checkbox.setAttribute("type", "checkbox");
  const ambassadorIcon = iconImg("icons/ambassador.png", "amb-icon");
  ambassadorBox.appendChild(checkbox);
  ambassadorBox.appendChild(ambassadorIcon);
  const removeBtn = el("div", "pill-x", "×");

  const palette = el("div", "palette");
  palette.style.display = "none";
  const swatchEls = [];
  for (let shade = 0; shade < 4; shade++) {
    const paletteRow = el("div", "palette-row");
    PILL_COLOR_FAMILIES.forEach((family) => {
      const color = family[shade];
      const swatchEl = el("div", "palette-swatch");
      swatchEl.style.background = color.hex;
      swatchEl.style.color = isLightColor(color.hex) ? "#18181b" : "#ffffff";
      onClick(swatchEl, () => {
        entry.pill.color = color;
        lastPillColor = color;
        palette.style.display = "none";
        paint();
      });
      swatchEls.push([swatchEl, color]);
      paletteRow.appendChild(swatchEl);
    });
    palette.appendChild(paletteRow);
  }

  function paintChip() {
    const hex = entry.pill.color.hex;
    const next = [pillImage("l", hex), pillImage("r", hex)];
    chip.textContent = "";
    chip.appendChild(next[0]);
    chip.appendChild(body);
    chip.appendChild(next[1]);
    leftCap = next[0];
    rightCap = next[1];
    body.style.background = hex;
    body.style.color = isLightColor(hex) ? "#18181b" : "#ffffff";
    body.textContent = "/" + (entry.streamerName || "streamer");
  }

  function paint() {
    const on = entry.pill.on;
    addBtn.style.display = on ? "none" : "block";
    chip.style.display = on ? "flex" : "none";
    ambassadorBox.style.display = on ? "flex" : "none";
    removeBtn.style.display = on ? "block" : "none";
    if (!on) palette.style.display = "none";
    paintChip();
    checkbox.checked = entry.pill.ambassador;
    swatchEls.forEach(([swatchEl, color]) => {
      swatchEl.textContent = color.hex === entry.pill.color.hex ? "✓" : "";
    });
  }
  entry.repaintPill = paint;

  onClick(addBtn, () => {
    entry.pill.on = true;
    paint();
    refreshPillRows();
  });
  onClick(removeBtn, () => {
    if (entry.onRemove) return entry.onRemove(); // extra pills just disappear
    entry.pill.on = false;
    entry.duplicate = false; // back to the "already has a pill" note for a repeat streamer
    paint();
    refreshPillRows();
  });
  onClick(chip, () => {
    palette.style.display = palette.style.display === "none" ? "block" : "none";
  });
  checkbox.addEventListener("change", () => {
    entry.pill.ambassador = checkbox.checked;
    entry.ambassadorTouched = true; // the user's choice wins over the automatic one
  });
  onClick(ambassadorIcon, () => {
    checkbox.checked = !checkbox.checked;
    entry.pill.ambassador = checkbox.checked;
    entry.ambassadorTouched = true;
  });

  wrap.appendChild(addBtn);
  wrap.appendChild(removeBtn);
  wrap.appendChild(chip);
  wrap.appendChild(ambassadorBox);
  entry.palette = palette;
  paint();
  return wrap;
}

// Right after a link is pasted: is it a real clip / a post with a video?
// The shape of the link is checked instantly; the helper then confirms with
// Twitch (fast) or, for Twitter posts, with a short background check that
// never blocks the panel. If the helper can't tell, the link is left alone.
const INVALID_LINK = "⚠️ Not a valid video link";
const urlChecks = new Map(); // link -> result from the helper
function showUrlNote(entry, text, level) {
  entry.urlNote.textContent = text;
  entry.urlNote.className = "url-note " + (level || "");
  entry.urlNote.style.display = text ? "block" : "none";
}

async function validateRow(entry) {
  const stamp = (entry.checkStamp = (entry.checkStamp || 0) + 1);
  const raw = entry.input.value.trim();
  if (!raw) return showUrlNote(entry, "");
  const links = splitLinks(entry.input.value);
  if (!links.length || links.some((l) => !isClipUrl(l))) {
    return showUrlNote(entry, INVALID_LINK, "err");
  }
  for (const link of links.slice(0, 3)) {
    let result = urlChecks.get(link);
    if (!result) {
      if (linkKind(link).type === "x") showUrlNote(entry, "Checking the post for video…", "info");
      if (linkKind(link).type === "youtube") showUrlNote(entry, "Checking the video…", "info");
      try {
        const res = await fetch(HELPER_BASE + "/check-url?url=" + encodeURIComponent(link));
        result = res.ok ? await res.json() : { ok: true, unchecked: true };
      } catch (e) {
        result = { ok: true, unchecked: true }; // helper not reachable: the shape check passed, so leave it
      }
      if (!result.unchecked) urlChecks.set(link, result);
      if (stamp !== entry.checkStamp) return; // the box changed while we were checking
    }
    if (!result.ok) return showUrlNote(entry, INVALID_LINK, "err");
  }
  showUrlNote(entry, "");
}

// Twitch Ambassadors (from the helper's list) get the Ambassador box ticked
// automatically; unticking it afterwards sticks.
let ambassadorSet = new Set();
let ambassadorsLoaded = false;
function autoAmbassador(entry, login) {
  if (!login || entry.ambassadorTouched || !entry.pill) return;
  if (ambassadorSet.has(String(login).toLowerCase()) && !entry.pill.ambassador) {
    entry.pill.ambassador = true;
    if (entry.repaintPill) entry.repaintPill();
  }
}
function applyAmbassadorsEverywhere() {
  for (const c of cards) {
    for (const r of c.rows) {
      const kind = linkKind(splitLinks(r.input.value)[0] || "");
      autoAmbassador(r, kind.login || r.streamerName);
      for (const x of r.extras) autoAmbassador(x, x.login);
      autoAmbassador(r.manual, r.manual.streamerName);
    }
  }
  for (const r of pillRows) autoAmbassador(r.entry, r.entry.streamerName);
}
async function loadAmbassadors() {
  if (ambassadorsLoaded) return;
  try {
    const res = await fetch(HELPER_BASE + "/ambassadors");
    if (!res.ok) return;
    ambassadorSet = new Set(((await res.json()).logins || []).map((l) => l.toLowerCase()));
    ambassadorsLoaded = true;
    applyAmbassadorsEverywhere();
  } catch (e) {
    // the helper isn't up yet; try again on the next status check
  }
}

// Looks up the streamer for the first link in a row and shows it in the pill
// preview: the name from the link right away, then the properly cased one from
// the helper a moment later. The helper also reports other streamers the clip
// names (an @mention in its title), which get their own pills below.
const streamerNames = new Map(); // link -> { name, others }
function applyPeople(entry, link, data) {
  if ((splitLinks(entry.input.value)[0] || "") !== link) return;
  if (data.name) {
    entry.streamerName = data.name;
    autoAmbassador(entry, data.name);
    if (entry.repaintPill) entry.repaintPill();
  }
  setExtraPills(entry, link, data.others || []);
}

function updateStreamerName(entry) {
  const link = splitLinks(entry.input.value)[0] || "";
  const kind = linkKind(link);
  const known = streamerNames.get(link);
  entry.streamerName = (known && known.name) || (kind.type === "twitch" ? kind.login : null);
  if (kind.type === "twitch") autoAmbassador(entry, kind.login);
  if (entry.repaintPill) entry.repaintPill();
  if (!link || kind.type === "x" || !isClipUrl(link)) {
    setExtraPills(entry, link, []);
    return;
  }
  if (known) return applyPeople(entry, link, known);
  fetch(HELPER_BASE + "/streamer?url=" + encodeURIComponent(link))
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => {
      if (!data || !data.name) return;
      streamerNames.set(link, data);
      applyPeople(entry, link, data);
    })
    .catch(() => {
      // the helper is down or offline; the name from the link stays
    });
}

// Is this streamer already getting a pill from some other row?
function pillClaimedElsewhere(login, exceptEntry) {
  const key = String(login).toLowerCase();
  return cards.some((c) =>
    c.rows.some((r) => {
      if (r === exceptEntry) return false;
      const kind = linkKind(splitLinks(r.input.value)[0] || "");
      if (kind.type === "twitch" && kind.login === key && r.pill.on) return true;
      return r.extras.some((x) => x.login === key);
    })
  );
}

// Extra pills for other streamers named in the clip: one preview pill each,
// same color as the clip's own pill, each removable with its ×.
function setExtraPills(entry, link, others) {
  if (entry.extrasFor === link && entry.extras.length) return; // already set up for this link
  for (const x of entry.extras) {
    entry.block.removeChild(x.pillControls);
    entry.block.removeChild(x.palette);
  }
  entry.extras = [];
  entry.extrasFor = link;
  for (const other of others) {
    if (pillClaimedElsewhere(other.login, entry)) continue;
    const extra = { pill: null, login: other.login.toLowerCase(), streamerName: other.name, initialColor: entry.pill.color };
    extra.onRemove = () => {
      entry.block.removeChild(extra.pillControls);
      entry.block.removeChild(extra.palette);
      entry.extras.splice(entry.extras.indexOf(extra), 1);
      entry.extrasLabel.style.display = entry.extras.length ? "block" : "none";
    };
    buildPillControls(extra);
    autoAmbassador(extra, extra.login);
    entry.block.appendChild(extra.pillControls);
    entry.block.appendChild(extra.palette);
    entry.extras.push(extra);
  }
  entry.extrasLabel.style.display = entry.extras.length ? "block" : "none";
  // Keep the label above the extras.
  if (entry.extras.length) entry.block.insertBefore(entry.extrasLabel, entry.extras[0].pillControls);
}

// Notes and visibility under each row, in run order: the first row for a
// streamer with its pill on makes the pill. Later rows for the same streamer
// show a short note with an "add pill" link, which asks for a second pill.
// (The helper enforces the same rule.)
function refreshPillRows() {
  const claimed = new Map(); // login -> { where, name }
  cards.forEach((c, ci) => {
    c.rows.forEach((r, ri) => {
      const kind = linkKind(splitLinks(r.input.value)[0] || "");
      let note = "";
      let offerAdd = false;
      let controls = true;
      const manualKind = kind.type === "x" || kind.type === "youtube";
      if (manualKind) {
        controls = false;
        if (kind.type === "youtube") {
          const minutes = parseFloat(String(r.minutesInput.value).replace(/\u00A0/g, ""));
          if (!(minutes > 0)) note = "Enter how many minutes of the video to use.";
          else if (minutes > MAX_YOUTUBE_MINUTES) note = `⚠️ ${minutes} minutes is over the ${MAX_YOUTUBE_MINUTES}-minute limit. The length is in minutes.`;
        }
      } else if (kind.type === "twitch") {
        if (claimed.has(kind.login) && !r.duplicate) {
          const first = claimed.get(kind.login);
          note = `${first.name} Pill ✅ (${first.where})`;
          offerAdd = true;
          controls = false;
        } else if (r.pill.on && !r.duplicate) {
          claimed.set(kind.login, { where: `Sequence ${ci + 1} clip ${ri + 1}`, name: r.streamerName || kind.login });
        }
      }
      const hasClip = splitLinks(r.input.value).some(isClipUrl);
      if (!hasClip) controls = false;
      // A hand-made pill for X / YouTube clips; YouTube also asks for a start time and length.
      r.manual.pillControls.style.display = manualKind && hasClip ? "flex" : "none";
      if (!(manualKind && hasClip)) r.manual.palette.style.display = "none";
      r.ytRow.style.display = kind.type === "youtube" && hasClip ? "flex" : "none";
      r.pillControls.style.display = controls ? "flex" : "none";
      if (!controls) r.palette.style.display = "none";
      r.noteText.textContent = note;
      r.noteLink.style.display = offerAdd ? "block" : "none";
      r.note.style.display = note ? "flex" : "none";
      r.addDuplicate = () => {
        r.duplicate = true;
        r.pill.on = true;
        if (r.repaintPill) r.repaintPill();
        refreshPillRows();
      };
    });
  });
}

function addClipRow(c) {
  const block = el("div", "clip-block");
  const row = el("div", "clip-row");
  const input = textInput("Paste url (Twitch, YT, X)");
  const removeBtn = el("div", "chip x", "×");
  // A sequence's extra clips start with the first clip's pill color.
  const entry = { block, row, input, removeBtn, extras: [], extrasFor: null, duplicate: false, initialColor: c.rows.length ? c.rows[0].pill.color : null };
  onClick(removeBtn, () => {
    c.rowsEl.removeChild(block);
    c.rows.splice(c.rows.indexOf(entry), 1);
    refreshRowRemoveButtons(c);
    refreshPillRows();
  });
  const onLinkChanged = () => {
    refreshPillRows();
    updateStreamerName(entry);
    clearTimeout(entry.checkTimer);
    entry.checkTimer = setTimeout(() => validateRow(entry), 350);
  };
  input.addEventListener("input", onLinkChanged);
  input.addEventListener("change", onLinkChanged);
  row.appendChild(boxed(input));
  row.appendChild(removeBtn);
  block.appendChild(row);

  // YouTube links are long videos: where to start and how much to take.
  entry.ytRow = el("div", "clip-row yt-row");
  entry.startInput = textInput("Start time (e.g. 12:30)");
  entry.minutesInput = textInput("Length in minutes");
  const startBox = boxed(entry.startInput);
  const minutesBox = boxed(entry.minutesInput);
  minutesBox.style.marginLeft = "5px";
  entry.ytRow.appendChild(startBox);
  entry.ytRow.appendChild(minutesBox);
  entry.ytRow.style.display = "none";
  for (const inp of [entry.startInput, entry.minutesInput]) inp.addEventListener("input", () => refreshPillRows());
  block.appendChild(entry.ytRow);

  block.appendChild(buildPillControls(entry));
  block.appendChild(entry.palette);
  // X / YouTube clips have no Twitch streamer to read a name from: a pill can be added by hand.
  entry.manual = { initialColor: entry.initialColor };
  buildManualPill(entry.manual, { optional: true });
  block.appendChild(entry.manual.pillControls);
  block.appendChild(entry.manual.palette);
  entry.note = el("div", "pill-note note-row");
  entry.noteText = el("div", "note-text");
  entry.noteLink = el("div", "text-link", "add pill");
  onClick(entry.noteLink, () => entry.addDuplicate && entry.addDuplicate());
  entry.note.appendChild(entry.noteText);
  entry.note.appendChild(entry.noteLink);
  entry.note.style.display = "none";
  block.appendChild(entry.note);
  entry.extrasLabel = el("div", "pill-note", "Also in this clip:");
  entry.extrasLabel.style.display = "none";
  block.appendChild(entry.extrasLabel);
  entry.urlNote = el("div", "url-note");
  entry.urlNote.style.display = "none";
  block.insertBefore(entry.urlNote, entry.pillControls);
  c.rows.push(entry);
  c.rowsEl.appendChild(block);
  refreshRowRemoveButtons(c);
  refreshPillRows();
}

function refreshCardNote(c) {
  c.note.textContent = c.dim.facecam ? "" : "Plain stringout — clips back to back, no facecam split.";
  c.note.style.display = c.note.textContent ? "block" : "none";
}

function addSequenceCard() {
  const c = { dim: DIMENSIONS[0], chips: [], rows: [], titleText: "", customName: false, renaming: false };
  c.card = el("div", "card");

  // Header: the sequence's name (click to rename) and its size, on a lighter band.
  const head = el("div", "card-head");
  const top = el("div", "head-top");
  const titleWrap = el("div", "head-title-wrap");
  c.titleEl = el("div", "head-title");
  onClick(c.titleEl, () => startRename(c));
  c.editIcon = iconImg("icons/edit.png", "edit-icon");
  c.titleInput = el("input", "title-input");
  c.titleInput.setAttribute("type", "text");
  c.titleInput.style.display = "none";
  onClick(c.editIcon, () => startRename(c));
  c.startRenameFromTitle = () => startRename(c);
  c.titleInput.addEventListener("blur", () => {
    // A blur in the first instant is the click that opened the box, not the user finishing.
    if (c.renaming && Date.now() - c.renameStartedAt < 250) return;
    commitRename(c);
  });
  c.titleInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") commitRename(c);
    if (e.key === "Escape") {
      c.titleInput.value = c.titleText;
      commitRename(c);
    }
  });
  c.titleWrap = titleWrap;
  titleWrap.appendChild(c.titleEl);
  titleWrap.appendChild(c.editIcon);
  onClick(titleWrap, () => startRename(c)); // the whole title area, in case a click lands on a line of text
  titleWrap.appendChild(c.titleInput);
  c.removeLink = el("div", "link", "Remove");
  onClick(c.removeLink, () => removeCard(c));
  top.appendChild(titleWrap);
  top.appendChild(c.removeLink);
  head.appendChild(top);

  // Size buttons show an aspect-ratio icon; hovering swaps it for the name (9x16, 4x5, ...).
  const chipsEl = el("div", "chips");
  const paintSizeChips = () => {
    c.chips.forEach((chip, j) => {
      const on = DIMENSIONS[j] === c.dim;
      chip.className = on ? "chip size on" : "chip size";
      chip.iconEl.setAttribute("src", sizeIconSrc(DIMENSIONS[j].icon, on ? "p" : "w"));
    });
  };
  DIMENSIONS.forEach((dim) => {
    const chip = el("div", "chip size");
    chip.iconEl = iconImg(sizeIconSrc(dim.icon, "w"), "size-icon");
    chip.iconEl.style.width = dim.iw + "px";
    chip.iconEl.style.height = dim.ih + "px";
    chip.labelEl = el("div", "size-label", dim.label);
    chip.labelEl.style.display = "none";
    chip.appendChild(chip.iconEl);
    chip.appendChild(chip.labelEl);
    onClick(chip, () => {
      c.dim = dim;
      paintSizeChips();
      refreshCardNote(c);
    });
    chip.addEventListener("mouseenter", () => {
      chip.iconEl.style.display = "none";
      chip.labelEl.style.display = "block";
    });
    chip.addEventListener("mouseleave", () => {
      chip.iconEl.style.display = "block";
      chip.labelEl.style.display = "none";
    });
    c.chips.push(chip);
    chipsEl.appendChild(chip);
  });
  head.appendChild(chipsEl);
  paintSizeChips();
  c.note = el("div", "note");
  head.appendChild(c.note);
  refreshCardNote(c);
  c.card.appendChild(head);

  // Body: the clips.
  const body = el("div", "card-body");
  c.rowsEl = el("div");
  body.appendChild(c.rowsEl);
  addClipRow(c);

  const addClipBtn = el("div", "btn ghost");
  c.addClipBtn = addClipBtn;
  addClipBtn.appendChild(iconImg("icons/clip.png"));
  addClipBtn.appendChild(el("div", "btn-label", "Add clip to this sequence"));
  onClick(addClipBtn, () => addClipRow(c));
  const addClipRowEl = el("div", "btn-row"); // keeps the button as wide as its contents
  addClipRowEl.appendChild(addClipBtn);
  body.appendChild(addClipRowEl);
  c.card.appendChild(body);
  refreshRowRemoveButtons(c);

  cards.push(c);
  sequencesEl.appendChild(c.card);
  renumberCards();
  refreshPillRows(); // now that this card is registered, hide its empty pill preview
}

function removeCard(c) {
  if (cards.length <= 1) return;
  sequencesEl.removeChild(c.card);
  cards.splice(cards.indexOf(c), 1);
  renumberCards();
  refreshPillRows();
}

// "1:23:45", "12:30" or "90" (seconds) -> seconds; blank means the start.
function parseTimecode(text) {
  const t = String(text || "").replace(/\u00A0/g, "").trim();
  if (!t) return 0;
  const parts = t.split(":").map((x) => parseFloat(x));
  if (parts.some((n) => !Number.isFinite(n) || n < 0) || parts.length > 3) return 0;
  return parts.reduce((total, n) => total * 60 + n, 0);
}

function collectSequences() {
  return cards.map((c) => ({
    _card: c,
    blank: c.rows.every((r) => !r.input.value.trim()),
    touched: c.customName && c.dim !== DIMENSIONS[0], // a title and a changed ratio
    name: c.titleText,
    width: c.dim.width,
    height: c.dim.height,
    facecam: c.dim.facecam,
    clips: c.rows.flatMap((r) =>
      splitLinks(r.input.value).map((url) => ({
        url,
        start: parseTimecode(r.startInput.value),
        minutes: parseFloat(String(r.minutesInput.value).replace(/\u00A0/g, "").trim()) || 0,
        pill: ["x", "youtube"].includes(linkKind(url).type)
          ? {
              enabled: r.manual.pill.on && !!r.manual.streamerName,
              name: r.manual.streamerName,
              colorHex: r.manual.pill.color.hex,
              colorName: r.manual.pill.color.name,
              ambassador: r.manual.pill.ambassador,
              duplicate: true,
            }
          : {
          enabled: r.pill.on,
          colorHex: r.pill.color.hex,
          colorName: r.pill.color.name,
          ambassador: r.pill.ambassador,
          duplicate: !!r.duplicate,
        },
        extraPills: r.extras
          .filter((x) => x.pill.on && x.streamerName)
          .map((x) => ({ name: x.streamerName, colorHex: x.pill.color.hex, colorName: x.pill.color.name, ambassador: x.pill.ambassador })),
      }))
    ),
  }));
}

// ---- wiring ----

// A text spinner inside the Set Up Project button while a run is going.
const SPIN_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
let spinnerTimer = null;
let spinnerNote = "";
function startSpinner() {
  let i = 0;
  setupBtn._enabled = false;
  setupBtn.className = "btn primary busy";
  setupBtn.textContent = `${SPIN_FRAMES[0]}  Setting up…${spinnerNote}`;
  clearInterval(spinnerTimer);
  spinnerTimer = setInterval(() => {
    i = (i + 1) % SPIN_FRAMES.length;
    setupBtn.textContent = `${SPIN_FRAMES[i]}  Setting up…${spinnerNote}`;
  }, 90);
}
function stopSpinner() {
  clearInterval(spinnerTimer);
  setupBtn.className = "btn primary";
  setupBtn.textContent = "Set Up Project";
  setEnabled(setupBtn, true);
}

async function onSetupClick() {
  startSpinner();
  logLines = [];
  const startedAt = Date.now();
  let reportSections = [];
  notices.length = 0;
  reportEl.style.display = "none";
  try {
    const { helperUp, helperStale, project } = await refreshStatus();
    if (!helperUp) {
      log('Helper is not running. Double-click "Start Clip-n-Ship Helper.command" and try again.', "err");
      return;
    }
    if (helperStale) {
      log('The helper is running old code. Close its Terminal window, double-click "Start Clip-n-Ship Helper.command" again, then retry.', "err");
      return;
    }
    if (!project) {
      log("Open a Premiere project first.", "err");
      return;
    }

    // A YouTube length that's missing or over 5 minutes is almost surely a typo (the box is in
    // minutes), so warn instead of starting any download.
    const lengthProblems = [];
    for (const seq of collectSequences()) {
      for (const c of seq.clips) {
        if (linkKind(c.url).type !== "youtube") continue;
        if (!(c.minutes > 0)) lengthProblems.push(`A YouTube clip in "${seq.name}" has no length. Enter how many minutes to use.`);
        else if (c.minutes > MAX_YOUTUBE_MINUTES) {
          lengthProblems.push(`A YouTube clip in "${seq.name}" is set to ${c.minutes} minutes, over the ${MAX_YOUTUBE_MINUTES}-minute limit. The length box is in minutes, so check it.`);
        }
      }
    }
    if (lengthProblems.length) {
      for (const text of lengthProblems) log(text, "warn", true);
      log("Nothing was started. Fix the length and run it again.", "warn", true);
      return;
    }

    // Keep only real clip links; skip (and say so) anything else.
    const plan = [];
    for (const seq of collectSequences()) {
      // A sequence with no clips: kept as an empty sequence if it was given a title and a different
      // ratio; otherwise it's just removed.
      if (seq.blank) {
        if (seq.touched) plan.push({ ...seq, clips: [], emptyOnly: true });
        else if (cards.length > 1) removeCard(seq._card);
        continue;
      }
      const clips = seq.clips.filter((c) => isClipUrl(c.url));
      const skipped = seq.clips.filter((c) => !isClipUrl(c.url)).map((c) => c.url);
      if (skipped.length) {
        log(`"${seq.name}": skipping ${skipped.length} link(s) that aren't Twitch clip or X post links: ${skipped.slice(0, 3).join("  ")}${skipped.length > 3 ? " …" : ""}`, "warn");
      }
      if (!clips.length) {
        log(`"${seq.name}" has no valid clip links, so it's being skipped.`, "warn");
        continue;
      }
      plan.push({ ...seq, clips });
    }
    if (!plan.length) {
      log("Paste at least one Twitch clip or X post link first (twitch.tv/<channel>/clip/<name> or x.com/<user>/status/<id>).", "err");
      return;
    }

    const projectDir = dirname(project.path);
    stopRequested = false;
    setEnabled(stopBtn, true);

    // Streamers who already got a pill in an earlier sequence: one pill per streamer, first sequence wins.
    extraAudioRemovalBroken = false;
    reportSections = [];
    // Numbering for "<Streamer> <n>" names: from the project when adding to it, fresh when clearing.
    let nameCounts = clearMode ? {} : await countExistingClips(project);
    reportEl.style.display = "none";
    const pilledLogins = [];
    const showWorking = (i, name, phase) => {
      spinnerNote = plan.length > 1 ? ` (${i}/${plan.length})` : "";
      renderReport(reportSections, { running: { index: i, total: plan.length, name, phase } });
    };
    // "Clear entire project first": empty the Premiere project now, and the helper
    // empties the clip and pill folders on disk before it downloads anything.
    const clearFirst = clearMode;
    let clearFoldersPending = clearFirst; // the first real job empties the clip and pill folders on disk
    if (clearFirst) {
      log("Clearing the project…");
      await clearProject(project);
    }
    for (let i = 0; i < plan.length; i++) {
      const seq = plan[i];
      if (plan.length > 1) log(`— Sequence ${i + 1} of ${plan.length}: "${seq.name}" (${seq.width}×${seq.height}) —`);
      showWorking(i + 1, seq.name, seq.emptyOnly ? "creating the empty sequence" : "downloading and checking clips");
      if (seq.emptyOnly) {
        log(`Creating empty sequence "${seq.name}"…`);
        const flags = [];
        try {
          await buildSequence(project, seq);
        } catch (e) {
          flags.push({ level: "err", text: "Couldn't create it" });
        }
        reportSections.push({ name: seq.name, width: seq.width, height: seq.height, clips: [], empty: true, flags });
        renderReport(reportSections);
        continue;
      }
      log(`Sending ${seq.clips.length} link(s) to the helper…`);
      activeJobId = await startJob(seq.clips, projectDir, seq.facecam && !seq.blurBackground, pilledLogins, clearFoldersPending, seq.facecam, nameCounts);
      clearFoldersPending = false;
      const manifest = await pollJob(activeJobId, (line) => log(line));
      if (!manifest) {
        log("Stopped.", "warn", true);
        return;
      }
      if (manifest.nameCounts) nameCounts = manifest.nameCounts; // the next sequence carries on from here
      for (const clip of manifest.clips) {
        if (clip.pill && !clip.pill.failed && clip.pill.login) pilledLogins.push(clip.pill.login);
        for (const extra of clip.extraPills || []) if (extra.login) pilledLogins.push(extra.login);
      }
      showWorking(i + 1, seq.name, "building it in Premiere");
      const clipReports = await buildProject(project, manifest, seq, false);
      reportSections.push({ name: seq.name, width: seq.width, height: seq.height, clips: clipReports || [] });
      renderReport(reportSections);
      if (stopRequested) return;
    }
    log(`Done in ${formatDuration(Date.now() - startedAt)}. Take a look and nudge any crops that need it.`, "ok");
  } catch (e) {
    log("Error: " + e.message, "err");
  } finally {
    // Final readout: the results so far, and how long it all took.
    if (reportSections.length) renderReport(reportSections, { elapsedMs: Date.now() - startedAt, stopped: stopRequested });
    else if (notices.length) renderReport([], {});
    spinnerNote = "";
    activeJobId = null;
    setEnabled(stopBtn, false);
    stopSpinner();
  }
}

// ---- footer: Made by space150 | Health Check | Report an Issue ----

onClick(document.getElementById("footSpace"), async () => {
  try {
    await fetch(HELPER_BASE + "/open?target=space150", { method: "POST" }); // the helper opens it in the browser
  } catch (e) {
    try {
      require("uxp").shell.openExternal("https://www.space150.com/", "Open space150.com in your browser");
    } catch (e2) {
      console.warn("couldn't open the link", e2);
    }
  }
});
onClick(document.getElementById("footHealth"), () => setView("health"));
onClick(document.getElementById("footReport"), () => setView("report"));
onClick(document.getElementById("healthBack"), () => setView("setup"));
onClick(document.getElementById("reportBack"), () => setView("setup"));
onClick(document.getElementById("healthRun"), () => runHealthCheck());

// Health check: tests the Premiere-side pieces here and the helper-side pieces over there.
let lastHealth = [];
async function runHealthCheck() {
  const rowsEl = document.getElementById("healthRows");
  rowsEl.textContent = "";
  rowsEl.appendChild(el("div", "note", "Checking…"));
  const rows = [];
  const add = (level, label, detail) => rows.push({ level, label, detail });

  add("ok", "Premiere", premiereVersion ? `version ${premiereVersion}` : "version not reported");
  let project = null;
  try {
    project = await ppro.Project.getActiveProject();
  } catch (e) {
    // handled below
  }
  add(project ? "ok" : "warn", "Project", project ? `"${project.name}" is open` : "no project is open");

  const test = async (label, fn) => {
    try {
      const detail = await fn();
      add("ok", label, detail || "working");
    } catch (e) {
      add("err", label, (e && e.message ? e.message : String(e)).slice(0, 120));
    }
  };
  await test("Gaussian Blur effect", async () => {
    for (const name of BLUR_MATCH_NAMES) {
      try {
        if (await ppro.VideoFilterFactory.createComponent(name)) return "available (" + name + ")";
      } catch (e) {
        // try the next name
      }
    }
    throw new Error("Premiere didn't offer a Gaussian Blur effect");
  });
  await test("Audio removal tools", async () => {
    if (typeof ppro.TrackItemSelection.createEmptySelection !== "function") throw new Error("createEmptySelection is missing");
    if (typeof ppro.SequenceEditor.getEditor !== "function") throw new Error("SequenceEditor is missing");
  });
  await test("Project folders & imports", async () => {
    if (typeof ppro.FolderItem.cast !== "function") throw new Error("FolderItem.cast is missing");
    if (!project || typeof project.importFiles !== "function") throw new Error("importFiles is missing");
  });
  await test("Media Encoder queue", async () => {
    const encoder = ppro.EncoderManager.getManager();
    if (ppro.Constants.ExportType.QUEUE_TO_AME === undefined) throw new Error("the queue option is missing");
    return encoder.isAMEInstalled ? "Media Encoder is installed" : "Media Encoder is NOT installed";
  });
  await test("Sequence frame rate", async () => {
    const fps = await currentSequenceFps();
    if (!fps) throw new Error("couldn't read it (is a sequence open?)");
    return `${fps.toFixed(2)} fps`;
  });
  await test("Position, Scale and Crop settings", async () => {
    const sequence = project && (await project.getActiveSequence());
    if (!sequence) return "skipped (no sequence open)";
    const track = await sequence.getVideoTrack(0);
    const item = track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false)[0];
    if (!item) return "skipped (no clip on V1 to look at)";
    const motion = await findMotionComponent(item);
    if (!motion) throw new Error("couldn't find the Motion effect");
    const { posParam, scaleParam, crop } = findParamsOnMotion(motion);
    if (!posParam || !scaleParam || !crop.left || !crop.top || !crop.right || !crop.bottom) throw new Error("some Motion settings weren't found");
  });

  // The helper's own checks.
  try {
    const res = await fetch(HELPER_BASE + "/health");
    const data = await res.json();
    for (const r of data.rows) add(r.level, r.label, r.detail);
  } catch (e) {
    add("err", "Helper", 'not reachable — double-click "Start Clip-n-Ship Helper.command"');
  }

  lastHealth = rows;
  rowsEl.textContent = "";
  for (const r of rows) {
    const row = el("div", "health-row " + r.level);
    row.appendChild(el("span", "health-label", `${ICON[r.level]} ${r.label}: `));
    row.appendChild(el("span", "health-detail", r.detail));
    rowsEl.appendChild(row);
  }
}

// Report an issue: goes through the helper to the Pill Generator's report service, which files a GitHub issue.
const reportTypes = [["Something's broken", "bug"], ["An idea or request", "idea"], ["A question", "question"]];
let reportType = "bug";
const reportTypeChips = reportTypes.map(([label, value]) => {
  const chip = el("div", value === reportType ? "chip on" : "chip", label);
  onClick(chip, () => {
    reportType = value;
    reportTypeChips.forEach((c, i) => {
      c.className = reportTypes[i][1] === value ? "chip on" : "chip";
    });
  });
  document.getElementById("reportType").appendChild(chip);
  return chip;
});
const reportTitleInput = textInput("Short title");
document.getElementById("reportTitleBox").appendChild(boxed(reportTitleInput));
const reportNameInput = textInput("Your name (optional)");
document.getElementById("reportNameBox").appendChild(boxed(reportNameInput));
const reportTextEl = document.getElementById("reportText");
const reportIncludeEl = document.getElementById("reportInclude");
onClick(document.getElementById("reportIncludeText"), () => {
  reportIncludeEl.checked = !reportIncludeEl.checked;
});
const reportStatusEl = document.getElementById("reportStatus");
function reportStatus(text, level) {
  reportStatusEl.textContent = "";
  reportStatusEl.appendChild(el("div", "rep-line " + (level || "info"), text));
  reportStatusEl.style.display = "block";
}
onClick(document.getElementById("reportSend"), async () => {
  const sendBtn = document.getElementById("reportSend");
  const title = reportTitleInput.value.trim();
  const text = reportTextEl.value.trim();
  if (!title || !text) return reportStatus("Please add a title and say what happened.", "warn");
  setEnabled(sendBtn, false);
  try {
    let description = text;
    if (reportIncludeEl.checked) {
      const lastRun = reportEl.textContent ? reportEl.textContent.trim().slice(0, 1500) : "(no run yet)";
      const health = lastHealth.length ? lastHealth.map((r) => `${r.level.toUpperCase()} ${r.label}: ${r.detail}`).join("\n") : "(health check not run)";
      description += `\n\n--- Last run's results ---\n${lastRun}\n\n--- Last health check ---\n${health}\n\n--- Recent activity ---\n${logLines.slice(-25).join("\n")}`;
    }
    const res = await fetch(HELPER_BASE + "/send-report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: reportType,
        title,
        description,
        name: reportNameInput.value.trim(),
        diagnostics: { app: "Clip-n-Shipper " + BUILD, premiere: premiereVersion || "unknown", panelWidth: String((document.body && document.body.clientWidth) || "") },
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "The report couldn't be sent");
    reportStatus("✅ Sent. Thank you!", "ok");
    reportTitleInput.value = "";
    reportTextEl.value = "";
  } catch (e) {
    reportStatus("❌ " + (e && e.message ? e.message : e), "err");
  } finally {
    setEnabled(sendBtn, true);
  }
});

onClick(setupBtn, () => {
  onSetupClick().catch((e) => {
    console.error("[clip-n-ship] onSetupClick rejected:", e);
    log("Unhandled error: " + (e && e.message ? e.message : String(e)), "err");
    stopSpinner();
  });
});
onClick(stopBtn, onStopClick);
addSeqBtn.appendChild(iconImg("icons/sequence.png"));
addSeqBtn.appendChild(el("div", "btn-label", "Add new sequence"));
onClick(addSeqBtn, addSequenceCard);
// "Add to current project" (default) or "Clear entire project first": two buttons, one always selected.
let clearMode = false;
const modeAddBtn = el("div", "chip", "Add to Project");
const modeClearBtn = el("div", "chip", "Clear Project");
function setClearMode(clear) {
  clearMode = clear;
  modeAddBtn.className = clear ? "chip" : "chip on";
  modeClearBtn.className = clear ? "chip on" : "chip";
}
onClick(modeAddBtn, () => setClearMode(false));
onClick(modeClearBtn, () => setClearMode(true));
document.getElementById("modeRow").appendChild(modeAddBtn);
document.getElementById("modeRow").appendChild(modeClearBtn);
setClearMode(false);

// Queue sequences to Media Encoder, each pointed at the project's "05 Renders"
// folder and using the standard H.264 preset ("Match Source - High bitrate").
// By default only the current sequence is queued; the ▾ button lists every
// sequence in the project to tick. Media Encoder is left to start the renders.
const queueBtn = document.getElementById("queueBtn");
const queueArrow = document.getElementById("queueArrow");
const queueList = document.getElementById("queueList");
let queueSelected = new Set(); // sequence names ticked in the list
let queueTouched = false; // the user has ticked/unticked something
let queueListOpen = false;

function fileSafe(name) {
  return String(name).replace(/[\/\\?%*:|"<>]/g, "-").trim() || "Sequence";
}

async function currentSequenceNames() {
  const project = await ppro.Project.getActiveProject();
  if (!project) return null;
  const sequences = await project.getSequences();
  let active = null;
  try {
    active = await project.getActiveSequence();
  } catch (e) {
    // no active sequence
  }
  return { project, sequences, activeName: active ? active.name : null };
}

async function refreshQueueList() {
  const info = await currentSequenceNames();
  queueList.textContent = "";
  if (!info || !info.sequences.length) {
    queueList.appendChild(el("div", "queue-empty", "No sequences in this project."));
    return;
  }
  const names = info.sequences.map((q) => q.name);
  if (!queueTouched) queueSelected = new Set(info.activeName ? [info.activeName] : names.slice(0, 1));
  queueSelected = new Set([...queueSelected].filter((n) => names.includes(n)));
  for (const name of names) {
    const row = el("div", "queue-row-item");
    const box = el("input");
    box.setAttribute("type", "checkbox");
    box.checked = queueSelected.has(name);
    const label = el("div", "queue-name", name + (name === info.activeName ? "  (current)" : ""));
    const toggle = (on) => {
      queueTouched = true;
      if (on) queueSelected.add(name);
      else queueSelected.delete(name);
    };
    box.addEventListener("change", () => toggle(box.checked));
    onClick(label, () => {
      box.checked = !box.checked;
      toggle(box.checked);
    });
    row.appendChild(box);
    row.appendChild(label);
    queueList.appendChild(row);
  }
}

onClick(queueArrow, async () => {
  queueListOpen = !queueListOpen;
  queueList.style.display = queueListOpen ? "block" : "none";
  queueArrow.textContent = queueListOpen ? "▴" : "▾";
  if (queueListOpen) {
    try {
      await refreshQueueList();
    } catch (e) {
      log("Couldn't list the sequences: " + (e && e.message ? e.message : e), "err");
    }
  }
});

const queueStatusEl = document.getElementById("queueStatus");
const queueLines = [];
function say(text, level) {
  queueLines.push([text, level || "info"]);
  queueStatusEl.textContent = "";
  for (const [t, l] of queueLines) queueStatusEl.appendChild(el("div", "rep-line " + (l === "warn" ? "warn" : l === "err" ? "err" : l === "ok" ? "ok" : "info"), t));
  queueStatusEl.style.display = "block";
}

onClick(queueBtn, async () => {
  queueLines.length = 0;
  setEnabled(queueBtn, false);
  try {
    const ping = await pingHelper();
    if (!ping) {
      say('Helper is not running — double-click "Start Clip-n-Ship Helper.command" first.', "err");
      return;
    }
    const info = await currentSequenceNames();
    if (!info) {
      say("Open a Premiere project first.", "err");
      return;
    }
    if (!info.sequences.length) {
      say("This project has no sequences to render.", "warn");
      return;
    }
    // The ticked sequences; if the list was never opened, just the current one.
    let chosen;
    if (queueTouched || queueListOpen) {
      chosen = info.sequences.filter((q) => queueSelected.has(q.name));
    } else {
      chosen = info.sequences.filter((q) => q.name === info.activeName);
      if (!chosen.length) chosen = info.sequences.slice(0, 1);
    }
    if (!chosen.length) {
      say("No sequences are ticked. Open the ▾ list and tick the ones to render.", "warn");
      return;
    }
    const res = await fetch(HELPER_BASE + "/render-info?projectDir=" + encodeURIComponent(dirname(info.project.path)));
    const render = await res.json();
    if (!render.preset) {
      say("Couldn't find Premiere's H.264 preset (Match Source - High bitrate) on this Mac.", "err");
      return;
    }
    const encoder = ppro.EncoderManager.getManager();
    if (!encoder.isAMEInstalled) {
      say("Adobe Media Encoder isn't installed.", "err");
      return;
    }
    say(`Queueing ${chosen.length} sequence(s) to Media Encoder → ${render.rendersDir}`);
    let queued = 0;
    for (const sequence of chosen) {
      const outFile = joinPath(render.rendersDir, `${fileSafe(sequence.name)}.mp4`);
      try {
        const ok = await encoder.exportSequence(sequence, ppro.Constants.ExportType.QUEUE_TO_AME, outFile, render.preset, true);
        if (ok === false || ok === undefined) {
          say(`"${sequence.name}": Media Encoder didn't confirm it queued it. Check Media Encoder's queue.`, "warn");
        } else {
          queued++;
          say(`"${sequence.name}" queued → 05 Renders/${fileSafe(sequence.name)}.mp4`, "ok");
        }
      } catch (e) {
        say(`"${sequence.name}" couldn't be queued: ${e && e.message ? e.message : e}`, "err");
      }
    }
    say(queued ? "Open Media Encoder and press Start when you're ready to render." : "Nothing was queued.", queued ? "ok" : "err");
    queueTouched = false; // next time, the current sequence is the default again
    if (queueListOpen) await refreshQueueList();
  } catch (e) {
    say("Couldn't queue to Media Encoder: " + (e && e.message ? e.message : e), "err");
  } finally {
    setEnabled(queueBtn, true);
  }
});

// ---- Pill Generator view ----
// The same options as the Pill Generator website (name, color, Ambassador, size,
// frame rate, file type). The helper makes the pills through the hosted service
// and they're imported straight into the project's "02 Pills" bin, so there's no
// need to visit the site. Handy when a clip needs more pills than it has clips.

const setupView = document.getElementById("setupView");
const pillsView = document.getElementById("pillsView");
const lockupTitle = document.getElementById("lockupTitle");
const tabSetup = document.getElementById("tabSetup");
const tabPills = document.getElementById("tabPills");

// The current sequence's frame rate, so new pills can match it. Premiere hands back a
// FrameRate whose `value` is frames per second (older/other builds may give ticks per
// frame or seconds per frame, so all three are understood).
async function currentSequenceFps() {
  try {
    const project = await ppro.Project.getActiveProject();
    if (!project) return null;
    const sequence = await project.getActiveSequence();
    if (!sequence) return null;
    const settings = await sequence.getSettings();
    const rate = await settings.getVideoFrameRate();
    let value = Number(rate && (rate.value !== undefined ? rate.value : rate));
    if (rate && typeof rate.getFramesPerSecond === "function") value = Number(await rate.getFramesPerSecond());
    console.log("[clip-n-ship] sequence frame rate raw value:", rate && rate.value, "->", value);
    if (!Number.isFinite(value) || value <= 0) return null;
    if (value > 1000) value = 254016000000 / value; // ticks per frame
    else if (value < 1) value = 1 / value; // seconds per frame
    return value;
  } catch (e) {
    console.warn("[clip-n-ship] couldn't read the sequence frame rate:", e);
    return null;
  }
}

const PILL_FPS_CHOICES = [23.976, 30, 60];
async function suggestPillFps() {
  const fps = await currentSequenceFps();
  const hint = document.getElementById("pillFpsHint");
  if (!fps) {
    hint.textContent = "";
    return;
  }
  const best = PILL_FPS_CHOICES.reduce((a, b) => (Math.abs(b - fps) < Math.abs(a - fps) ? b : a), 30);
  pillOptions.fps = best;
  pillFpsChips.forEach((chip) => {
    chip.className = chip._value === best ? "chip on" : "chip";
  });
  const shown = Math.abs(fps - Math.round(fps)) < 0.005 ? String(Math.round(fps)) : fps.toFixed(2);
  hint.textContent = `Your current sequence is ${shown} fps, so ${best === 23.976 ? "23.98" : best} is selected.`;
}

const healthView = document.getElementById("healthView");
const reportView = document.getElementById("reportView");
const VIEW_TITLES = { setup: ["CLIP-N-SHIP", "PER"], pills: ["PILL", "GENERATOR"], health: ["HEALTH", "CHECK"], report: ["REPORT", "AN ISSUE"] };
function setView(view) {
  const [first, second] = VIEW_TITLES[view] || VIEW_TITLES.setup;
  // The big title follows the view: Clip-n-Shipper, Pill Generator, Health Check, Report an Issue.
  lockupTitle.textContent = first;
  const accent = el("span", "lockup-setup", second);
  if (first !== "CLIP-N-SHIP") accent.style.marginLeft = "10px";
  lockupTitle.appendChild(accent);
  setupView.style.display = view === "setup" ? "block" : "none";
  pillsView.style.display = view === "pills" ? "block" : "none";
  healthView.style.display = view === "health" ? "block" : "none";
  reportView.style.display = view === "report" ? "block" : "none";
  tabSetup.className = view === "setup" ? "tab on" : "tab";
  tabPills.className = view === "pills" ? "tab on" : "tab";
  if (view === "pills") suggestPillFps();
  if (view === "health") runHealthCheck();
}
onClick(tabSetup, () => setView("setup"));
onClick(tabPills, () => setView("pills"));

// The panel's ☰ menu offers the same two views.
try {
  require("uxp").entrypoints.setup({
    panels: {
      clipnship: {
        show() {},
        invokeMenu(id) {
          setView(id === "viewPills" ? "pills" : "setup");
        },
      },
    },
  });
} catch (e) {
  console.warn("[clip-n-ship] couldn't register the panel menu:", e);
}

const pillRows = []; // { entry, rowEl }
const pillOptions = { scale: 0.3, fps: 30, fileType: "mov" };
const pillRowsEl = document.getElementById("pillGenRows");
const pillStatusEl = document.getElementById("pillGenStatus");

function pillStatus(lines) {
  pillStatusEl.textContent = "";
  for (const [text, level] of lines) pillStatusEl.appendChild(el("div", "rep-line " + (level || ""), text));
  pillStatusEl.style.display = lines.length ? "block" : "none";
}

function addPillGenRow() {
  const wrap = el("div", "clip-block");
  const entry = { streamerName: "", initialColor: pillRows.length ? pillRows[pillRows.length - 1].entry.pill.color : null };
  buildManualPill(entry, { onRemove: () => pillGenRowsRemove(wrap, entry) });
  wrap.appendChild(entry.pillControls);
  wrap.appendChild(entry.palette);
  pillRowsEl.appendChild(wrap);
  pillRows.push({ entry, rowEl: wrap });
}

function pillGenRowsRemove(wrap, entry) {
  pillRowsEl.removeChild(wrap);
  const i = pillRows.findIndex((r) => r.entry === entry);
  if (i >= 0) pillRows.splice(i, 1);
  if (!pillRows.length) addPillGenRow();
}

// A row of exclusive choices (size / frame rate / file type), styled like the size buttons.
function buildChoiceRow(containerId, choices, current, onPick) {
  const holder = document.getElementById(containerId);
  const chips = choices.map(([label, value]) => {
    const chip = el("div", "chip", label);
    chip._value = value;
    onClick(chip, () => {
      onPick(value);
      chips.forEach((c) => {
        c.className = c._value === value ? "chip on" : "chip";
      });
    });
    chip.className = value === current ? "chip on" : "chip";
    holder.appendChild(chip);
    return chip;
  });
  return chips;
}
buildChoiceRow("pillSize", [["30%", 0.3], ["35%", 0.35], ["50%", 0.5], ["100%", 1]], pillOptions.scale, (v) => (pillOptions.scale = v));
const pillFpsChips = buildChoiceRow("pillFps", [["23.98", 23.976], ["30", 30], ["60", 60]], pillOptions.fps, (v) => (pillOptions.fps = v));
buildChoiceRow("pillType", [[".mov", "mov"], [".gif", "gif"]], pillOptions.fileType, (v) => (pillOptions.fileType = v));

const pillMakeBtn = document.getElementById("pillMakeBtn");
onClick(pillMakeBtn, async () => {
  setEnabled(pillMakeBtn, false);
  try {
    for (const r of pillRows) if (r.entry.commitEdit) r.entry.commitEdit();
    const wanted = pillRows
      .map((r) => r.entry)
      .filter((e) => e.streamerName)
      .map((e) => ({ name: e.streamerName, colorHex: e.pill.color.hex, colorName: e.pill.color.name, ambassador: e.pill.ambassador }));
    if (!wanted.length) return pillStatus([["Type at least one streamer name first.", "warn"]]);
    const ping = await pingHelper();
    if (!ping) return pillStatus([['The helper is not running. Double-click "Start Clip-n-Ship Helper.command" first.', "err"]]);
    const project = await ppro.Project.getActiveProject();
    if (!project) return pillStatus([["Open a Premiere project first.", "err"]]);

    pillStatus([[`Making ${wanted.length} pill${wanted.length === 1 ? "" : "s"}… (about 20 seconds each)`, "info"]]);
    const res = await fetch(HELPER_BASE + "/make-pills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectDir: dirname(project.path), pills: wanted, ...pillOptions }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "The helper turned the request down");
    const manifest = await pollJob(data.jobId, (line) => pillStatus([[line, "info"]]));
    if (!manifest) return pillStatus([["Stopped.", "warn"]]);

    const made = manifest.pills.filter((p) => !p.failed);
    const lines = manifest.pills.filter((p) => p.failed).map((p) => [`❌ /${p.name} — failed`, "err"]);
    if (made.length) {
      const bins = await ensureFolders(project, Object.values(manifest.folders));
      const pillsBin = bins[manifest.folders.pills];
      const have = (await pillsBin.getItems()).map((i) => i.name);
      const fresh = made.filter((p) => !have.some((n) => n === basename(p.path) || n === basename(p.path).replace(/\.[^.]+$/, "")));
      if (fresh.length) await project.importFiles(fresh.map((p) => p.path), true, pillsBin, false);
      for (const p of made) lines.unshift([`✅ /${p.name} — in 02 Pills`, "ok"]);
    }
    pillStatus(lines);
  } catch (e) {
    pillStatus([["Couldn't make the pills: " + (e && e.message ? e.message : e), "err"]]);
  } finally {
    setEnabled(pillMakeBtn, true);
  }
});
onClick(document.getElementById("pillAddRow"), addPillGenRow);
addPillGenRow();

// Reset: back to a fresh panel, as if just opened.
const resetBtn = document.getElementById("resetBtn");
onClick(resetBtn, () => {
  if (activeJobId) {
    log("A run is in progress — press Stop first, then Reset.", "warn");
    return;
  }
  cards.forEach((c) => sequencesEl.removeChild(c.card));
  cards.length = 0;
  lastPillColor = PILL_COLOR_FAMILIES[2][1];
  setClearMode(false);
  stopRequested = false;
  logLines = [];
  notices.length = 0;
  reportEl.style.display = "none";
  reportEl.textContent = "";
  addSequenceCard();
  refreshStatus().catch(() => {});
});

setEnabled(stopBtn, false);
addSequenceCard();
refreshStatus();
// Keep the status line current on its own (helper started late, project opened later).
setInterval(() => {
  if (activeJobId) return; // a run is in progress and logging its own progress
  refreshStatus().catch(() => {});
  loadAmbassadors();
}, 4000);
loadAmbassadors();
