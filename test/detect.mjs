// Run the EXACT shared detector (detector.js) on any image in Node, draw the
// result, print the face. Same code path as the browser — only the image
// decode differs. Usage: node test/detect.mjs <file.jpg>
import fs from "node:fs";
import jpeg from "jpeg-js";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const cv = require("../opencv.js");
await new Promise((r) => { cv.onRuntimeInitialized = r; });
const RubikDetector = require("../detector.js");

const FILE = process.argv[2] || "sample.jpg";
const img = jpeg.decode(fs.readFileSync(new URL("../" + FILE, import.meta.url)), { useTArray: true });
const W = img.width, H = img.height;
const src = cv.matFromImageData({ data: img.data, width: W, height: H });

const result = RubikDetector.detectCube(cv, src);
src.delete();

const regionInfo = result.region
  ? `region ${result.region.w | 0}x${result.region.h | 0} @(${result.region.x | 0},${result.region.y | 0})`
  : `corners: ${result.corners ? result.corners.map((c) => `(${c.x | 0},${c.y | 0})`).join(" ") : "none"}`;
console.log(`${FILE} @${W}x${H}  work=${result.workSize.w}x${result.workSize.h}  method=${result.method}  squares=${result.squareCount}  faceStickers=${result.stickerCount}`);
console.log(regionInfo);
for (let i = 0; i < 9; i += 3) console.log("  " + result.face.cells.slice(i, i + 3).map((c) => c.code).join(" "));

// draw overlay on the full-res image
const out = new Uint8Array(img.data);
function p(x, y, c) { x = x | 0; y = y | 0; if (x < 0 || y < 0 || x >= W || y >= H) return; const i = (y * W + x) * 4; out[i] = c[0]; out[i + 1] = c[1]; out[i + 2] = c[2]; out[i + 3] = 255; }
function line(x0, y0, x1, y1, c) {
  const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  const steps = Math.max(dx, dy);
  for (let i = 0; i <= steps; i++) {
    const t = steps === 0 ? 0 : i / steps;
    p(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, c);
  }
}
function box(r, c) { for (let t = 0; t < 3; t++) { for (let x = r.x | 0; x < r.x + r.width; x++) { p(x, (r.y + t) | 0, c); p(x, (r.y + r.height - t) | 0, c); } for (let y = r.y | 0; y < r.y + r.height; y++) { p((r.x + t) | 0, y, c); p((r.x + r.width - t) | 0, y, c); } } }
for (const a of result.cluster) box(a.rect, [255, 0, 255]);

if (result.corners) {
  // Draw perspective quad overlay
  const c = result.corners;
  for (let i = 0; i < 4; i++) {
    const a = c[i], b = c[(i + 1) % 4];
    line(a.x, a.y, b.x, b.y, [0, 255, 0]);
  }
  // Draw internal grid lines
  const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  for (let i = 1; i < 3; i++) {
    const t = i / 3;
    const top = lerp(c[0], c[1], t), bot = lerp(c[3], c[2], t);
    line(top.x, top.y, bot.x, bot.y, [0, 200, 0]);
    const left = lerp(c[0], c[3], t), right = lerp(c[1], c[2], t);
    line(left.x, left.y, right.x, right.y, [0, 200, 0]);
  }
} else if (result.region) {
  // Draw axis-aligned grid overlay
  const rg = result.region, cw = rg.w / 3, ch = rg.h / 3;
  for (let i = 0; i <= 3; i++) { for (let y = rg.y | 0; y < rg.y + rg.h; y++) p((rg.x + cw * i) | 0, y, [0, 255, 0]); for (let x = rg.x | 0; x < rg.x + rg.w; x++) p(x, (rg.y + ch * i) | 0, [0, 255, 0]); }
}

fs.writeFileSync(new URL("../tmp/detect.jpg", import.meta.url), jpeg.encode({ data: out, width: W, height: H }, 92).data);
console.log("wrote tmp/detect.jpg");
