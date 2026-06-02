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

console.log(`${FILE} @${W}x${H}  work=${result.workSize.w}x${result.workSize.h}  method=${result.method}  squares=${result.squareCount}  faceStickers=${result.stickerCount}`);
console.log(`region ${result.region.w | 0}x${result.region.h | 0} @(${result.region.x | 0},${result.region.y | 0})`);
for (let i = 0; i < 9; i += 3) console.log("  " + result.face.cells.slice(i, i + 3).map((c) => c.code).join(" "));

// draw overlay on the full-res image
const out = new Uint8Array(img.data);
function p(x, y, c) { if (x < 0 || y < 0 || x >= W || y >= H) return; const i = (y * W + x) * 4; out[i] = c[0]; out[i + 1] = c[1]; out[i + 2] = c[2]; out[i + 3] = 255; }
function box(r, c) { for (let t = 0; t < 3; t++) { for (let x = r.x | 0; x < r.x + r.width; x++) { p(x, (r.y + t) | 0, c); p(x, (r.y + r.height - t) | 0, c); } for (let y = r.y | 0; y < r.y + r.height; y++) { p((r.x + t) | 0, y, c); p((r.x + r.width - t) | 0, y, c); } } }
for (const a of result.cluster) box(a.rect, [255, 0, 255]);
const rg = result.region, cw = rg.w / 3, ch = rg.h / 3;
for (let i = 0; i <= 3; i++) { for (let y = rg.y | 0; y < rg.y + rg.h; y++) p((rg.x + cw * i) | 0, y, [0, 255, 0]); for (let x = rg.x | 0; x < rg.x + rg.w; x++) p(x, (rg.y + ch * i) | 0, [0, 255, 0]); }
fs.writeFileSync(new URL("../detected.jpg", import.meta.url), jpeg.encode({ data: out, width: W, height: H }, 92).data);
console.log("wrote detected.jpg");
