// Test the manual perspective sampler. Args: file, then 8 numbers = 4 corners
// (x y x y x y x y) in WORK-space (image scaled to 900 wide). With no corners,
// just writes a coordinate-gridded image so corners can be read off.
import fs from "node:fs";
import jpeg from "jpeg-js";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const cv = require("../opencv.js");
await new Promise((r) => { cv.onRuntimeInitialized = r; });
const RD = require("../detector.js");

const FILE = process.argv[2] || "test3.jpg";
const WORK = 900;
const img0 = jpeg.decode(fs.readFileSync(new URL("../" + FILE, import.meta.url)), { useTArray: true });
const scale = WORK / img0.width;
const W = Math.round(img0.width * scale), H = Math.round(img0.height * scale);
const big = cv.matFromImageData({ data: img0.data, width: img0.width, height: img0.height });
const work = new cv.Mat(); cv.resize(big, work, new cv.Size(W, H), 0, 0, cv.INTER_AREA);

const nums = process.argv.slice(3).map(Number);
const o = new Uint8Array(W * H * 4);
for (let i = 0; i < W * H * 4; i++) o[i] = work.data[i];
function p(x, y, c, a = 1) { x |= 0; y |= 0; if (x < 0 || y < 0 || x >= W || y >= H) return; const i = (y * W + x) * 4; o[i] = o[i] * (1 - a) + c[0] * a; o[i + 1] = o[i + 1] * (1 - a) + c[1] * a; o[i + 2] = o[i + 2] * (1 - a) + c[2] * a; o[i + 3] = 255; }

if (nums.length >= 8) {
  // scale corners to full-res and sample
  const inv = 1 / scale;
  const corners = [];
  for (let i = 0; i < 8; i += 2) corners.push({ x: nums[i] * inv, y: nums[i + 1] * inv });
  const face = RD.sampleQuad(cv, big, corners);
  console.log("FACE:");
  for (let i = 0; i < 9; i += 3) console.log("  " + face.cells.slice(i, i + 3).map(c => c.code).join(" "));
  // draw quad + perspective grid (corners ordered TL,TR,BR,BL)
  const c = face.corners.map(pt => ({ x: pt.x * scale, y: pt.y * scale }));
  const line = (a, b, col) => { const dx = Math.abs(b.x - a.x), dy = Math.abs(b.y - a.y), sx = a.x < b.x ? 1 : -1, sy = a.y < b.y ? 1 : -1; let e = dx - dy, x = a.x, y = a.y; for (; ;) { p(x, y, col); if (Math.abs(x - b.x) < 1 && Math.abs(y - b.y) < 1) break; const e2 = 2 * e; if (e2 > -dy) { e -= dy; x += sx; } if (e2 < dx) { e += dx; y += sy; } } };
  const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  for (let i = 0; i <= 3; i++) { const t = i / 3; line(lerp(c[0], c[1], t), lerp(c[3], c[2], t), [0, 255, 0]); line(lerp(c[0], c[3], t), lerp(c[1], c[2], t), [0, 255, 0]); }
} else {
  // coordinate grid every 50px with labels-ish ticks
  for (let x = 0; x < W; x += 50) for (let y = 0; y < H; y++) p(x, y, [255, 255, 0], x % 100 === 0 ? 0.7 : 0.3);
  for (let y = 0; y < H; y += 50) for (let x = 0; x < W; x++) p(x, y, [255, 255, 0], y % 100 === 0 ? 0.7 : 0.3);
  console.log(`gridded ${W}x${H}; lines every 50px (brighter every 100px)`);
}
fs.writeFileSync(new URL("../tmp/quad.jpg", import.meta.url), jpeg.encode({ data: o, width: W, height: H }, 92).data);
