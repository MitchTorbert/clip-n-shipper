// Checks the Mac/Windows differences without needing a Windows machine.
// Run:  node installer/test-platform.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");
const platform = require("../server/platform");

let passed = 0;
const check = (name, fn) => {
  fn();
  passed++;
  console.log("ok  -", name);
};

// --- the panel's path helpers, pulled straight out of the panel's source
const src = fs.readFileSync(path.join(__dirname, "..", "uxp-panel", "index.js"), "utf8");
const grab = (start) => {
  const i = src.indexOf(start);
  let depth = 0;
  for (let j = src.indexOf("{", i); j < src.length; j++) {
    if (src[j] === "{") depth++;
    if (src[j] === "}" && --depth === 0) return src.slice(i, j + 1);
  }
};
const ctx = {};
vm.createContext(ctx);
vm.runInContext([grab("function lastSeparator"), grab("function dirname"), grab("function basename"), grab("function joinPath")].join("\n"), ctx);

check("panel: Windows project path -> folder", () => assert.strictEqual(ctx.dirname("C:\\Users\\Ed\\My Videos\\Weekly.prproj"), "C:\\Users\\Ed\\My Videos"));
check("panel: Windows clip path -> file name", () => assert.strictEqual(ctx.basename("C:\\Users\\Ed\\My Videos\\01 Source Footage\\Cinna 1.mp4"), "Cinna 1.mp4"));
check("panel: Mac paths still work", () => {
  assert.strictEqual(ctx.dirname("/Users/ed/Weekly.prproj"), "/Users/ed");
  assert.strictEqual(ctx.basename("/Users/ed/01 Source Footage/Cinna 1.mp4"), "Cinna 1.mp4");
});
check("panel: joinPath keeps each system's separator", () => {
  assert.strictEqual(ctx.joinPath("C:\\Users\\Ed\\05 Renders", "Round 1.mp4"), "C:\\Users\\Ed\\05 Renders\\Round 1.mp4");
  assert.strictEqual(ctx.joinPath("C:\\Users\\Ed\\05 Renders\\", "Round 1.mp4"), "C:\\Users\\Ed\\05 Renders\\Round 1.mp4");
  assert.strictEqual(ctx.joinPath("/Users/ed/05 Renders", "Round 1.mp4"), "/Users/ed/05 Renders/Round 1.mp4");
});

// --- tools and PATH
check("tools: Windows looks for .exe files", () => assert.deepStrictEqual(platform.exeNames("yt-dlp", "win32"), ["yt-dlp.exe", "yt-dlp"]));
check("tools: Mac uses the plain name", () => assert.deepStrictEqual(platform.exeNames("yt-dlp", "darwin"), ["yt-dlp"]));
check("PATH: Windows splits on ; and accepts 'Path'", () => assert.deepStrictEqual(platform.pathDirs({ Path: "C:\\a;C:\\b" }, "win32"), ["C:\\a", "C:\\b"]));
check("PATH: Mac splits on :", () => assert.deepStrictEqual(platform.pathDirs({ PATH: "/a:/b" }, "darwin"), ["/a", "/b"]));

// --- opening links
check("links: Windows opens with the default browser handler", () => {
  let call;
  platform.openLink("https://example.com/", "win32", (bin, args) => (call = [bin, args]));
  assert.deepStrictEqual(call, ["rundll32", ["url.dll,FileProtocolHandler", "https://example.com/"]]);
});
check("links: Mac uses open", () => {
  let call;
  platform.openLink("https://example.com/", "darwin", (bin, args) => (call = [bin, args]));
  assert.deepStrictEqual(call, ["open", ["https://example.com/"]]);
});

// --- finding Premiere's H.264 preset on a pretend Windows machine
check("preset: finds the newest Premiere on Windows", () => {
  const tree = new Set([
    "D:\\Programs\\Adobe\\Adobe Premiere Pro 2025\\MediaIO\\systempresets\\4E49434B_48323634\\00 - Match Source - High bitrate.epr",
    "D:\\Programs\\Adobe\\Adobe Premiere Pro 2026\\MediaIO\\systempresets\\4E49434B_48323634\\00 - Match Source - High bitrate.epr",
  ]);
  const found = platform.findH264Preset({
    platform: "win32",
    env: { ProgramFiles: "D:\\Programs" },
    list: () => ["Adobe Premiere Pro 2025", "Adobe Media Encoder 2026", "Adobe Premiere Pro 2026", "Common"],
    exists: (f) => tree.has(f),
  });
  assert.strictEqual(found, "D:\\Programs\\Adobe\\Adobe Premiere Pro 2026\\MediaIO\\systempresets\\4E49434B_48323634\\00 - Match Source - High bitrate.epr");
});
check("preset: falls back to Media Encoder on Windows", () => {
  const f = "C:\\Program Files\\Adobe\\Adobe Media Encoder 2026\\MediaIO\\systempresets\\4E49434B_48323634\\00 - Match Source - High bitrate.epr";
  assert.strictEqual(platform.findH264Preset({ platform: "win32", env: {}, list: () => ["Adobe Media Encoder 2026"], exists: (x) => x === f }), f);
});
check("preset: nothing installed -> null, no crash", () => {
  assert.strictEqual(platform.findH264Preset({ platform: "win32", env: {}, list: () => { throw new Error("no such folder"); }, exists: () => false }), null);
});
check("preset: this Mac's real Premiere is still found", () => {
  if (process.platform !== "darwin") return;
  assert.ok(platform.findH264Preset(), "expected the Mac preset to be found");
});

// --- the helper's own tool lookup still works here
check("tools: ffmpeg / ffprobe / yt-dlp still resolve on this machine", () => {
  const t = require("../server/tools").checkAllTools();
  assert.ok(t.ffmpeg && t.ffprobe && t.ytDlp, JSON.stringify(t));
});

console.log(`\n${passed} checks passed`);
