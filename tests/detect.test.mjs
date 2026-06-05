// Node-only test: runs detectCube on a sample image and asserts a valid
// 3×3 face. No browser, no Puppeteer, no ONNX — fast and headless-safe.
//
//   node --test tests/detect.test.mjs
//   IMG=userimg.jpg node --test tests/detect.test.mjs
//   IMG=algorithms.png node --test tests/detect.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const cv = require("../opencv.js");
await new Promise((r) => { cv.onRuntimeInitialized = r; });
const RD = require("../detector.js");

const FILE = process.env.IMG || "sample.jpg";
const path = new URL("../" + FILE, import.meta.url);
if (!fs.existsSync(path)) {
  test(`detect: ${FILE} not found — skipping`, { skip: true }, () => {});
} else {
  // Decode the image into an RGBA Uint8Array regardless of format.
  // jpeg-js handles .jpg/.jpeg; pngjs handles .png. opencv.js takes RGBA
  // directly, so we never convert to a different colorspace here.
  const raw = fs.readFileSync(path);
  const lower = FILE.toLowerCase();
  let data, width, height;
  if (lower.endsWith(".png")) {
    const p = await new Promise((res, rej) => new PNG().parse(raw, (e, x) => (e ? rej(e) : res(x))));
    data = p.data; width = p.width; height = p.height;
  } else {
    const j = jpeg.decode(raw, { useTArray: true });
    data = j.data; width = j.width; height = j.height;
  }
  const src = cv.matFromImageData({ data, width, height });

  const result = RD.detectCube(cv, src);
  src.delete();

  test("detect: returns a face object", () => {
    assert.ok(result.face, "result.face missing");
    assert.equal(typeof result.method, "string");
  });

  test("detect: face has 9 cells", () => {
    assert.equal(result.face.cells.length, 9, `got ${result.face.cells.length}`);
  });

  test("detect: every cell has a valid colour code", () => {
    for (const c of result.face.cells) {
      assert.match(c.code, /^[WYROGB]$/, `bad code: ${c.code}`);
      assert.ok(Array.isArray(c.rgb) && c.rgb.length === 3);
    }
  });

  test("detect: stickerCount is a non-negative integer", () => {
    assert.equal(typeof result.stickerCount, "number");
    assert.ok(result.stickerCount >= 0);
  });

  test("detect: squareCount is a non-negative integer", () => {
    assert.equal(typeof result.squareCount, "number");
    assert.ok(result.squareCount >= 0);
  });
}
