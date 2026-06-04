// Node-only test: runs detectCube on a sample image and asserts a valid
// 3×3 face. No browser, no Puppeteer, no ONNX — fast and headless-safe.
//
//   node --test tests/detect.test.mjs
//   IMG=userimg.jpg node --test tests/detect.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import jpeg from "jpeg-js";
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
  const img = jpeg.decode(fs.readFileSync(path), { useTArray: true });
  const src = cv.matFromImageData({ data: img.data, width: img.width, height: img.height });

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
