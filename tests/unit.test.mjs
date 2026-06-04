// Pure-JS unit tests for the DOM-free helpers in detector.js. Runs in
// milliseconds — no opencv.js, no images. Catches regressions in
// colour classification and corner ordering, which are the two pieces
// of logic that a 977-line detector refactor is most likely to silently
// break.
//
//   node --test tests/unit.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const RD = require("../detector.js");

test("classifyColor: white, yellow, red, orange, green, blue bucketing", () => {
  // (r, g, b) → expected code; chosen to sit in the middle of each bin
  assert.equal(RD.classifyColor(250, 250, 250), "W");
  assert.equal(RD.classifyColor(255, 220, 30), "Y");   // pure yellow
  assert.equal(RD.classifyColor(220, 30, 30), "R");    // pure red
  assert.equal(RD.classifyColor(255, 130, 30), "O");   // orange
  assert.equal(RD.classifyColor(40, 200, 60), "G");    // green
  assert.equal(RD.classifyColor(30, 80, 220), "B");    // blue
});

test("classifyColor: low-saturation → white bin", () => {
  assert.equal(RD.classifyColor(200, 200, 190), "W"); // near-grey
});

test("classifyColor: very dark → white (matches dark/grey sticker shadows)", () => {
  assert.equal(RD.classifyColor(20, 20, 20), "W");
});

test("orderCorners: 4 arbitrary points → [TL, TR, BR, BL]", () => {
  // give it a non-convex order to make sure it doesn't trust input order
  const pts = [
    { x: 100, y: 0 },    // TR
    { x: 0, y: 0 },      // TL
    { x: 0, y: 100 },    // BL
    { x: 100, y: 100 },  // BR
  ];
  const [tl, tr, br, bl] = RD.orderCorners(pts);
  // TL is top-left: smallest x+y
  assert.deepEqual(tl, { x: 0, y: 0 });
  // BR is bottom-right: largest x+y
  assert.deepEqual(br, { x: 100, y: 100 });
  // TR is top-right: smallest x-y (rightmost, topmost)
  assert.deepEqual(tr, { x: 100, y: 0 });
  // BL is bottom-left: largest x-y (leftmost, bottommost)
  assert.deepEqual(bl, { x: 0, y: 100 });
});

test("orderCorners: rotated quad still sorts correctly", () => {
  // same four points in random order
  const pts = [
    { x: 0, y: 100 },
    { x: 100, y: 100 },
    { x: 100, y: 0 },
    { x: 0, y: 0 },
  ];
  const [tl, tr, br, bl] = RD.orderCorners(pts);
  assert.deepEqual(tl, { x: 0, y: 0 });
  assert.deepEqual(tr, { x: 100, y: 0 });
  assert.deepEqual(br, { x: 100, y: 100 });
  assert.deepEqual(bl, { x: 0, y: 100 });
});

test("COLORS: every key maps to a name + css swatch", () => {
  for (const k of ["W", "Y", "R", "O", "G", "B"]) {
    assert.ok(RD.COLORS[k], `missing COLORS.${k}`);
    assert.ok(RD.COLORS[k].name);
    assert.match(RD.COLORS[k].css, /^#[0-9a-f]{6}$/i);
  }
});

test("WORK_WIDTH: a positive number exported", () => {
  assert.equal(typeof RD.WORK_WIDTH, "number");
  assert.ok(RD.WORK_WIDTH > 0);
});
