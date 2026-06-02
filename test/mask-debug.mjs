// Prototype the final algorithm: green+blue anchors -> cube cluster ->
// face region -> 3x3 sample + classify. Draws region/grid, prints face.
import fs from "node:fs";
import jpeg from "jpeg-js";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const cv = require("../opencv.js");
await new Promise((res) => { cv.onRuntimeInitialized = res; });

const raw = fs.readFileSync(new URL("../sample.jpg", import.meta.url));
const img = jpeg.decode(raw, { useTArray: true });
const W = img.width, H = img.height, imgArea = W * H, data = img.data;

function classify(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) { if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4; h *= 60; if (h < 0) h += 360; }
  const s = mx === 0 ? 0 : d / mx, v = mx / 255;
  if (s < 0.22 && v > 0.5) return "W";
  if (v < 0.15) return "W";
  if (h < 16 || h >= 330) return "R";
  if (h < 45) return "O";
  if (h < 70) return "Y";
  if (h < 175) return "G";
  if (h < 265) return "B";
  return "R";
}
function avg(cx, cy, px, py) {
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = (cy - py) | 0; y < cy + py; y++) for (let x = (cx - px) | 0; x < cx + px; x++) {
    if (x < 0 || y < 0 || x >= W || y >= H) continue;
    const i = (y * W + x) * 4; r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
  }
  return n ? [r / n, g / n, b / n] : [0, 0, 0];
}

const src = cv.matFromImageData({ data, width: W, height: H });
const rgb = new cv.Mat(); cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
const hsv = new cv.Mat(); cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
// Green+blue anchors (hues absent from brick/skin/paper)
const gLow = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [40, 70, 45, 0]);
const gHigh = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [135, 255, 255, 0]);
const mask = new cv.Mat(); cv.inRange(hsv, gLow, gHigh, mask);
cv.morphologyEx(mask, mask, cv.MORPH_OPEN, cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(2, 2)));

const cnts = new cv.MatVector(); const hier = new cv.Mat();
cv.findContours(mask, cnts, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
const anchors = [];
for (let i = 0; i < cnts.size(); i++) {
  const c = cnts.get(i);
  const area = cv.contourArea(c);
  const r = cv.boundingRect(c);
  const ar = r.width / r.height, fill = area / (r.width * r.height);
  if (area > imgArea * 0.0004 && area < imgArea * 0.05 && ar > 0.3 && ar < 3.2 && fill > 0.45) {
    anchors.push({ cx: r.x + r.width / 2, cy: r.y + r.height / 2, side: Math.min(r.width, r.height), r });
  }
  c.delete();
}
console.log(`green+blue anchors: ${anchors.length}`);
anchors.forEach(a => console.log(`  @(${a.cx | 0},${a.cy | 0}) ${a.r.width}x${a.r.height}`));

// Cluster anchors by proximity (union-find)
const med = anchors.map(a => a.side).sort((x, y) => x - y)[anchors.length >> 1] || 20;
const par = anchors.map((_, i) => i);
const find = x => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
for (let i = 0; i < anchors.length; i++) for (let j = i + 1; j < anchors.length; j++) {
  if (Math.hypot(anchors[i].cx - anchors[j].cx, anchors[i].cy - anchors[j].cy) < med * 4) par[find(i)] = find(j);
}
const groups = {};
anchors.forEach((a, i) => { (groups[find(i)] ||= []).push(a); });
const clusters = Object.values(groups).sort((a, b) => b.length - a.length);
console.log(`clusters: ${clusters.map(c => c.length).join(",")}`);
const best = clusters[0] || [];

// Face region from cluster bbox, expanded to a 3x3 grid using sticker side.
let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9, sSum = 0;
for (const a of best) { minX = Math.min(minX, a.r.x); minY = Math.min(minY, a.r.y); maxX = Math.max(maxX, a.r.x + a.r.width); maxY = Math.max(maxY, a.r.y + a.r.height); sSum += a.side; }
// The green+blue stickers tend to span the face; their cluster bbox is a good
// proxy for the face. Pad slightly and square it up.
const pad = 0.10;
let rx = minX - (maxX - minX) * pad, ry = minY - (maxY - minY) * pad;
let rw = (maxX - minX) * (1 + 2 * pad), rh = (maxY - minY) * (1 + 2 * pad);
// square it (cube face is square): use the larger dimension, keep center
const cX = rx + rw / 2, cY = ry + rh / 2, sz = Math.max(rw, rh);
const region = { x: Math.round(cX - sz / 2), y: Math.round(cY - sz / 2), w: Math.round(sz), h: Math.round(sz) };
console.log(`region`, region);

// 3x3 sample
const grid = [];
const cw = region.w / 3, ch = region.h / 3;
for (let gy = 0; gy < 3; gy++) { const row = []; for (let gx = 0; gx < 3; gx++) {
  const cx = region.x + cw * (gx + 0.5), cy = region.y + ch * (gy + 0.5);
  const [R, G, B] = avg(cx, cy, Math.max(3, cw * 0.22), Math.max(3, ch * 0.22));
  row.push(classify(R, G, B)); } grid.push(row); }
console.log("FACE:"); grid.forEach(r => console.log("  " + r.join(" ")));

// Draw
const SW = { W: [240,240,240], Y: [255,213,0], R: [209,26,26], O: [255,122,26], G: [31,170,70], B: [23,95,214] };
const out = new Uint8Array(data);
function line(x0,y0,x1,y1,col){ const dx=Math.abs(x1-x0),dy=Math.abs(y1-y0),sx=x0<x1?1:-1,sy=y0<y1?1:-1; let e=dx-dy,x=x0,y=y0; for(;;){p(x,y,col);if(x===x1&&y===y1)break;const e2=2*e;if(e2>-dy){e-=dy;x+=sx;}if(e2<dx){e+=dx;y+=sy;}} }
function p(x,y,col){ if(x<0||y<0||x>=W||y>=H)return; const i=(y*W+x)*4; out[i]=col[0];out[i+1]=col[1];out[i+2]=col[2];out[i+3]=255; }
for (const a of best) { const r=a.r; for(let t=0;t<2;t++){line(r.x,r.y+t,r.x+r.width,r.y+t,[255,0,255]);line(r.x,r.y+r.height-t,r.x+r.width,r.y+r.height-t,[255,0,255]);} }
for (let i=0;i<=3;i++){ line(region.x+cw*i|0,region.y,region.x+cw*i|0,region.y+region.h,[0,255,0]); line(region.x,region.y+ch*i|0,region.x+region.w,region.y+ch*i|0,[0,255,0]); }
fs.writeFileSync(new URL("../detected.jpg", import.meta.url), jpeg.encode({ data: out, width: W, height: H }, 92).data);
console.log("wrote detected.jpg");
