// Run the EXACT shared detector (detector.js) on any image in Node, draw the
// result, print the face. Same code path as the browser — only the image
// decode differs. Usage: node test/detect.mjs <file.jpg|file.png>
import fs from "node:fs";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const cv = require("../opencv.js");
await new Promise((r) => { cv.onRuntimeInitialized = r; });
const RubikDetector = require("../detector.js");

const FILE = process.argv[2] || "sample.jpg";
const buf = fs.readFileSync(new URL("../" + FILE, import.meta.url));
const lower = FILE.toLowerCase();
let img;
if (lower.endsWith(".png")) {
  img = PNG.sync.read(buf);
  // pngjs gives RGBA; jpeg-js gives RGBA. Both are fine for matFromImageData.
} else {
  img = jpeg.decode(buf, { useTArray: true });
}
const W = img.width, H = img.height;
const src = cv.matFromImageData({ data: img.data, width: W, height: H });

let result = RubikDetector.detectCube(cv, src);

// Fallback for 3-face angled cubes: the sticker-grid path produces a
// degenerate quad (PCA axes from a mixed-color multi-face cluster don't align
// with any single face's perspective, and the 4-corner extrapolation
// overshoots the actual cluster bbox). The geometric silhouette path with the
// ONNX model mask is the right tool. Trigger when the detected grid's bbox is
// significantly larger than the cluster's bbox — i.e. the fit extrapolated
// past the real cube silhouette (ratio > 1.5).
let gridExtrap = false;
if (result && result.corners && result.cluster && result.cluster.length > 4) {
  let cMinX = 1e9, cMinY = 1e9, cMaxX = -1e9, cMaxY = -1e9;
  for (const a of result.cluster) { cMinX = Math.min(cMinX, a.rect.x); cMinY = Math.min(cMinY, a.rect.y); cMaxX = Math.max(cMaxX, a.rect.x + a.rect.width); cMaxY = Math.max(cMaxY, a.rect.y + a.rect.height); }
  let gMinX = 1e9, gMinY = 1e9, gMaxX = -1e9, gMaxY = -1e9;
  for (const c of result.corners) { gMinX = Math.min(gMinX, c.x); gMinY = Math.min(gMinY, c.y); gMaxX = Math.max(gMaxX, c.x); gMaxY = Math.max(gMaxY, c.y); }
  const clusterArea = Math.max(1, (cMaxX - cMinX) * (cMaxY - cMinY));
  const gridArea = (gMaxX - gMinX) * (gMaxY - gMinY);
  gridExtrap = gridArea / clusterArea > 1.5;
}
if (result && gridExtrap) {
  const modelPath = new URL("../u2netp.onnx", import.meta.url);
  if (fs.existsSync(modelPath)) {
    try {
      const ort = require("onnxruntime-node");
      const sess = await ort.InferenceSession.create(modelPath.pathname);
      const rs = new cv.Mat(); cv.resize(src, rs, new cv.Size(320, 320), 0, 0, cv.INTER_AREA);
      const rgb = new cv.Mat(); cv.cvtColor(rs, rgb, cv.COLOR_RGBA2RGB);
      const d = rgb.data;
      const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
      const inp = new Float32Array(3 * 320 * 320);
      for (let i = 0; i < 320 * 320; i++) for (let c = 0; c < 3; c++) inp[c * 320 * 320 + i] = ((d[i * 3 + c] / 255) - mean[c]) / std[c];
      const out = await sess.run({ [sess.inputNames[0]]: new ort.Tensor("float32", inp, [1, 3, 320, 320]) });
      const sal = out[sess.outputNames[0]].data;
      let mn = 1e9, mx = -1e9; for (const v of sal) { if (v < mn) mn = v; if (v > mx) mx = v; }
      const m320 = new cv.Mat(320, 320, cv.CV_8U);
      for (let i = 0; i < 320 * 320; i++) m320.data[i] = ((sal[i] - mn) / (mx - mn)) > 0.5 ? 255 : 0;
      const cubeMask = new cv.Mat(); cv.resize(m320, cubeMask, new cv.Size(W, H), 0, 0, cv.INTER_NEAREST);
      rs.delete(); rgb.delete(); m320.delete();
      const faces = RubikDetector.detectFacesGeometric(cv, src, { cubeMask });
      cubeMask.delete();
      if (faces.length) {
        const f = faces[0];
        result = {
          face: f.face, region: null, confident: true,
          method: `auto(${f.method})`,
          cluster: f.corners.map((c) => ({ rect: { x: c.x - 2, y: c.y - 2, width: 4, height: 4 } })),
          stickerCount: 9, squareCount: 9,
          workSize: { w: W, h: H },
          corners: f.corners,
        };
      }
    } catch (e) { console.error("geometric fallback failed:", e.message); }
  }
}

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
