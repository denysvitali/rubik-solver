// Explore a robust face locator: detect ALL vivid square stickers, cluster,
// fit a 3x3 grid. Iterate here (node) before porting to detector.js.
import fs from "node:fs";
import jpeg from "jpeg-js";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const cv = require("../opencv.js");
await new Promise((r) => { cv.onRuntimeInitialized = r; });

const FILE = process.argv[2] || "sample.jpg";
const WORK = 600;
const img0 = jpeg.decode(fs.readFileSync(new URL("../" + FILE, import.meta.url)), { useTArray: true });
const scale = WORK / img0.width;
const W = Math.round(img0.width * scale), H = Math.round(img0.height * scale);
const big = cv.matFromImageData({ data: img0.data, width: img0.width, height: img0.height });
const src = new cv.Mat(); cv.resize(big, src, new cv.Size(W, H), 0, 0, cv.INTER_AREA); big.delete();
const imgArea = W * H, data = src.data;

// vivid square stickers (any hue)
const rgb = new cv.Mat(); cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
const hsv = new cv.Mat(); cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
const lo = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [0, 90, 60, 0]);
const hi = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [180, 255, 255, 0]);
const mask = new cv.Mat(); cv.inRange(hsv, lo, hi, mask);
const k = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
cv.morphologyEx(mask, mask, cv.MORPH_OPEN, k);
cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, k);

const cnts = new cv.MatVector(); const hier = new cv.Mat();
cv.findContours(mask, cnts, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
let st = [];
for (let i = 0; i < cnts.size(); i++) {
  const c = cnts.get(i); const area = cv.contourArea(c); const r = cv.boundingRect(c);
  const ar = r.width / r.height, fill = area / (r.width * r.height);
  if (area > imgArea * 0.0008 && area < imgArea * 0.04 && ar > 0.6 && ar < 1.7 && fill > 0.62)
    st.push({ cx: r.x + r.width / 2, cy: r.y + r.height / 2, side: (r.width + r.height) / 2, rect: r });
  c.delete();
}
console.log(`${FILE} work ${W}x${H}: vivid square stickers = ${st.length}`);

// cluster by proximity AND size similarity
function cluster(items) {
  const n = items.length; if (!n) return [];
  const sides = items.map(s => s.side).sort((a, b) => a - b); const med = sides[n >> 1];
  const par = items.map((_, i) => i); const find = x => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const a = items[i], b = items[j]; const big = Math.max(a.side, b.side);
    const sizeOk = Math.min(a.side, b.side) / big > 0.55;
    if (sizeOk && Math.hypot(a.cx - b.cx, a.cy - b.cy) < big * 1.8) par[find(i)] = find(j);
  }
  const g = {}; items.forEach((s, i) => { (g[find(i)] = g[find(i)] || []).push(s); });
  return Object.values(g).sort((a, b) => b.length - a.length);
}
const clusters = cluster(st);
console.log("clusters:", clusters.map(c => c.length).join(","));
const best = clusters[0] || [];
let a = 1e9, b = 1e9, c2 = -1e9, d = -1e9;
for (const s of best) { a = Math.min(a, s.rect.x); b = Math.min(b, s.rect.y); c2 = Math.max(c2, s.rect.x + s.rect.width); d = Math.max(d, s.rect.y + s.rect.height); }
const region = { x: a, y: b, w: c2 - a, h: d - b };
console.log(`best cluster ${best.length} stickers, bbox ${region.w | 0}x${region.h | 0} @(${region.x | 0},${region.y | 0})`);

// sample + classify (reuse detector for classify)
const RD = require("../detector.js");
const cw = region.w / 3, ch = region.h / 3;
for (let gy = 0; gy < 3; gy++) { let line = ""; for (let gx = 0; gx < 3; gx++) { const cx = region.x + cw * (gx + 0.5), cy = region.y + ch * (gy + 0.5); const [r, g, bl] = RD.cellColor(src, cx, cy, Math.max(4, cw * 0.28), Math.max(4, ch * 0.28)); line += RD.classifyColor(r, g, bl) + " "; } console.log("  " + line); }

// draw
const out = new Uint8Array(data);
function p(x, y, c) { if (x < 0 || y < 0 || x >= W || y >= H) return; const i = (y * W + x) * 4; out[i] = c[0]; out[i + 1] = c[1]; out[i + 2] = c[2]; out[i + 3] = 255; }
for (const s of st) { const r = s.rect, col = best.includes(s) ? [255, 0, 255] : [120, 120, 255]; for (let t = 0; t < 2; t++) { for (let x = r.x; x < r.x + r.width; x++) { p(x, r.y + t, col); p(x, r.y + r.height - t, col); } for (let y = r.y; y < r.y + r.height; y++) { p(r.x + t, y, col); p(r.x + r.width - t, y, col); } } }
for (let i = 0; i <= 3; i++) { for (let y = region.y | 0; y < region.y + region.h; y++) p((region.x + cw * i) | 0, y, [0, 255, 0]); for (let x = region.x | 0; x < region.x + region.w; x++) p(x, (region.y + ch * i) | 0, [0, 255, 0]); }
fs.writeFileSync(new URL("../detected.jpg", import.meta.url), jpeg.encode({ data: out, width: W, height: H }, 92).data);
